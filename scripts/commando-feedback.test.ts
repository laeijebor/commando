import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./commando-feedback', import.meta.url))
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** A stand-in daemon that answers every feedback poll with `status` and `body`, recording the URLs it saw. */
async function daemon(status: number, body: string) {
  const urls: string[] = []
  const server = createServer((request, response) => {
    urls.push(request.url ?? '')
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, urls }
}

/** A temporary agent home: the hook token and the cursor directory the script keeps between polls. */
async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-feedback-script-'))
  directories.push(directory)
  await writeFile(join(directory, 'token'), 'test-token')
  return directory
}

function run(shell: string, port: number, directory: string) {
  const env = {
    ...process.env,
    COMMANDO_PORT: String(port),
    COMMANDO_AGENT_HOOK_TOKEN_PATH: join(directory, 'token'),
    COMMANDO_FEEDBACK_CURSOR_DIR: join(directory, 'cursors'),
  }
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(shell, [script, 'w-test', '--wait', '1'], { env }, (error, stdout) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout })
    })
  })
}

describe('commando-feedback', () => {
  // A note's comment holds JSON escapes such as \n. macOS /bin/sh is bash with xpg_echo on, so `echo "$body"` turned
  // them into raw newlines and the printed body was no longer valid JSON. Agents run the script either way.
  const body = JSON.stringify({ ok: true, cursor: 7, notes: [{ id: 7, comment: 'Needs changes\n\nNote: see "notes" \\ here' }] })

  it.each(['bash', 'sh'])('prints the daemon body unchanged when run with %s', async (shell) => {
    const { port } = await daemon(200, body)
    const directory = await home()
    const result = await run(shell, port, directory)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(body))
    expect(await readFile(join(directory, 'cursors', 'w-test'), 'utf8')).toBe('7')
  })

  it('acknowledges the previous cursor on the next poll', async () => {
    const { port, urls } = await daemon(200, body)
    const directory = await home()
    await run('bash', port, directory)
    await run('bash', port, directory)
    expect(urls[0]).not.toContain('cursor=')
    expect(urls[1]).toContain('cursor=7')
  })

  it('exits 4 and forgets the cursor once the tile is gone', async () => {
    const directory = await home()
    const ok = await daemon(200, body)
    await run('sh', ok.port, directory)
    const gone = await daemon(404, JSON.stringify({ ok: false }))
    const result = await run('sh', gone.port, directory)
    expect(result.code).toBe(4)
    await expect(readFile(join(directory, 'cursors', 'w-test'), 'utf8')).rejects.toThrow()
  })
})

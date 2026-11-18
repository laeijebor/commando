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
  return scripted([{ status, body }])
}

/** A stand-in daemon that walks through `replies` in order, repeating the last one. */
async function scripted(replies: { status: number; body: string }[]) {
  const urls: string[] = []
  const server = createServer((request, response) => {
    urls.push(request.url ?? '')
    const reply = replies[Math.min(urls.length, replies.length) - 1]!
    response.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(reply.body)
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

/** `shell` is the interpreter plus its flags, e.g. ['bash'] or ['bash', '-O', 'xpg_echo']. */
function run(shell: string[], port: number, directory: string, flags: string[] = [], extraEnv: Record<string, string> = {}) {
  const env = {
    ...process.env,
    COMMANDO_PORT: String(port),
    COMMANDO_AGENT_HOOK_TOKEN_PATH: join(directory, 'token'),
    COMMANDO_FEEDBACK_CURSOR_DIR: join(directory, 'cursors'),
    ...extraEnv,
  }
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(shell[0]!, [...shell.slice(1), script, 'w-test', '--wait', '1', ...flags], { env }, (error, stdout) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout })
    })
  })
}

describe('commando-feedback', () => {
  // A note's comment holds JSON escapes such as \n. macOS /bin/sh is bash with xpg_echo on, so running the script with
  // `sh` made `echo "$body"` turn them into raw newlines and the printed body was no longer valid JSON. `bash -O
  // xpg_echo` reproduces that on any platform (Linux /bin/sh is often dash, which can't run the script at all).
  const body = JSON.stringify({ ok: true, cursor: 7, notes: [{ id: 7, comment: 'Needs changes\n\nNote: see "notes" \\ here' }] })

  it.each([
    { name: 'bash', shell: ['bash'] },
    { name: 'bash with xpg_echo (macOS sh)', shell: ['bash', '-O', 'xpg_echo'] },
  ])('prints the daemon body unchanged under $name', async ({ shell }) => {
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
    await run(['bash'], port, directory)
    await run(['bash'], port, directory)
    expect(urls[0]).not.toContain('cursor=')
    expect(urls[1]).toContain('cursor=7')
  })

  it('exits 4 and forgets the cursor once the tile is gone', async () => {
    const directory = await home()
    const ok = await daemon(200, body)
    await run(['bash'], ok.port, directory)
    const gone = await daemon(404, JSON.stringify({ ok: false }))
    const result = await run(['bash'], gone.port, directory)
    expect(result.code).toBe(4)
    await expect(readFile(join(directory, 'cursors', 'w-test'), 'utf8')).rejects.toThrow()
  })

  describe('--until-notes', () => {
    const empty = (cursor: number) => ({ status: 200, body: JSON.stringify({ ok: true, webPaneId: 'w-test', cursor, notes: [] }) })
    // Note text that mentions the empty-list shape must not read as a heartbeat: it arrives JSON-escaped.
    const notes = JSON.stringify({ ok: true, webPaneId: 'w-test', cursor: 9, notes: [{ id: 9, comment: 'Line one\nsee "notes":[] here' }] })

    it('polls through empty heartbeats and exits with the first batch of notes', async () => {
      const { port, urls } = await scripted([empty(3), empty(3), { status: 200, body: notes }])
      const directory = await home()
      const result = await run(['bash', '-O', 'xpg_echo'], port, directory, ['--until-notes'])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(JSON.parse(notes))
      expect(urls).toHaveLength(3)
      expect(urls[0]).not.toContain('cursor=')
      expect(urls[1]).toContain('cursor=3')
      expect(await readFile(join(directory, 'cursors', 'w-test'), 'utf8')).toBe('9')
    })

    it('keeps watching through a daemon error, then delivers', async () => {
      const { port, urls } = await scripted([{ status: 503, body: '{}' }, { status: 200, body: notes }])
      const directory = await home()
      const result = await run(['bash'], port, directory, ['--until-notes'], { COMMANDO_FEEDBACK_RETRY_SLEEP: '0' })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(JSON.parse(notes))
      expect(urls).toHaveLength(2)
    })

    it('exits 4 when the tile is gone', async () => {
      const { port } = await scripted([empty(1), { status: 404, body: JSON.stringify({ ok: false }) }])
      const directory = await home()
      const result = await run(['bash'], port, directory, ['--until-notes'])
      expect(result.code).toBe(4)
    })

    it('gives up after repeated failures so the agent hears about it', async () => {
      const { port, urls } = await scripted([{ status: 500, body: '{}' }])
      const directory = await home()
      const result = await run(['bash'], port, directory, ['--until-notes'], { COMMANDO_FEEDBACK_RETRY_SLEEP: '0', COMMANDO_FEEDBACK_MAX_FAILURES: '3' })
      expect(result.code).toBe(1)
      expect(urls).toHaveLength(3)
    })
  })
})

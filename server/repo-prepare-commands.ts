import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export function defaultRepoPrepareCommandsPath(port = 4310): string {
  return process.env.COMMANDO_REPO_PREPARE_COMMANDS_PATH ?? join(homedir(), '.commando', `repo-prepare-commands-${port}.json`)
}

function rootKey(root: unknown): string {
  if (typeof root !== 'string' || !isAbsolute(root) || /[\u0000-\u001f\u007f-\u009f]/u.test(root)) throw new Error('root must be an absolute repository root')
  return resolve(root)
}

function validCommand(command: unknown): string {
  if (typeof command !== 'string' || Buffer.byteLength(command) > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(command)) throw new Error('command must be at most 8192 bytes without unsupported control characters')
  return command
}

export class RepoPrepareCommands {
  private writes: Promise<void> = Promise.resolve()
  constructor(readonly path = defaultRepoPrepareCommandsPath()) {}

  private async read(): Promise<Map<string, string>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map()
      return new Map(Object.entries(value).flatMap(([root, command]) => {
        try { return [[rootKey(root), validCommand(command)] as const] } catch { return [] }
      }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return new Map()
      throw error
    }
  }

  async get(root: string): Promise<string> {
    const key = rootKey(root)
    await this.writes
    return (await this.read()).get(key) ?? ''
  }

  set(root: string, command: string): Promise<void> {
    const key = rootKey(root), value = validCommand(command)
    const write = this.writes.then(async () => {
      const commands = await this.read()
      if (value === '') commands.delete(key)
      else commands.set(key, value)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(Object.fromEntries(commands))}\n`, { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.path)
      } finally { await rm(temporary, { force: true }) }
    })
    this.writes = write.catch(() => {})
    return write
  }
}

/** Mounted behind the daemon's owner gate. */
export async function handleRepoPrepareCommands(request: IncomingMessage, response: ServerResponse, url: URL, store: RepoPrepareCommands): Promise<boolean> {
  if (url.pathname !== '/api/repo-prepare-commands') return false
  let status = 200, result: unknown
  try {
    if (request.method === 'GET') result = { command: await store.get(rootKey(url.searchParams.get('root'))) }
    else if (request.method === 'PUT') {
      if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') throw new Error('Content-Type must be application/json')
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk)
        length += buffer.length
        if (length > 64 * 1024) throw new Error('Request body is too large')
        chunks.push(buffer)
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { root?: unknown; command?: unknown } | null
      const root = rootKey(value?.root), command = validCommand(value?.command)
      await store.set(root, command)
      result = { command }
    } else { status = 405; result = { error: 'Method not allowed' }; response.setHeader('Allow', 'GET, PUT') }
  } catch (error) { status = 400; result = { error: error instanceof Error ? error.message : 'Unable to save prepare command' } }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(result))
  return true
}

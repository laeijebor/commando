import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { request } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { SessionIde } from '../shared/protocol.js'
import { importIdeProfile } from './ide-profile.js'

export type IdeRuntime = { socketPath: string; stop(): Promise<void> }
export type IdeLaunchOptions = {
  workspacePath: string
  dataDirectory: string
  legacyDataDirectory?: string
  signal: AbortSignal
  onExit: () => void
}
type IdeEntry = {
  public: SessionIde
  secret: string
  abort: AbortController
  task?: Promise<void>
  runtime?: IdeRuntime
}

async function codeServerBinary(): Promise<string> {
  if (process.env.COMMANDO_CODE_SERVER_PATH) return process.env.COMMANDO_CODE_SERVER_PATH
  for (const path of ['/opt/homebrew/bin/code-server', '/usr/local/bin/code-server']) {
    try { await access(path, constants.X_OK); return path } catch { /* Try PATH next. */ }
  }
  return 'code-server'
}

function health(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/healthz', timeout: 500 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
    req.end()
  })
}

/** Private Unix socket: no unauthenticated code-server TCP listener is exposed. */
export async function launchCodeServer(options: IdeLaunchOptions): Promise<IdeRuntime> {
  const binary = await codeServerBinary()
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 })
  await importIdeProfile(options.dataDirectory, options.legacyDataDirectory)
  const settingsDirectory = join(options.dataDirectory, 'user-data', 'User')
  await mkdir(settingsDirectory, { recursive: true })
  // Seed only new profiles; users retain control of their editor preferences.
  try {
    await writeFile(join(settingsDirectory, 'settings.json'), JSON.stringify({
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.startupEditor': 'none',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'chat.disableAIFeatures': true,
      'git.openRepositoryInParentFolders': 'never',
      'telemetry.telemetryLevel': 'off',
    }, null, 2), { flag: 'wx' })
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const socketDirectory = await mkdtemp(join(tmpdir(), 'ci-'))
  const socketPath = join(socketDirectory, 's.sock')
  const child = spawn(binary, [
    '--socket', socketPath, '--socket-mode', '0600', '--auth', 'none',
    '--config', join(options.dataDirectory, 'config.yaml'),
    '--user-data-dir', join(options.dataDirectory, 'user-data'),
    '--extensions-dir', join(options.dataDirectory, 'extensions'),
    '--disable-telemetry', '--disable-update-check', '--disable-proxy',
    options.workspacePath,
  ], { cwd: options.dataDirectory, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let ended = false
  let failure: Error | undefined
  // Consume pipes to avoid backpressure; never expose process output or environment secrets.
  child.stdout?.resume()
  child.stderr?.resume()
  const exited = new Promise<void>((resolve) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      failure = new Error(error.code === 'ENOENT'
        ? 'code-server is not installed. Install it (brew install code-server) or set COMMANDO_CODE_SERVER_PATH, then retry.'
        : `Unable to launch code-server: ${error.message}`)
      ended = true
      resolve()
    })
    child.once('exit', () => { ended = true; options.onExit(); resolve() })
  })
  const kill = (signal: NodeJS.Signals) => {
    if (ended || !child.pid) return
    try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
  }
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    kill('SIGTERM')
    const timer = setTimeout(() => kill('SIGKILL'), 3_000)
    timer.unref()
    await exited
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
    await rm(socketDirectory, { recursive: true, force: true })
  })()
  const abort = () => { void stop() }
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (options.signal.aborted) throw new Error('IDE startup cancelled')
      if (ended) throw failure ?? new Error('code-server exited during startup. Check the installed binary and workspace access.')
      if (await health(socketPath)) return { socketPath, stop }
      await delay(100)
    }
    throw new Error('code-server did not become ready within 30 seconds. Retry or check COMMANDO_CODE_SERVER_PATH.')
  } catch (error) { await stop(); throw error }
}

export class SessionIdeService {
  private readonly entries = new Map<string, IdeEntry>()
  private readonly sessions = new Map<string, IdeEntry>()
  private closed = false
  private stoppingBackend: Promise<void> = Promise.resolve()
  // One writer for preferences and extension installs, multiple folder workbenches.
  private backend?: {
    abort: AbortController
    task: Promise<IdeRuntime>
    owners: Set<IdeEntry>
  }

  constructor(private readonly options: {
    dataDirectory?: string
    legacyDataDirectory?: string
    launch?: (options: IdeLaunchOptions) => Promise<IdeRuntime>
    onChange?: () => void
  } = {}) {}

  private async acquireBackend(entry: IdeEntry): Promise<IdeRuntime> {
    if (entry.abort.signal.aborted) throw new Error('IDE startup cancelled')
    let backend = this.backend
    if (!backend) {
      const abort = new AbortController()
      const owners = new Set<IdeEntry>([entry])
      const key = createHash('sha256').update(entry.public.workspacePath).digest('hex').slice(0, 24)
      const root = this.options.dataDirectory ?? join(homedir(), '.commando', 'ides')
      const stopped = this.stoppingBackend
      const next = {
        abort, owners,
        task: stopped.then(() => (this.options.launch ?? launchCodeServer)({
          workspacePath: entry.public.workspacePath,
          dataDirectory: join(root, 'base'),
          legacyDataDirectory: join(this.options.legacyDataDirectory ?? root, key),
          signal: abort.signal,
          onExit: () => {
            if (this.backend !== next || abort.signal.aborted) return
            this.backend = undefined
            for (const owner of owners) {
              owner.public.state = 'failed'
              owner.public.error = 'code-server stopped unexpectedly. Reopen the IDE to retry.'
            }
            this.options.onChange?.()
          },
        })),
      }
      this.backend = backend = next
      // A failed launch can be retried without retaining a rejected backend.
      void next.task.catch(() => { if (this.backend === next) this.backend = undefined })
    } else {
      backend.owners.add(entry)
    }
    const owned = backend
    let releasing: Promise<void> | undefined
    const release = (): Promise<void> => releasing ??= (async () => {
      if (!owned.owners.delete(entry) || owned.owners.size) return
      if (this.backend === owned) this.backend = undefined
      owned.abort.abort()
      this.stoppingBackend = owned.task.then((runtime) => runtime.stop(), () => undefined)
      await this.stoppingBackend
    })()
    const abort = () => { void release() }
    entry.abort.signal.addEventListener('abort', abort, { once: true })
    try {
      const runtime = await owned.task
      return { socketPath: runtime.socketPath, stop: async () => {
        entry.abort.signal.removeEventListener('abort', abort)
        await release()
      } }
    } catch (error) {
      entry.abort.signal.removeEventListener('abort', abort)
      await release()
      throw error
    }
  }

  list(): SessionIde[] {
    return [...this.entries.values()].map(({ public: ide }) => ({ ...ide, sessionIds: [...ide.sessionIds] }))
  }

  get(id: string): SessionIde | undefined { return this.list().find((ide) => ide.id === id) }
  forSession(sessionId: string): SessionIde | undefined {
    const id = this.sessions.get(sessionId)?.public.id
    return id ? this.get(id) : undefined
  }
  socketPath(id: string): string | undefined {
    const entry = this.entries.get(id)
    return entry?.public.state === 'ready' ? entry.runtime?.socketPath : undefined
  }
  cookie(id: string, secure: boolean): string {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('IDE no longer attached')
    return `commando-ide=${entry.secret}; Path=/ide/${id}/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  }
  authorized(id: string, cookie: string | undefined): boolean {
    const entry = this.entries.get(id)
    const candidate = cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('commando-ide='))?.slice(13)
    if (!entry || !candidate) return false
    const actual = Buffer.from(candidate)
    const expected = Buffer.from(entry.secret)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  async attach(sessionId: string, workspacePath: string): Promise<SessionIde> {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      const canonicalPath = await realpath(workspacePath)
      if (!(await stat(canonicalPath)).isDirectory()) throw new Error('IDE workspace must be a directory')
      if (this.closed) throw new Error('IDE service is shutting down')
      // Recheck after filesystem awaits: concurrent opens of a session must converge.
      entry = this.sessions.get(sessionId) ?? [...this.entries.values()].find((value) => value.public.workspacePath === canonicalPath)
      if (!entry) {
        const id = `ide-${randomBytes(8).toString('hex')}`
        entry = {
          public: { id, sessionIds: [], workspacePath: canonicalPath, state: 'starting', generation: 0, url: `/ide/${id}/?folder=${encodeURIComponent(canonicalPath)}` },
          secret: randomBytes(32).toString('hex'), abort: new AbortController(),
        }
        this.entries.set(id, entry)
      }
      this.sessions.set(sessionId, entry)
      if (!entry.public.sessionIds.includes(sessionId)) entry.public.sessionIds.push(sessionId)
      this.options.onChange?.()
    }
    if (this.closed) throw new Error('IDE service is shutting down')
    if (!entry.task && entry.public.state !== 'ready') {
      const current = entry
      current.abort = new AbortController()
      current.public.state = 'starting'
      current.public.error = undefined
      current.public.generation += 1
      this.options.onChange?.()
      current.task = (async () => {
        try {
          await current.runtime?.stop()
          current.runtime = undefined
          const runtime = await this.acquireBackend(current)
          if (current.abort.signal.aborted) { await runtime.stop(); throw new Error('IDE startup cancelled') }
          current.runtime = runtime
          current.public.state = 'ready'
        } catch (error) {
          current.public.state = 'failed'
          current.public.error = error instanceof Error ? error.message : 'Unable to start IDE'
          throw error
        } finally {
          current.task = undefined
          this.options.onChange?.()
        }
      })()
    }
    await entry.task
    if (this.sessions.get(sessionId) !== entry) throw new Error('IDE was detached during startup')
    return this.get(entry.public.id)!
  }

  async detach(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.sessions.delete(sessionId)
    entry.public.sessionIds = entry.public.sessionIds.filter((id) => id !== sessionId)
    if (!entry.public.sessionIds.length) {
      this.entries.delete(entry.public.id)
      entry.abort.abort()
      await entry.task?.catch(() => undefined)
      await entry.runtime?.stop()
    }
    this.options.onChange?.()
  }

  async retain(sessionIds: Set<string>): Promise<void> {
    await Promise.all([...this.sessions.keys()].filter((id) => !sessionIds.has(id)).map((id) => this.detach(id)))
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.sessions.keys()].map((id) => this.detach(id)))
  }
}

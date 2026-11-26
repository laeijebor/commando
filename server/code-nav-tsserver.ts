/**
 * TypeScript/JavaScript code navigation backed by tsserver, spoken to directly over its stdio protocol.
 *
 * One tsserver per worktree root, started on the first query for that root. A server for a large
 * repository holds hundreds of megabytes, so at most `maxServers` run at once (starting another stops
 * the least recently used), each stops after `idleMs` without a query, and a crashed one is dropped
 * and restarted by the next query. tsserver exits when its stdin closes, so servers die with the daemon.
 */
import { spawn as spawnChild } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import {
  PreciseNavUnavailable,
  type PreciseLocation,
  type PreciseNavProvider,
  type PreciseQuery,
} from './code-nav-provider.js'

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']

const SERVER_FLAGS = [
  '--disableAutomaticTypingAcquisition',
  '--suppressDiagnosticEvents',
  '--noGetErrOnBackgroundUpdate',
  '--useInferredProjectPerProjectRoot',
]

export const STOPPED_MESSAGE = 'TypeScript server stopped'
export const LOADING_MESSAGE = 'TypeScript server is still loading this project'
export const INFERRED_MESSAGE = "No tsconfig.json or jsconfig.json covers this file, so TypeScript can't see every file that uses it"
export const HUNG_MESSAGE = 'TypeScript server stopped responding; it will restart on the next lookup'

/** The parts of a child process the provider uses; `spawn` returns a real one. */
export type TsServerProcess = {
  readonly pid?: number
  readonly stdin: NodeJS.WritableStream
  readonly stdout: NodeJS.ReadableStream
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type TsServerSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => TsServerProcess

export type TypeScriptNavOptions = {
  /** Live servers at once; starting one more stops the least recently used. Default 2. */
  maxServers?: number
  /** Stop a server after this long without a query. Default 10 minutes. */
  idleMs?: number
  /** Timeout for queries until the server has answered once (project loading). Default 20 s. */
  coldTimeoutMs?: number
  /** Timeout for queries after that. Default 8 s. */
  warmTimeoutMs?: number
  /**
   * A request running this long is taken as hung, and the server is replaced when another lookup
   * waits behind it. Well past any project load, so a slow first load still finishes. Default 90 s.
   */
  hungAfterMs?: number
  /** SIGKILL a server this long after SIGTERM if it hasn't exited. Default 2 s. */
  killGraceMs?: number
  spawn?: TsServerSpawner
  /** Path of tsserver.js for a root. Default: the daemon's bundled TypeScript (see resolveTsServer). */
  resolveServer?: (root: string) => string
  readFile?: (path: string) => Promise<string>
}

export type TsServerStats = { root: string; pid: number | undefined; startedAt: number; lastUsedAt: number }

const defaultSpawn: TsServerSpawner = (command, args, { cwd }) =>
  spawnChild(command, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] })

/**
 * The daemon's own TypeScript. Never the project's: running a repository's `tsserver.js` (or the
 * tsconfig plugins it would load from the project) would execute that repository's code on a
 * click, which VS Code only does for trusted workspaces. Navigation works across TS versions.
 */
export function resolveTsServer(): string {
  return createRequire(import.meta.url).resolve('typescript/lib/tsserver.js')
}

export type TsServerMessage = {
  type?: string
  request_seq?: number
  success?: boolean
  message?: string
  body?: unknown
}

/**
 * Splits tsserver's stdout into messages: `Content-Length: N\r\n\r\n` then N bytes of JSON.
 * Works on bytes, so chunk boundaries inside a header or a multi-byte character are fine.
 */
export class TsServerMessageReader {
  private chunks: Buffer[] = []
  private length = 0
  /** Body byte length once the current message's header has been read. */
  private bodyLength: number | undefined

  constructor(private readonly onMessage: (message: TsServerMessage) => void) {}

  push(chunk: Buffer | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.chunks.push(buffer)
    this.length += buffer.length
    for (;;) {
      if (this.bodyLength === undefined) {
        // Headers are short, so joining what's buffered to find their end is cheap.
        const buffered = this.take(this.length)
        const headerEnd = buffered.indexOf('\r\n\r\n')
        if (headerEnd < 0) {
          this.restore(buffered)
          return
        }
        const header = buffered.subarray(0, headerEnd).toString('ascii')
        this.restore(buffered.subarray(headerEnd + 4))
        const match = /content-length:\s*(\d+)/i.exec(header)
        if (!match) continue // Not a message header: skip it.
        this.bodyLength = Number(match[1])
      }
      // A large body arrives in many chunks; join them once, when all are here.
      if (this.length < this.bodyLength) return
      const buffered = this.take(this.length)
      const body = buffered.subarray(0, this.bodyLength).toString('utf8')
      this.restore(buffered.subarray(this.bodyLength))
      this.bodyLength = undefined
      let message: unknown
      try {
        message = JSON.parse(body)
      } catch {
        continue
      }
      if (message && typeof message === 'object') this.onMessage(message as TsServerMessage)
    }
  }

  private take(length: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, length)
    this.chunks = []
    this.length = 0
    return all
  }

  private restore(rest: Buffer): void {
    if (rest.length === 0) return
    this.chunks = [rest]
    this.length = rest.length
  }
}

class TsServerRequestError extends Error {}

type Pending = { resolve: (body: unknown) => void; reject: (error: Error) => void }

/** One tsserver process: request/response correlation by `request_seq`; events are ignored. */
class TsServerConnection {
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private exitedFlag = false
  private stopping = false
  readonly exited: Promise<void>

  constructor(
    private readonly child: TsServerProcess,
    onExit: () => void,
  ) {
    const reader = new TsServerMessageReader((message) => this.receive(message))
    child.stdout.on('data', (chunk: Buffer | string) => reader.push(chunk))
    child.stdin.on('error', () => {}) // EPIPE after a crash; the exit handler reports it.
    this.exited = new Promise((resolveExit) => {
      const exit = () => {
        if (this.exitedFlag) return
        this.exitedFlag = true
        this.rejectAll()
        onExit()
        resolveExit()
      }
      child.on('exit', exit)
      child.on('error', exit) // Failed to spawn.
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  request(command: string, args: unknown): Promise<unknown> {
    if (this.exitedFlag || this.stopping) return Promise.reject(new PreciseNavUnavailable(STOPPED_MESSAGE))
    const seq = ++this.seq
    return new Promise((resolveBody, reject) => {
      this.pending.set(seq, { resolve: resolveBody, reject })
      this.child.stdin.write(`${JSON.stringify({ seq, type: 'request', command, arguments: args })}\n`)
    })
  }

  /** SIGTERM, then SIGKILL after `graceMs` if it hasn't exited. */
  stop(graceMs: number): Promise<void> {
    this.stopping = true
    this.rejectAll()
    if (!this.exitedFlag) {
      try {
        this.child.stdin.end()
      } catch {
        // Already closed.
      }
      this.child.kill('SIGTERM')
      const timer = setTimeout(() => {
        if (!this.exitedFlag) this.child.kill('SIGKILL')
      }, graceMs)
      timer.unref?.()
      void this.exited.then(() => clearTimeout(timer))
    }
    return this.exited
  }

  private receive(message: TsServerMessage): void {
    if (message.type !== 'response' || typeof message.request_seq !== 'number') return
    const pending = this.pending.get(message.request_seq)
    if (!pending) return // A response nobody waits for any more.
    this.pending.delete(message.request_seq)
    if (message.success) pending.resolve(message.body)
    // tsserver reports an empty answer (e.g. no call hierarchy at a position) as a failure.
    else if (message.message === 'No content available.') pending.resolve(undefined)
    else pending.reject(new TsServerRequestError(message.message ?? 'request failed'))
  }

  private rejectAll(): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const { reject } of pending) reject(new PreciseNavUnavailable(STOPPED_MESSAGE))
  }
}

type Server = {
  root: string
  connection: TsServerConnection
  startedAt: number
  lastUsedAt: number
  /** Has completed a query, so the project is loaded. */
  warm: boolean
  /** The one file kept open, so the project stays loaded without the open set growing. */
  openFile: string | undefined
  /** Queries run one at a time: each opens its file and closes the previous one. */
  queue: Promise<void>
  /** When the running query started; a server stuck on one past the cold timeout is replaced. */
  runningSince: number | undefined
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

type Location = { line: number; offset: number }
type FileSpan = { file: string; start: Location; end: Location }
type ReferenceEntry = FileSpan & { lineText?: string }
type CallHierarchyItem = { name: string; file: string; selectionSpan: { start: Location; end: Location } }
type IncomingCall = { from: CallHierarchyItem; fromSpans: { start: Location; end: Location }[] }

function toLocation(file: string, span: { start: Location; end: Location }): PreciseLocation {
  return {
    path: file,
    line: span.start.line,
    character: span.start.offset - 1,
    endLine: span.end.line,
    endCharacter: span.end.offset - 1,
  }
}

export class TypeScriptNavProvider implements PreciseNavProvider {
  readonly name = 'TypeScript'
  private readonly servers = new Map<string, Server>()
  private disposed = false
  private readonly maxServers: number
  private readonly idleMs: number
  private readonly coldTimeoutMs: number
  private readonly warmTimeoutMs: number
  private readonly hungAfterMs: number
  private readonly killGraceMs: number
  private readonly spawn: TsServerSpawner
  private readonly resolveServer: (root: string) => string
  private readonly readFile: (path: string) => Promise<string>

  constructor(options: TypeScriptNavOptions = {}) {
    this.maxServers = Math.max(1, options.maxServers ?? 2)
    this.idleMs = options.idleMs ?? 10 * 60_000
    this.coldTimeoutMs = options.coldTimeoutMs ?? 20_000
    this.warmTimeoutMs = options.warmTimeoutMs ?? 8_000
    this.hungAfterMs = options.hungAfterMs ?? 90_000
    this.killGraceMs = options.killGraceMs ?? 2_000
    this.spawn = options.spawn ?? defaultSpawn
    this.resolveServer = options.resolveServer ?? resolveTsServer
    this.readFile = options.readFile ?? ((path) => readFile(path, 'utf8'))
  }

  handles(relativePath: string): boolean {
    const lower = relativePath.toLowerCase()
    return EXTENSIONS.some((extension) => lower.endsWith(extension))
  }

  async query(query: PreciseQuery): Promise<PreciseLocation[]> {
    if (this.disposed) throw new PreciseNavUnavailable(STOPPED_MESSAGE)
    let server: Server
    try {
      server = this.serverFor(query.root)
    } catch (error) {
      throw new PreciseNavUnavailable(`Could not start the TypeScript server: ${(error as Error).message}`)
    }
    this.touch(server)
    const timeoutMs = server.warm ? this.warmTimeoutMs : this.coldTimeoutMs
    const state = { timedOut: false }
    const issuedAt = Date.now()
    const run = server.queue.then(async () => {
      server.runningSince = Date.now()
      try {
        return await this.run(server, query, state)
      } finally {
        server.runningSince = undefined
      }
    })
    server.queue = run.then(
      () => {},
      () => {},
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        state.timedOut = true
        // A request that never answers would block this server's queue for good. When this lookup
        // waited behind one that was already running before it was asked, and for far longer than
        // any project load, replace the server so the next lookup starts fresh.
        const running = server.runningSince
        if (running !== undefined && running < issuedAt && Date.now() - running >= this.hungAfterMs) {
          void this.stop(server)
          reject(new PreciseNavUnavailable(HUNG_MESSAGE))
          return
        }
        reject(new PreciseNavUnavailable(LOADING_MESSAGE))
      }, timeoutMs)
    })
    try {
      return await Promise.race([run, timeout])
    } catch (error) {
      if (error instanceof PreciseNavUnavailable) throw error
      throw new PreciseNavUnavailable(`TypeScript server error: ${(error as Error).message}`)
    } finally {
      clearTimeout(timer)
      if (this.servers.get(server.root) === server) this.touch(server)
    }
  }

  stats(): TsServerStats[] {
    return [...this.servers.values()].map((server) => ({
      root: server.root,
      pid: server.connection.pid,
      startedAt: server.startedAt,
      lastUsedAt: server.lastUsedAt,
    }))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.servers.values()].map((server) => this.stop(server)))
  }

  private serverFor(root: string): Server {
    const existing = this.servers.get(root)
    if (existing) return existing
    while (this.servers.size >= this.maxServers) {
      const oldest = [...this.servers.values()].reduce((a, b) => (b.lastUsedAt < a.lastUsedAt ? b : a))
      void this.stop(oldest)
    }
    const child = this.spawn(process.execPath, [this.resolveServer(root), ...SERVER_FLAGS], { cwd: root })
    const connection: TsServerConnection = new TsServerConnection(child, () => {
      const current = this.servers.get(root)
      if (current?.connection === connection) this.forget(current)
    })
    const now = Date.now()
    const server: Server = {
      root,
      connection,
      startedAt: now,
      lastUsedAt: now,
      warm: false,
      openFile: undefined,
      queue: Promise.resolve(),
      runningSince: undefined,
      idleTimer: undefined,
    }
    this.servers.set(root, server)
    return server
  }

  private async run(server: Server, query: PreciseQuery, state: { timedOut: boolean }): Promise<PreciseLocation[]> {
    // Don't pile stale requests onto a busy server once the caller has given up.
    const giveUpIfTimedOut = () => {
      if (state.timedOut) throw new PreciseNavUnavailable(LOADING_MESSAGE)
    }
    giveUpIfTimedOut()
    let content: string
    try {
      content = await this.readFile(query.path)
    } catch {
      throw new PreciseNavUnavailable(`Could not read ${query.path}`)
    }
    giveUpIfTimedOut()
    const connection = server.connection
    const closedFiles = server.openFile && server.openFile !== query.path ? [server.openFile] : []
    await connection.request('updateOpen', {
      openFiles: [{ file: query.path, fileContent: content, projectRootPath: query.root }],
      closedFiles,
    })
    server.openFile = query.path
    giveUpIfTimedOut()
    const at = { file: query.path, line: query.line, offset: query.character + 1 }
    if (query.kind !== 'definition') {
      // Without a config file the project is inferred from the open file and what it imports, so
      // files that use the symbol are missing: an incomplete answer would look complete.
      const info = (await connection.request('projectInfo', { file: query.path, needFileNameList: false })) as
        | { configFileName?: string }
        | undefined
      // Configured projects are named by their config file; inferred ones by a pseudo-path such as
      // "/dev/null/inferredProject1*".
      if (!info?.configFileName || !/\.json$/iu.test(info.configFileName)) throw new PreciseNavUnavailable(INFERRED_MESSAGE)
      giveUpIfTimedOut()
    }
    let locations: PreciseLocation[]
    if (query.kind === 'definition') {
      const body = (await connection.request('definition', at)) as FileSpan[] | undefined
      locations = (body ?? []).map((span) => toLocation(span.file, span))
    } else if (query.kind === 'references') {
      const body = (await connection.request('references', at)) as { refs?: ReferenceEntry[] } | undefined
      locations = (body?.refs ?? []).map((ref) => ({ ...toLocation(ref.file, ref), preview: ref.lineText }))
    } else {
      const prepared = (await connection.request('prepareCallHierarchy', at)) as
        | CallHierarchyItem
        | CallHierarchyItem[]
        | undefined
      const items = prepared === undefined ? [] : Array.isArray(prepared) ? prepared : [prepared]
      locations = []
      for (const item of items) {
        giveUpIfTimedOut()
        const calls = (await connection.request('provideCallHierarchyIncomingCalls', {
          file: item.file,
          line: item.selectionSpan.start.line,
          offset: item.selectionSpan.start.offset,
        })) as IncomingCall[] | undefined
        for (const call of calls ?? []) {
          for (const span of call.fromSpans) {
            locations.push({ ...toLocation(call.from.file, span), container: call.from.name })
          }
        }
      }
    }
    // Also when the caller timed out but the answer came in late: the next query will be quick.
    server.warm = true
    return locations
  }

  private touch(server: Server): void {
    server.lastUsedAt = Date.now()
    clearTimeout(server.idleTimer)
    server.idleTimer = setTimeout(() => void this.stop(server), this.idleMs)
    server.idleTimer.unref?.()
  }

  private forget(server: Server): void {
    clearTimeout(server.idleTimer)
    if (this.servers.get(server.root) === server) this.servers.delete(server.root)
  }

  private stop(server: Server): Promise<void> {
    this.forget(server)
    return server.connection.stop(this.killGraceMs)
  }
}

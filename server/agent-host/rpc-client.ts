import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

export type RpcId = string | number
export interface RpcRequest { id: RpcId; method: string; params: unknown }
export interface RpcNotification { method: string; params: unknown }

/** An error reply, with the server's code and data kept for callers that branch on them. */
export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: Record<string, unknown>) { super(message) }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function rpcId(value: unknown): value is RpcId {
  return (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value))
}
export function requestKey(id: RpcId): string { return `${typeof id}:${id}` }

export interface StdioRpcClientOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  executable?: string
  spawn?: () => ChildProcessWithoutNullStreams
  timeoutMs?: number
  killGraceMs?: number
  log?: (message: string) => void
}

export interface StdioRpcServer {
  /** Names the server in errors and logs, e.g. "Codex app-server". */
  label: string
  executable: string
  args: readonly string[]
  initialize: unknown
  /** Stamp every frame with `"jsonrpc": "2.0"`; some servers refuse frames without it. */
  jsonrpc?: boolean
}

export interface StdioRpcTransport<Methods> {
  onNotification(listener: (message: RpcNotification) => void): void
  onRequest(listener: (message: RpcRequest) => boolean): void
  onClose(listener: (error?: Error) => void): void
  start(): Promise<unknown>
  request<M extends keyof Methods & string>(method: M, params: Methods[M]): Promise<unknown>
  respond(id: RpcId, result: unknown): void
  reject(id: RpcId, code: number, message: string): void
  close(): void
}

/** One owned JSON-RPC child over stdio; no shell, shared daemon, or unrelated process cleanup. */
export class StdioRpcClient<Methods> implements StdioRpcTransport<Methods> {
  private child?: ChildProcessWithoutNullStreams
  private lines?: Interface
  private nextId = 0
  private closed = false
  private exited = false
  private notified = false
  private closeError?: Error
  private killTimer?: ReturnType<typeof setTimeout>
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private notifications: ((message: RpcNotification) => void)[] = []
  private requests: ((message: RpcRequest) => boolean)[] = []
  private closes: ((error?: Error) => void)[] = []
  private readonly cleanup = () => this.close()
  private readonly exitCleanup = () => { this.close(); if (!this.exited) this.child?.kill('SIGKILL') }
  constructor(private readonly options: StdioRpcClientOptions, private readonly server: StdioRpcServer) {}
  onNotification(listener: (message: RpcNotification) => void): void { this.notifications.push(listener) }
  onRequest(listener: (message: RpcRequest) => boolean): void { this.requests.push(listener) }
  onClose(listener: (error?: Error) => void): void { this.closes.push(listener) }

  /** Resolves with the server's initialize result. */
  async start(): Promise<unknown> {
    if (this.child || this.closed) throw new Error(`${this.server.label} client already started or closed`)
    this.child = this.options.spawn?.() ?? spawn(this.options.executable ?? this.server.executable, [...this.server.args], { cwd: this.options.cwd, env: this.options.env, stdio: 'pipe' })
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', (line) => this.receive(line))
    // Consume stderr without sending private config/log data to chat clients.
    this.child.stderr.on('data', () => {})
    this.child.stdin.on('error', (error) => this.finish(error))
    this.child.on('error', (error) => { if (!this.child?.pid) this.exited = true; this.finish(error) })
    this.child.once('exit', (code, signal) => {
      this.exited = true
      clearTimeout(this.killTimer)
      this.finish(new Error(`${this.server.label} exited (${signal ?? code ?? 'unknown'})`))
    })
    process.once('exit', this.exitCleanup)
    process.once('SIGINT', this.cleanup)
    process.once('SIGTERM', this.cleanup)
    try {
      const result = await this.send('initialize', this.server.initialize)
      this.write({ method: 'initialized' })
      return result
    } catch (error) {
      this.close()
      throw error
    }
  }

  request<M extends keyof Methods & string>(method: M, params: Methods[M]): Promise<unknown> { return this.send(method, params) }
  private send(method: string, params: unknown): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error(`${this.server.label} is not connected`))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestKey(id))
        reject(new Error(`${this.server.label} ${method} timed out`))
      }, this.options.timeoutMs ?? 60_000)
      this.pending.set(requestKey(id), { resolve, reject, timer })
      try { this.write({ id, method, params }) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestKey(id))
        reject(error)
      }
    })
  }
  respond(id: RpcId, result: unknown): void { this.write({ id, result }) }
  reject(id: RpcId, code: number, message: string): void { this.write({ id, error: { code, message } }) }
  private write(message: Record<string, unknown>): void {
    if (!this.child || this.closed) throw new Error(`${this.server.label} is closed`)
    this.child.stdin.write(`${JSON.stringify(this.server.jsonrpc ? { jsonrpc: '2.0', ...message } : message)}\n`)
  }
  private receive(line: string): void {
    if (this.closed) return
    let message: Record<string, unknown>
    try { message = record(JSON.parse(line)) } catch {
      this.options.log?.(`Ignored malformed ${this.server.label} JSON`)
      return
    }
    if (typeof message.method === 'string') {
      const params = message.params ?? {}
      try {
        if (rpcId(message.id)) {
          const request = { id: message.id, method: message.method, params }
          if (!this.requests.some((listener) => listener(request))) this.reject(message.id, -32601, `Unsupported server request: ${message.method}`)
        } else for (const listener of this.notifications) listener({ method: message.method, params })
      } catch {
        if (rpcId(message.id) && !this.closed) this.reject(message.id, -32602, 'Invalid server request parameters')
        else this.options.log?.(`Ignored invalid ${this.server.label} notification: ${message.method}`)
      }
      return
    }
    if (!rpcId(message.id)) return
    const key = requestKey(message.id)
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)
    clearTimeout(pending.timer)
    if ('error' in message) {
      const error = record(message.error)
      pending.reject(new RpcError(typeof error.message === 'string' ? error.message : `${this.server.label} RPC error`, typeof error.code === 'number' ? error.code : undefined, record(error.data)))
    } else if ('result' in message) pending.resolve(message.result)
    else pending.reject(new Error(`Invalid ${this.server.label} RPC response`))
  }
  private finish(error?: Error): void {
    if (this.closed) { if (this.exited) this.notifyClosed(); return }
    this.closed = true
    this.closeError = error
    this.lines?.close()
    process.removeListener('SIGINT', this.cleanup)
    process.removeListener('SIGTERM', this.cleanup)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error ?? new Error(`${this.server.label} closed`))
    }
    this.pending.clear()
    if (this.child && !this.exited) {
      this.child.kill('SIGTERM')
      this.killTimer = setTimeout(() => { if (!this.exited) this.child?.kill('SIGKILL') }, this.options.killGraceMs ?? 1000)
      this.killTimer.unref()
    }
    if (this.exited || !this.child) this.notifyClosed()
  }
  private notifyClosed(): void {
    if (this.notified) return
    this.notified = true
    process.removeListener('exit', this.exitCleanup)
    for (const listener of this.closes) listener(this.closeError)
  }
  close(): void { this.finish() }
}

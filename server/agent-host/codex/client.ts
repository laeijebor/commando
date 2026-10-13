import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { record, rpcId, requestKey, type ClientMethods, type RpcId, type RpcNotification, type RpcRequest } from './protocol.js'

export interface CodexClientOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  executable?: string
  spawn?: () => ChildProcessWithoutNullStreams
  timeoutMs?: number
  killGraceMs?: number
  log?: (message: string) => void
}
export interface CodexTransport {
  onNotification(listener: (message: RpcNotification) => void): void
  onRequest(listener: (message: RpcRequest) => boolean): void
  onClose(listener: (error?: Error) => void): void
  start(): Promise<void>
  request<M extends keyof ClientMethods>(method: M, params: ClientMethods[M]): Promise<unknown>
  respond(id: RpcId, result: unknown): void
  reject(id: RpcId, code: number, message: string): void
  close(): void
}

/** One owned app-server child; no shell, shared daemon, or unrelated process cleanup. */
export class CodexRpcClient implements CodexTransport {
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
  constructor(private readonly options: CodexClientOptions) {}
  onNotification(listener: (message: RpcNotification) => void): void { this.notifications.push(listener) }
  onRequest(listener: (message: RpcRequest) => boolean): void { this.requests.push(listener) }
  onClose(listener: (error?: Error) => void): void { this.closes.push(listener) }

  async start(): Promise<void> {
    if (this.child || this.closed) throw new Error('Codex client already started or closed')
    this.child = this.options.spawn?.() ?? spawn(this.options.executable ?? 'codex', ['app-server'], { cwd: this.options.cwd, env: this.options.env, stdio: 'pipe' })
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', (line) => this.receive(line))
    // Consume stderr without sending private config/log data to chat clients.
    this.child.stderr.on('data', () => {})
    this.child.stdin.on('error', (error) => this.finish(error))
    this.child.on('error', (error) => { if (!this.child?.pid) this.exited = true; this.finish(error) })
    this.child.once('exit', (code, signal) => {
      this.exited = true
      clearTimeout(this.killTimer)
      this.finish(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'})`))
    })
    process.once('exit', this.exitCleanup)
    process.once('SIGINT', this.cleanup)
    process.once('SIGTERM', this.cleanup)
    try {
      // requestUserInput is experimental in 0.159.3, so this chat opts in.
      await this.request('initialize', { clientInfo: { name: 'commando', title: 'Commando', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } })
      this.write({ method: 'initialized' })
    } catch (error) {
      this.close()
      throw error
    }
  }

  request<M extends keyof ClientMethods>(method: M, params: ClientMethods[M]): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error('Codex app-server is not connected'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestKey(id))
        reject(new Error(`Codex ${method} timed out`))
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
  private write(message: unknown): void {
    if (!this.child || this.closed) throw new Error('Codex app-server is closed')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  private receive(line: string): void {
    if (this.closed) return
    let message: Record<string, unknown>
    try { message = record(JSON.parse(line)) } catch {
      this.options.log?.('Ignored malformed Codex JSON')
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
        else this.options.log?.(`Ignored invalid Codex notification: ${message.method}`)
      }
      return
    }
    if (!rpcId(message.id)) return
    const key = requestKey(message.id)
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)
    clearTimeout(pending.timer)
    if ('error' in message) pending.reject(new Error(typeof record(message.error).message === 'string' ? record(message.error).message as string : 'Codex RPC error'))
    else if ('result' in message) pending.resolve(message.result)
    else pending.reject(new Error('Invalid Codex RPC response'))
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
      pending.reject(error ?? new Error('Codex app-server closed'))
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

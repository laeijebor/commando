import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, RequestOptions } from 'node:http'

class StubSocket extends EventEmitter {
  connecting = true
  remoteAddress?: string
  destroyed = false
  destroy(): this { this.destroyed = true; return this }
}
type Call = { url: URL; options: RequestOptions; body?: string; socket?: StubSocket; lookupAddress?: string; sent: boolean }
export const socketState = {
  calls: [] as Call[], sockets: [] as StubSocket[], pool: new Map<string, StubSocket>(),
  body: Buffer.from('page'), remoteAddress: undefined as string | undefined, alreadyConnected: false,
  response: undefined as ((url: URL) => { status: number; body: Buffer; rawHeaders: string[] }) | undefined,
}
export function resetSocketState(): void {
  socketState.calls = []; socketState.sockets = []; socketState.pool.clear()
  socketState.body = Buffer.from('page'); socketState.remoteAddress = undefined; socketState.alreadyConnected = false; socketState.response = undefined
}

/** No real sockets/DNS. Model an agent retaining an old host socket unless
 * agent:false is supplied, including the skipped lookup on pooled requests. */
export function stubPinnedRequest(url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) {
  const call: Call = { url, options, sent: false }; socketState.calls.push(call)
  let destroyed = false
  const request = new EventEmitter() as EventEmitter & { socket?: StubSocket; end(body?: string): void; destroy(error?: Error): void }
  request.destroy = (error) => {
    if (destroyed) return
    destroyed = true; request.socket?.destroy()
    if (error) queueMicrotask(() => request.emit('error', error))
  }
  const attach = (socket: StubSocket, address?: string) => {
    call.socket = socket; request.socket = socket
    request.emit('socket', socket)
    if (socket.connecting) {
      socket.remoteAddress = socketState.remoteAddress ?? address
      socket.connecting = false; socket.emit('connect')
    }
    if (destroyed || socket.destroyed) return
    call.sent = true
    const data = socketState.response?.(url) ?? { status: 302, body: socketState.body, rawHeaders: ['Location', '/next', 'Connection', 'close'] }
    const response = Readable.from([data.body]) as unknown as IncomingMessage
    response.socket = socket as unknown as IncomingMessage['socket']
    response.statusCode = data.status; response.rawHeaders = data.rawHeaders; response.headers = {}
    for (let i = 0; i < data.rawHeaders.length; i += 2) response.headers[data.rawHeaders[i].toLowerCase()] = data.rawHeaders[i + 1]
    callback(response)
  }
  request.end = (body) => {
    call.body = body
    queueMicrotask(() => {
      const pooled = options.agent !== false ? socketState.pool.get(url.hostname) : undefined
      if (pooled) { attach(pooled); return }
      const lookup = options.lookup as (host: string, options: { all: false }, callback: (error: Error | null, address: string, family: number) => void) => void
      lookup(url.hostname, { all: false }, (error, address) => {
        if (error) { request.destroy(error); return }
        call.lookupAddress = address
        const socket = new StubSocket(); socketState.sockets.push(socket); socketState.pool.set(url.hostname, socket)
        if (socketState.alreadyConnected) { socket.connecting = false; socket.remoteAddress = socketState.remoteAddress ?? address }
        attach(socket, address)
      })
    })
  }
  return request
}

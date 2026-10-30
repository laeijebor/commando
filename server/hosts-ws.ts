import { WebSocket, type RawData } from 'ws'
import { WsBacklog, WS_BACKLOG_HARD_BYTES, WS_BACKLOG_SOFT_BYTES, WS_BACKLOG_STALL_MS, WS_FRAGMENT_BYTES } from './ws-backlog.js'

/** Relay messages with backpressure using public ws APIs. A send callback runs
 * after that message has flushed; queued connect bursts can then drain without
 * dropping a healthy client or buffering an unbounded number of replay frames. */
export class HostWsForwarder {
  private stopped = false
  private paused = false
  private stallBacklog?: WsBacklog
  private stallTimer?: NodeJS.Timeout
  get isPaused(): boolean { return this.paused }

  constructor(private readonly source: WebSocket, private readonly destination: WebSocket) {
    source.on('message', this.message)
    source.once('close', this.stop)
    destination.once('close', this.stop)
  }

  private readonly message = (data: RawData, binary: boolean): void => {
    if (this.stopped || this.destination.readyState !== WebSocket.OPEN) return
    const length = Array.isArray(data) ? data.reduce((total, part) => total + part.length, 0) : data instanceof ArrayBuffer ? data.byteLength : data.length
    if (this.destination.bufferedAmount + length > WS_BACKLOG_HARD_BYTES) {
      this.source.close(1013, 'Proxy backlog safety limit')
      this.destination.close(1013, 'Proxy backlog safety limit')
      return
    }
    const before = this.destination.bufferedAmount
    const sent = (error?: Error): void => {
      if (error) { this.source.terminate(); this.destination.terminate(); return }
      if (!this.stopped && this.paused && this.destination.bufferedAmount <= WS_BACKLOG_SOFT_BYTES / 2) {
        this.paused = false
        this.stopStallWatch()
        this.source.resume()
      }
    }
    if (length <= WS_FRAGMENT_BYTES) this.destination.send(data, { binary }, sent)
    else {
      // Node lowers bufferedAmount only when a whole write completes. Match
      // the daemon's fragments so a large, slow replay shows drain progress.
      const buffer = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data
      for (let offset = 0; offset < buffer.length; offset += WS_FRAGMENT_BYTES) {
        const end = Math.min(offset + WS_FRAGMENT_BYTES, buffer.length)
        this.destination.send(buffer.subarray(offset, end), { binary, fin: end === buffer.length }, sent)
      }
    }
    // Already received messages may still arrive after pause(). Account for
    // their writes so new queued bytes do not hide drain progress.
    this.stallBacklog?.sent(Math.max(0, this.destination.bufferedAmount - before))
    if (!this.paused && this.destination.bufferedAmount > WS_BACKLOG_SOFT_BYTES) {
      this.paused = true
      this.source.pause()
      // Monitor below the usual soft limit too: pause/resume hysteresis keeps
      // reception paused until the queue reaches half that limit.
      this.stallBacklog = new WsBacklog({ softBytes: 0, hardBytes: WS_BACKLOG_HARD_BYTES, stallMs: WS_BACKLOG_STALL_MS })
      this.stallBacklog.check(this.destination.bufferedAmount)
      this.stallTimer = setInterval(() => {
        if (this.stallBacklog?.check(this.destination.bufferedAmount)) {
          this.stop()
          this.source.terminate()
          this.destination.terminate()
        }
      }, 1_000)
      this.stallTimer.unref()
    }
  }

  private stopStallWatch(): void {
    clearInterval(this.stallTimer)
    this.stallTimer = undefined
    this.stallBacklog = undefined
  }

  readonly stop = (): void => {
    if (this.stopped) return
    this.stopped = true
    this.stopStallWatch()
    this.source.off('message', this.message)
    this.source.off('close', this.stop)
    this.destination.off('close', this.stop)
    // A paused receiver must resume to process the peer's closing handshake.
    if (this.paused) { this.paused = false; this.source.resume() }
  }
}

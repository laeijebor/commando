/**
 * Decides when a cockpit socket's outgoing backlog means its client is gone.
 *
 * A single size threshold cannot tell a stuck client from a healthy one that
 * is still downloading a large replay: every new connection is handed the
 * whole state at once (snapshot, briefs, every chat), so a client on WiFi or
 * 4G that is reading as fast as its link allows can sit above any fixed limit
 * for seconds. Closing it then only makes it reconnect and download the same
 * replay again. So above the soft limit the backlog has to stop draining for
 * `stallMs` before the client is dropped; the hard limit still bounds what one
 * slow reader can make the daemon hold.
 */
export const WS_BACKLOG_SOFT_BYTES = 32 * 1024 * 1024
export const WS_BACKLOG_HARD_BYTES = 256 * 1024 * 1024
export const WS_BACKLOG_STALL_MS = 30_000

export type WsBacklogLimits = { softBytes: number; hardBytes: number; stallMs: number }

/** The bytes `ws` queues for one unmasked server frame: its payload plus the header. */
export function wsFrameBytes(payloadBytes: number): number {
  return payloadBytes + (payloadBytes < 126 ? 2 : payloadBytes < 65_536 ? 4 : 10)
}

export class WsBacklog {
  /** Everything queued on the socket so far, in the same units as `bufferedAmount`. */
  private queued = 0
  /** Set while over the soft limit: how much had drained, and since when it has not grown. */
  private stall: { drained: number; since: number } | null = null

  constructor(
    private readonly limits: WsBacklogLimits = { softBytes: WS_BACKLOG_SOFT_BYTES, hardBytes: WS_BACKLOG_HARD_BYTES, stallMs: WS_BACKLOG_STALL_MS },
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Called before each send with the socket's `bufferedAmount`. Returns why
   * the client should be dropped, or null while it is keeping up or draining.
   */
  check(bufferedAmount: number): string | null {
    if (bufferedAmount <= this.limits.softBytes) {
      this.stall = null
      return null
    }
    if (bufferedAmount > this.limits.hardBytes) return 'Client is not consuming output'
    const drained = this.queued - bufferedAmount
    const now = this.now()
    if (!this.stall || drained > this.stall.drained) {
      this.stall = { drained, since: now }
      return null
    }
    return now - this.stall.since >= this.limits.stallMs ? 'Client is not consuming output' : null
  }

  /** Records a frame handed to the socket. */
  sent(payloadBytes: number): void {
    this.queued += wsFrameBytes(payloadBytes)
  }
}

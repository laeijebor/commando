import { describe, expect, it } from 'vitest'
import { WsBacklog, wsFrameBytes } from './ws-backlog.js'

const MB = 1024 * 1024

function backlog() {
  let now = 0
  const tracker = new WsBacklog({ softBytes: 32 * MB, hardBytes: 256 * MB, stallMs: 30_000 }, () => now)
  return { tracker, advance: (ms: number) => { now += ms } }
}

describe('the cockpit socket backlog', () => {
  it('counts frame headers the way ws does', () => {
    expect(wsFrameBytes(10)).toBe(12)
    expect(wsFrameBytes(1_000)).toBe(1_004)
    expect(wsFrameBytes(MB)).toBe(MB + 10)
  })

  it('keeps a client that is still downloading a replay larger than the soft limit', () => {
    // A 36 MB replay, queued in one go: the case that closed every phone with 1013.
    const { tracker, advance } = backlog()
    tracker.sent(36 * MB)
    let buffered = wsFrameBytes(36 * MB)
    for (let second = 0; second < 20; second += 1) {
      expect(tracker.check(buffered)).toBeNull()
      tracker.sent(200)
      buffered += wsFrameBytes(200)
      // A 4G link drains about 2 MB a second.
      advance(1_000)
      buffered = Math.max(0, buffered - 2 * MB)
    }
    expect(buffered).toBeLessThan(32 * MB)
    expect(tracker.check(buffered)).toBeNull()
  })

  it('drops a client whose backlog stops draining for the stall window', () => {
    const { tracker, advance } = backlog()
    tracker.sent(40 * MB)
    const buffered = wsFrameBytes(40 * MB) - 3 * MB
    expect(tracker.check(buffered)).toBeNull()
    advance(29_000)
    expect(tracker.check(buffered)).toBeNull()
    advance(1_000)
    expect(tracker.check(buffered)).toBe('Client is not consuming output')
  })

  it('does not count newly queued frames as progress', () => {
    const { tracker, advance } = backlog()
    tracker.sent(40 * MB)
    let buffered = wsFrameBytes(40 * MB)
    expect(tracker.check(buffered)).toBeNull()
    for (let step = 0; step < 31; step += 1) {
      advance(1_000)
      tracker.sent(1_000)
      buffered += wsFrameBytes(1_000)
      const verdict = tracker.check(buffered)
      if (step < 29) expect(verdict).toBeNull()
      else expect(verdict).toBe('Client is not consuming output')
    }
  })

  it('restarts the stall window once the backlog falls under the soft limit', () => {
    const { tracker, advance } = backlog()
    tracker.sent(40 * MB)
    expect(tracker.check(wsFrameBytes(40 * MB))).toBeNull()
    advance(20_000)
    expect(tracker.check(MB)).toBeNull()
    tracker.sent(40 * MB)
    advance(20_000)
    expect(tracker.check(41 * MB)).toBeNull()
    advance(20_000)
    expect(tracker.check(41 * MB)).toBeNull()
  })

  it('drops any client past the hard limit, draining or not', () => {
    const { tracker } = backlog()
    tracker.sent(300 * MB)
    expect(tracker.check(wsFrameBytes(300 * MB))).toBe('Client is not consuming output')
  })
})

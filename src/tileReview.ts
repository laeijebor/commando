/**
 * Leading-plus-trailing throttle for hover inspects: the first call goes out
 * immediately, calls during the interval collapse to one trailing call with
 * the latest coordinates.
 *
 * (Note queueing lives in the daemon's WebPanePendingStore — the tile only
 * renders the queue it is handed.)
 */
export function createInspectThrottle(
  send: (x: number, y: number) => void,
  minIntervalMs = 50,
): { schedule: (x: number, y: number) => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: { x: number; y: number } | null = null
  const flush = (): void => {
    timer = undefined
    if (!pending) return
    const { x, y } = pending
    pending = null
    send(x, y)
    timer = setTimeout(flush, minIntervalMs)
  }
  return {
    schedule: (x, y) => {
      if (timer) {
        pending = { x, y }
        return
      }
      send(x, y)
      timer = setTimeout(flush, minIntervalMs)
    },
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      pending = null
    },
  }
}

import type { WebPaneFeedbackNote } from '../shared/protocol'
import type { TileInspectSuccess } from '../shared/tile-inspect'

export type QueuedReviewNote = {
  id: number
  selector: string
  tag: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  comment: string
}

export function queueNote(
  list: QueuedReviewNote[],
  inspect: TileInspectSuccess,
  comment: string,
  id: number,
): QueuedReviewNote[] {
  return [
    ...list,
    {
      id,
      selector: inspect.selector,
      tag: inspect.tag,
      ...(inspect.text !== undefined ? { text: inspect.text } : {}),
      rect: inspect.rect,
      comment,
    },
  ]
}

export function removeNote(list: QueuedReviewNote[], id: number): QueuedReviewNote[] {
  return list.filter((note) => note.id !== id)
}

/**
 * Drops exactly the notes a send carried. Clearing the whole queue instead
 * would silently swallow anything queued while the request was in flight.
 */
export function removeSentNotes(
  list: QueuedReviewNote[],
  sent: QueuedReviewNote[],
): QueuedReviewNote[] {
  const sentIds = new Set(sent.map((note) => note.id))
  return list.filter((note) => !sentIds.has(note.id))
}

export function toFeedbackNotes(
  list: QueuedReviewNote[],
  pageUrl: string,
  now: number,
): WebPaneFeedbackNote[] {
  return list.map(({ id: _id, ...note }) => ({ ...note, pageUrl, capturedAt: now }))
}

/**
 * Leading-plus-trailing throttle for hover inspects: the first call goes out
 * immediately, calls during the interval collapse to one trailing call with
 * the latest coordinates.
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

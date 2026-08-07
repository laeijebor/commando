import { MAX_FEEDBACK_NOTES_PER_POST, type WebPaneFeedbackNote } from '../shared/protocol'
import type { RedlinePageResponse } from '../shared/redline-response'
import type { TileInspectSuccess } from '../shared/tile-inspect'

export type QueuedReviewNote = {
  id: number
  selector: string
  tag: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  comment: string
  /** Replace-key for unsent re-answers from the same in-page question. */
  queueKey?: string
  /** Structured answer when the note came from an in-page component. */
  response?: { question: string; answer: string; data?: unknown }
}

export const MAX_QUEUED_PILLS = 50

/**
 * Queues an in-page component answer as a pill note. A queueKey match
 * replaces the unsent previous answer (lavish's replace-not-stack rule);
 * the cap drops the oldest so a misbehaving page cannot grow the queue
 * without bound.
 */
export function queuePageResponse(
  list: QueuedReviewNote[],
  response: RedlinePageResponse,
  id: number,
): QueuedReviewNote[] {
  const kept = response.queueKey === undefined
    ? list
    : list.filter((note) => note.queueKey !== response.queueKey)
  const note: QueuedReviewNote = {
    id,
    selector: response.selector ?? `redline:${response.queueKey ?? response.question.slice(0, 64)}`,
    tag: response.tag ?? 'redline',
    ...(response.text !== undefined ? { text: response.text } : {}),
    rect: response.rect ?? { x: 0, y: 0, width: 0, height: 0 },
    comment: `${response.question}: ${response.answer}`,
    ...(response.queueKey !== undefined ? { queueKey: response.queueKey } : {}),
    response: {
      question: response.question,
      answer: response.answer,
      ...(response.data !== undefined ? { data: response.data } : {}),
    },
  }
  const combined = [...kept, note]
  if (combined.length > MAX_QUEUED_PILLS) {
    console.warn(`redline: queued pill cap (${MAX_QUEUED_PILLS}) reached — dropping the oldest note`)
  }
  return combined.slice(-MAX_QUEUED_PILLS)
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

/**
 * Splits a queue into POST-sized chunks so a send never exceeds the server's
 * MAX_FEEDBACK_NOTES_PER_POST. Chunk order is preserved so a caller sending
 * them in sequence and removing each chunk on success leaves only the
 * genuinely unsent notes queued after a failure partway through.
 */
export function chunkNotes(
  list: QueuedReviewNote[],
  size: number = MAX_FEEDBACK_NOTES_PER_POST,
): QueuedReviewNote[][] {
  const chunks: QueuedReviewNote[][] = []
  for (let index = 0; index < list.length; index += size) {
    chunks.push(list.slice(index, index + size))
  }
  return chunks
}

export function toFeedbackNotes(
  list: QueuedReviewNote[],
  pageUrl: string,
  now: number,
): WebPaneFeedbackNote[] {
  return list.map(({ id: _id, queueKey: _queueKey, ...note }) => ({ ...note, pageUrl, capturedAt: now }))
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

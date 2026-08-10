import { MAX_INSPECT_SELECTOR, MAX_INSPECT_TAG, MAX_INSPECT_TEXT } from './tile-inspect.js'

/** Name of the CDP binding the chromium engine installs in every tile page. */
export const REDLINE_BINDING_NAME = '__commandoRedlineQueue'

export const MAX_RESPONSE_QUESTION = 256
export const MAX_RESPONSE_ANSWER = 1_024
export const MAX_RESPONSE_NOTE = 1_024
export const MAX_RESPONSE_DATA_JSON = 4_096
export const MAX_RESPONSE_QUEUE_KEY = 128
/** Upper bound on the raw binding payload string before JSON.parse. */
export const MAX_RESPONSE_PAYLOAD_BYTES = 16_384

/**
 * A structured answer queued by a redline component inside a tile page.
 * Produced by untrusted page code — parseRedlinePageResponse is the only
 * way one of these enters the daemon.
 */
export type RedlinePageResponse = {
  question: string
  answer: string
  note?: string
  data?: unknown
  queueKey?: string
  selector?: string
  tag?: string
  text?: string
  rect?: { x: number; y: number; width: number; height: number }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validates an untrusted page payload down to the exact forwarded shape.
 * question/answer are load-bearing — reject the payload when they are bad.
 * The presentation extras (selector, tag, text, rect) and data are
 * best-effort: malformed ones are dropped so the answer still gets through.
 */
export function parseRedlinePageResponse(value: unknown): RedlinePageResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!boundedString(record.question, MAX_RESPONSE_QUESTION)) return null
  if (!boundedString(record.answer, MAX_RESPONSE_ANSWER)) return null
  if (record.queueKey !== undefined && !boundedString(record.queueKey, MAX_RESPONSE_QUEUE_KEY)) {
    return null
  }
  const response: RedlinePageResponse = { question: record.question, answer: record.answer }
  if (boundedString(record.note, MAX_RESPONSE_NOTE)) response.note = record.note
  if (record.queueKey !== undefined) response.queueKey = record.queueKey as string
  if (record.data !== undefined) {
    let json: string | undefined
    try {
      json = JSON.stringify(record.data)
    } catch {
      json = undefined
    }
    // data is best-effort: unserializable or oversized data is dropped, not
    // a reason to reject the whole (otherwise valid) answer.
    if (json !== undefined && json.length <= MAX_RESPONSE_DATA_JSON) {
      // Round-trip so the retained value is plain JSON data, not live page objects.
      response.data = JSON.parse(json) as unknown
    }
  }
  if (boundedString(record.selector, MAX_INSPECT_SELECTOR)) response.selector = record.selector
  if (boundedString(record.tag, MAX_INSPECT_TAG)) response.tag = record.tag
  if (boundedString(record.text, MAX_INSPECT_TEXT)) response.text = record.text
  const rect = record.rect as Record<string, unknown> | undefined
  if (
    typeof rect === 'object' && rect !== null &&
    finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height)
  ) {
    response.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
  return response
}

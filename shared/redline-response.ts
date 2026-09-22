import { MAX_INSPECT_SELECTOR, MAX_INSPECT_TAG, MAX_INSPECT_TEXT } from './tile-inspect.js'
import {
  MAX_PENDING_NOTES,
  MAX_WEB_PANE_URL_LENGTH,
  type WebPanePendingSnapshot,
} from './protocol.js'

/** Name of the CDP binding the chromium engine installs in every tile page. */
export const REDLINE_BINDING_NAME = '__commandoRedlineQueue'

export const MAX_RESPONSE_QUESTION = 256
export const MAX_RESPONSE_ANSWER = 1_024
export const MAX_RESPONSE_NOTE = 1_024
export const MAX_RESPONSE_QUEUE_KEY = 128
export const MAX_OPEN_QUESTIONS = 200
export const MAX_QUESTION_OPTIONS = 50
export const MAX_QUESTION_SNAPSHOT_BYTES = 256 * 1_024
// A selected-choice subset can be as large as its bounded question snapshot.
export const MAX_RESPONSE_DATA_JSON = MAX_QUESTION_SNAPSHOT_BYTES + 4_096
/** Upper bound on the raw binding payload string before JSON.parse. */
export const MAX_RESPONSE_PAYLOAD_BYTES = MAX_RESPONSE_DATA_JSON + 16_384
export const MAX_PENDING_SNAPSHOT_BYTES = 512 * 1_024

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

export type RedlinePagePendingSnapshot = {
  version: 1
  controls: Array<{
    queueKey?: string
    selector?: string
    response: { question: string; answer: string; note?: string; data?: unknown }
  }>
}

export type RedlinePageQuestion = {
  question: string
  selector: string
  queueKey?: string
  kind: 'choice' | 'approve' | 'rating' | 'text'
  options?: string[]
  multiple?: boolean
  max?: number
}

export type RedlinePageQuestionSnapshot = {
  type: 'questions'
  version: 1
  questions: RedlinePageQuestion[]
}

export const EMPTY_REDLINE_PAGE_QUESTION_SNAPSHOT: RedlinePageQuestionSnapshot = {
  type: 'questions',
  version: 1,
  questions: [],
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
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
    if (json !== undefined && utf8Bytes(json) <= MAX_RESPONSE_DATA_JSON) {
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

/** Validates the ephemeral inventory of open controls published by a tile page. */
export function parseRedlinePageQuestionSnapshot(value: unknown): RedlinePageQuestionSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.type !== 'questions' || record.version !== 1 || !Array.isArray(record.questions)) {
    return null
  }
  if (record.questions.length > MAX_OPEN_QUESTIONS) return null
  const questions: RedlinePageQuestion[] = []
  const identities = new Set<string>()
  for (const value of record.questions) {
    if (typeof value !== 'object' || value === null) return null
    const question = value as Record<string, unknown>
    if (
      !boundedString(question.question, MAX_RESPONSE_QUESTION) ||
      !boundedString(question.selector, MAX_INSPECT_SELECTOR) ||
      (question.queueKey !== undefined && !boundedString(question.queueKey, MAX_RESPONSE_QUEUE_KEY)) ||
      (question.kind !== 'choice' && question.kind !== 'approve' &&
        question.kind !== 'rating' && question.kind !== 'text')
    ) return null
    const identity = typeof question.queueKey === 'string'
      ? `key:${question.queueKey}`
      : `selector:${question.selector}`
    if (identities.has(identity)) return null
    identities.add(identity)
    const parsed: RedlinePageQuestion = {
      question: question.question,
      selector: question.selector,
      kind: question.kind,
      ...(typeof question.queueKey === 'string' ? { queueKey: question.queueKey } : {}),
    }
    if (question.kind === 'choice' || question.kind === 'approve') {
      if (
        !Array.isArray(question.options) ||
        question.options.length === 0 ||
        question.options.length > MAX_QUESTION_OPTIONS ||
        !question.options.every((option) => boundedString(option, MAX_RESPONSE_ANSWER))
      ) return null
      parsed.options = [...question.options]
      if (question.kind === 'choice') parsed.multiple = question.multiple === true
    }
    if (question.kind === 'rating') {
      if (
        typeof question.max !== 'number' ||
        !Number.isInteger(question.max) ||
        question.max < 2 ||
        question.max > 10
      ) return null
      parsed.max = question.max
    }
    questions.push(parsed)
  }
  return { type: 'questions', version: 1, questions }
}

/** Builds the sanitized pending state visible to one exact page document. */
export function redlinePendingSnapshotForPage(
  snapshot: WebPanePendingSnapshot,
  pageUrl: string,
): RedlinePagePendingSnapshot {
  const controls: RedlinePagePendingSnapshot['controls'] = []
  for (const note of snapshot.notes) {
    if (controls.length >= MAX_PENDING_NOTES || note.pageUrl !== pageUrl) continue
    const response = note.response
    if (
      !response ||
      !boundedString(response.question, MAX_RESPONSE_QUESTION) ||
      !boundedString(response.answer, MAX_RESPONSE_ANSWER) ||
      !boundedString(note.pageUrl, MAX_WEB_PANE_URL_LENGTH)
    ) continue
    const pageResponse: RedlinePagePendingSnapshot['controls'][number]['response'] = {
      question: response.question,
      answer: response.answer,
    }
    if (boundedString(response.note, MAX_RESPONSE_NOTE)) pageResponse.note = response.note
    let data: unknown
    if (response.data !== undefined) {
      try {
        const json = JSON.stringify(response.data)
        if (json !== undefined && utf8Bytes(json) <= MAX_RESPONSE_DATA_JSON) {
          data = JSON.parse(json) as unknown
        }
      } catch {
        // Data is best-effort and must never expose live objects to the page.
      }
    }
    const control: RedlinePagePendingSnapshot['controls'][number] = {
      ...(boundedString(note.queueKey, MAX_RESPONSE_QUEUE_KEY) ? { queueKey: note.queueKey } : {}),
      ...(boundedString(note.selector, MAX_INSPECT_SELECTOR) ? { selector: note.selector } : {}),
      response: data === undefined ? pageResponse : { ...pageResponse, data },
    }
    const withData = { version: 1 as const, controls: [...controls, control] }
    if (utf8Bytes(JSON.stringify(withData)) <= MAX_PENDING_SNAPSHOT_BYTES) {
      controls.push(control)
      continue
    }
    if (data !== undefined) {
      const compact = { ...control, response: pageResponse }
      const withoutData = { version: 1 as const, controls: [...controls, compact] }
      if (utf8Bytes(JSON.stringify(withoutData)) <= MAX_PENDING_SNAPSHOT_BYTES) {
        controls.push(compact)
        continue
      }
    }
    break
  }
  return { version: 1, controls }
}

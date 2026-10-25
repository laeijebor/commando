import type { WebPanePendingNote, WebPanePendingSnapshot, WebPaneSentAnswer } from '@commando/protocol'
import type { CanvasAnnotation } from '@commando/canvas-manifest'
import { encodeCanvasPath } from '@commando/canvas-manifest'
import {
  MAX_RESPONSE_ANSWER,
  MAX_RESPONSE_DATA_JSON,
  MAX_RESPONSE_QUESTION,
  questionShapeOf,
  redlinePageKey,
  sameQuestionShape,
  sentAnswerForQuestion,
  type RedlinePageQuestion,
  type RedlinePageResponse,
} from '@commando/redline-response'

/**
 * Answering page questions natively. Ported from `src/TileReviewLayer.tsx`
 * (responseForQuestion, pendingForQuestion, sentForQuestion, sentAgo) and
 * `src/canvasQuestions.ts`, so an answer queued on the phone is the exact
 * response the desktop would queue for the same question.
 */
export type QuestionDraft = { answer: string; note: string; choices: string[] }

export const EMPTY_DRAFT: QuestionDraft = { answer: '', note: '', choices: [] }

// Mirrors the SDK's stand-in answers (server/static/redline-sdk.js).
const SKIPPED_ANSWER = '(skipped)'
const NOTE_ONLY_ANSWER = '(none — see note)'

function displayAnswerForChoices(choices: readonly string[], fallback: string): string {
  const answer = choices.length > 0 ? choices.join(', ') : fallback.trim()
  return answer.length <= MAX_RESPONSE_ANSWER ? answer : `${answer.slice(0, MAX_RESPONSE_ANSWER - 3)}...`
}

function boundedChoiceData(choice: string | string[], options: readonly string[] | undefined, multiple: boolean): unknown {
  const complete = { choice, ...(options ? { options } : {}), multiple }
  if (new TextEncoder().encode(JSON.stringify(complete)).byteLength <= MAX_RESPONSE_DATA_JSON) return complete
  return { choice, multiple }
}

export function responseForQuestion(question: RedlinePageQuestion, draft: QuestionDraft): RedlinePageResponse {
  const answer = question.kind === 'choice' && question.multiple
    ? displayAnswerForChoices(draft.choices, draft.answer)
    : draft.answer.trim()
  let data: unknown
  if (question.kind === 'choice') {
    const choice = question.multiple ? [...draft.choices] : answer
    data = boundedChoiceData(choice, question.options, question.multiple === true)
  } else if (question.kind === 'approve') {
    data = { verdict: answer }
  } else if (question.kind === 'rating') {
    data = { rating: Number.parseInt(answer, 10), max: question.max }
  }
  return {
    question: question.question,
    answer,
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(question.queueKey ? { queueKey: question.queueKey } : {}),
    selector: question.selector,
    tag: 'redline',
    text: question.question,
    shape: questionShapeOf(question),
  }
}

/** The queued answer for a question on this page, if it still answers this exact question. */
export function pendingForQuestion(
  question: RedlinePageQuestion,
  notes: readonly WebPanePendingNote[],
  pageUrl: string,
): WebPanePendingNote | undefined {
  return notes.find((note) => (
    note.response !== undefined &&
    (note.pageUrl === undefined || redlinePageKey(note.pageUrl) === redlinePageKey(pageUrl)) &&
    (question.queueKey
      ? note.queueKey === question.queueKey
      : note.queueKey === undefined && note.selector === question.selector) &&
    (note.questionShape === undefined || sameQuestionShape(note.questionShape, question))
  ))
}

/** The sent answer still standing for a question on the page being reviewed. */
export function sentForQuestion(
  question: RedlinePageQuestion,
  sent: WebPanePendingSnapshot['sent'],
  pageUrl: string,
): WebPaneSentAnswer | undefined {
  if (!sent || !pageUrl || sent.page !== redlinePageKey(pageUrl)) return undefined
  return sentAnswerForQuestion(question, sent.answers)
}

export function sentAnswerLabel(sent: WebPaneSentAnswer): string {
  if (sent.response.answer === SKIPPED_ANSWER) return 'Skipped'
  if (sent.response.answer === NOTE_ONLY_ANSWER) return sent.response.note ?? 'Note only'
  return sent.response.answer
}

export function sentAgo(sentAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - sentAt) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'Sent · just now'
  if (minutes < 60) return `Sent · ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Sent · ${hours}h ago`
  return `Sent · ${Math.floor(hours / 24)}d ago`
}

/** What a queued answer reads back as, for the card's own controls. */
export function draftFromNote(note: WebPanePendingNote, question: RedlinePageQuestion): QuestionDraft {
  const response = note.response
  if (!response) return EMPTY_DRAFT
  const data = typeof response.data === 'object' && response.data !== null && !Array.isArray(response.data)
    ? response.data as Record<string, unknown>
    : {}
  let choices: string[] = []
  let answer = response.answer
  if (question.kind === 'choice') {
    if (Array.isArray(data.choice)) choices = data.choice.filter((value): value is string => typeof value === 'string')
    else if (typeof data.choice === 'string') choices = [data.choice]
    else choices = (question.options ?? []).filter((option) => option === answer)
    if (choices.length > 0) answer = displayAnswerForChoices(choices, answer)
  } else if (question.kind === 'approve' && typeof data.verdict === 'string') {
    answer = data.verdict
    choices = [answer]
  } else if (question.kind === 'rating') {
    const rating = typeof data.rating === 'number' ? data.rating : Number.parseInt(answer, 10)
    if (Number.isFinite(rating)) choices = [String(rating)]
  }
  return { answer, note: response.note ?? '', choices }
}

/** Picks or toggles one option, returning the draft to queue (or null to clear a multi-choice). */
export function pickOption(question: RedlinePageQuestion, draft: QuestionDraft, option: string): QuestionDraft {
  // The SDK's rating control answers `n/max`; the response data carries the number.
  if (question.kind === 'rating') return { ...draft, answer: `${option}/${question.max ?? 5}`, choices: [option] }
  if (!(question.kind === 'choice' && question.multiple)) return { ...draft, answer: option, choices: [option] }
  const choices = draft.choices.includes(option)
    ? draft.choices.filter((choice) => choice !== option)
    : [...draft.choices, option]
  const ordered = (question.options ?? []).filter((candidate) => choices.includes(candidate))
  return { ...draft, answer: ordered.join(', '), choices: ordered }
}

/** The option buttons a question shows. Text questions have none. */
export function questionOptions(question: RedlinePageQuestion): string[] {
  if (question.kind === 'rating') {
    const max = question.max ?? 5
    return Array.from({ length: max }, (_, index) => String(index + 1))
  }
  return question.options ?? []
}

// --- canvas question notes (mirrors src/canvasQuestions.ts) ---

export const canvasNoteSelector = (id: string): string => `[data-canvas-note="${id}"]`

/** Canvas-level answers belong to the manifest file, apart from any frame page. */
export function canvasQuestionsPage(artifactBase: string, manifest: string): string {
  return new URL(encodeCanvasPath(manifest), artifactBase).toString()
}

/** The redline question a question note asks: a choice when it lists options, else free text. */
export function canvasQuestion(note: CanvasAnnotation): RedlinePageQuestion | null {
  const question = note.text || note.title || note.id
  if (note.kind !== 'question' || question.length > MAX_RESPONSE_QUESTION) return null
  return {
    question,
    kind: note.options ? 'choice' : 'text',
    ...(note.options ? { options: note.options, multiple: note.multiple === true } : {}),
    selector: canvasNoteSelector(note.id),
    queueKey: note.key ?? note.id,
  }
}

/** Every answerable question note, with the answer an agent recorded (which settles it). */
export function canvasQuestions(annotations: readonly CanvasAnnotation[]): Array<{
  note: CanvasAnnotation
  question: RedlinePageQuestion
}> {
  return annotations.flatMap((note) => {
    const question = canvasQuestion(note)
    return question ? [{ note, question }] : []
  })
}

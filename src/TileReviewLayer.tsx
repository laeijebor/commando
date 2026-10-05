import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  MAX_PENDING_NOTES,
  type WebPanePendingNote,
  type WebPanePendingSendIntent,
  type WebPanePendingSnapshot,
  type WebPaneSentAnswer,
} from '../shared/protocol'
import {
  MAX_SELECTOR_RESOLVE_BYTES,
  MAX_SELECTOR_RESOLVE_ITEMS,
  type TileInspectGrade,
  type TileInspectRect,
  type TileInspectResult,
  type TileInspectSuccess,
  type TileSelectorAnchor,
  type TileSelectorResolveItem,
} from '../shared/tile-inspect'
import { loadPendingMirror, savePendingMirror } from './pendingMirror'
import type {
  RedlinePageQuestion,
  RedlinePageQuestionSnapshot,
  RedlinePageResponse,
} from '../shared/redline-response'
import {
  MAX_RESPONSE_ANSWER,
  MAX_RESPONSE_DATA_JSON,
  questionShapeOf,
  redlinePageKey,
  sentAnswerForQuestion,
} from '../shared/redline-response'
import type { PendingQueueApi } from './pendingQueueApi'
import { createInspectThrottle } from './tileReview'

const INSPECT_HINT_MS = 2_000
const REVIEW_CARD_WIDTH = 240
const REVIEW_CARD_HEIGHT = 132
const REVIEW_CARD_GAP = 8
const REVIEW_POPOVER_WIDTH = 280
const REVIEW_POPOVER_HEIGHT = 300
const ANCHOR_REFRESH_MS = 500

export type TileReviewSurface = {
  inspect: (
    x: number,
    y: number,
    grade: TileInspectGrade,
    receive: (result: TileInspectResult) => void,
  ) => void
  resolveSelectors: (
    items: readonly TileSelectorResolveItem[],
    receive: (anchors: readonly TileSelectorAnchor[]) => void,
    reject?: (error: Error) => void,
  ) => void
  subscribePending: (listener: (snapshot: WebPanePendingSnapshot) => void) => () => void
  subscribeQuestions: (
    listener: (pageUrl: string, snapshot: RedlinePageQuestionSnapshot) => void,
  ) => () => void
  revealSelector: (selector: string) => void
  presentHighlights?: (presentation: TileReviewHighlightPresentation) => void
}

export type TileReviewHighlightPresentation = {
  hover: TileInspectRect | null
  queued: Array<{
    rect: TileInspectRect
    kind: 'annotation' | 'response'
    selected: boolean
  }>
}

export type TileReviewLayerProps = {
  webPaneId: string
  pageUrl?: string
  reviewMode: boolean
  active: boolean
  containerRef: RefObject<HTMLElement | null>
  inputRef: RefObject<HTMLElement | null>
  pendingQueue: PendingQueueApi
  surface: TileReviewSurface
}

const EMPTY_SNAPSHOT: WebPanePendingSnapshot = {
  notes: [],
  knownUpTo: Number.POSITIVE_INFINITY,
  dropped: 0,
}

type PendingDraft = {
  answer: string
  note: string
  choices: string[]
  baseAnswer: string
  baseNote: string
  baseChoices: string[]
  baseRevision: number
  dirty: boolean
}

type DraftReconcile = {
  reset?: ReadonlySet<number>
}

type PendingEditor =
  | { kind: 'choice'; options: string[]; multiple: boolean }
  | { kind: 'approve'; options: string[] }
  | { kind: 'rating'; max: number }
  | { kind: 'text' }

type QuestionDraft = { answer: string; note: string; choices: string[] }

/** The daemon rejected a revision we held; our view is behind, not wrong. */
function isStaleRevision(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 409
}

function sameChoices(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((choice, index) => choice === right[index])
}

function displayAnswerForChoices(choices: readonly string[], fallback: string): string {
  const answer = choices.length > 0 ? choices.join(', ') : fallback.trim()
  return answer.length <= MAX_RESPONSE_ANSWER
    ? answer
    : `${answer.slice(0, MAX_RESPONSE_ANSWER - 3)}...`
}

function boundedChoiceData(choice: string | string[], options: readonly string[] | undefined, multiple: boolean): unknown {
  const complete = { choice, ...(options ? { options } : {}), multiple }
  if (new TextEncoder().encode(JSON.stringify(complete)).byteLength <= MAX_RESPONSE_DATA_JSON) return complete
  return { choice, multiple }
}

function choiceResponseData(question: RedlinePageQuestion, choices: readonly string[]): unknown {
  const choice = question.multiple ? [...choices] : choices[0] ?? ''
  return boundedChoiceData(choice, question.options, question.multiple === true)
}

function questionKey(question: RedlinePageQuestion): string {
  return question.queueKey ? `key:${question.queueKey}` : `selector:${question.selector}`
}

function questionDraftKey(question: RedlinePageQuestion): string {
  return `${questionKey(question)}:${JSON.stringify([
    question.kind,
    question.options ?? null,
    question.multiple === true,
    question.max ?? null,
  ])}`
}

function pendingForQuestion(
  question: RedlinePageQuestion,
  notes: readonly WebPanePendingNote[],
  pageUrl: string,
): WebPanePendingNote | undefined {
  return notes.find((note) => (
    note.response !== undefined &&
    (note.pageUrl === undefined || redlinePageKey(note.pageUrl) === redlinePageKey(pageUrl)) &&
    (question.queueKey
      ? note.queueKey === question.queueKey
      : note.queueKey === undefined && note.selector === question.selector)
  ))
}

/** The sent answer still standing for a question on the page being reviewed. */
function sentForQuestion(
  question: RedlinePageQuestion,
  sent: WebPanePendingSnapshot['sent'],
  pageUrl: string,
): WebPaneSentAnswer | undefined {
  if (!sent || !pageUrl || sent.page !== redlinePageKey(pageUrl)) return undefined
  return sentAnswerForQuestion(question, sent.answers)
}

// Mirrors the SDK's stand-in answers (server/static/redline-sdk.js).
const SKIPPED_ANSWER = '(skipped)'
const NOTE_ONLY_ANSWER = '(none — see note)'

function sentAnswerLabel(sent: WebPaneSentAnswer): string {
  if (sent.response.answer === SKIPPED_ANSWER) return 'Skipped'
  if (sent.response.answer === NOTE_ONLY_ANSWER) return sent.response.note ?? 'Note only'
  return sent.response.answer
}

function sentAgo(sentAt: number): string {
  const minutes = Math.floor((Date.now() - sentAt) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'Sent · just now'
  if (minutes < 60) return `Sent · ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Sent · ${hours}h ago`
  return `Sent · ${Math.floor(hours / 24)}d ago`
}

/** Pre-fills the question editor with a sent answer, as Reopen does in the page. */
function draftFromSent(sent: WebPaneSentAnswer): QuestionDraft {
  if (sent.response.answer === SKIPPED_ANSWER) return { answer: '', note: '', choices: [] }
  const values = draftValues({
    id: 0,
    selector: sent.selector ?? '',
    tag: 'redline',
    rect: { x: 0, y: 0, width: 0, height: 0 },
    comment: '',
    response: sent.response,
  })
  return values.answer === NOTE_ONLY_ANSWER ? { ...values, answer: '' } : values
}

function responseForQuestion(question: RedlinePageQuestion, draft: QuestionDraft): RedlinePageResponse {
  const answer = question.kind === 'choice' && question.multiple
    ? displayAnswerForChoices(draft.choices, draft.answer)
    : draft.answer.trim()
  let data: unknown
  if (question.kind === 'choice') {
    data = question.multiple
      ? choiceResponseData(question, draft.choices)
      : choiceResponseData(question, [answer])
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

function responseData(note: WebPanePendingNote): Record<string, unknown> {
  const data = note.response?.data
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
}

function editorFor(note: WebPanePendingNote): PendingEditor {
  const data = responseData(note)
  const options = Array.isArray(data.options) && data.options.every((option) => typeof option === 'string')
    ? data.options
    : undefined
  const selected = Array.isArray(data.choice) && data.choice.every((option) => typeof option === 'string')
    ? data.choice
    : typeof data.choice === 'string' ? [data.choice] : undefined
  if (options || selected) {
    return {
      kind: 'choice',
      options: options ?? selected ?? [],
      multiple: data.multiple === true || Array.isArray(data.choice),
    }
  }
  if (typeof data.verdict === 'string') {
    return { kind: 'approve', options: ['approve', 'reject', 'needs-changes'] }
  }
  if (typeof data.max === 'number' && Number.isInteger(data.max) && data.max >= 2) {
    return { kind: 'rating', max: Math.min(10, data.max) }
  }
  return { kind: 'text' }
}

function editorForQuestion(question: RedlinePageQuestion): PendingEditor {
  if (question.kind === 'choice') {
    return { kind: 'choice', options: question.options ?? [], multiple: question.multiple === true }
  }
  if (question.kind === 'approve') {
    return { kind: 'approve', options: question.options ?? [] }
  }
  if (question.kind === 'rating') return { kind: 'rating', max: question.max ?? 5 }
  return { kind: 'text' }
}

function draftValues(note: WebPanePendingNote): { answer: string; note: string; choices: string[] } {
  if (!note.response) return { answer: note.comment, note: '', choices: [] }
  const data = responseData(note)
  const editor = editorFor(note)
  let answer = note.response.answer
  let choices: string[] = []
  if (editor.kind === 'choice') {
    const choice = data.choice
    if (Array.isArray(choice)) {
      choices = choice.filter((value): value is string => typeof value === 'string')
      if (choices.length > 0) answer = displayAnswerForChoices(choices, answer)
    } else if (typeof choice === 'string') {
      choices = [choice]
      answer = choice
    }
  } else if (editor.kind === 'approve' && typeof data.verdict === 'string') {
    answer = data.verdict
  } else if (editor.kind === 'rating') {
    const rating = typeof data.rating === 'number' ? data.rating : Number.parseInt(answer, 10)
    if (Number.isFinite(rating)) answer = `${rating}/${editor.max}`
  }
  const legacyNote = typeof data.comment === 'string' ? data.comment : ''
  return { answer, note: note.response.note ?? legacyNote, choices }
}

function draftFor(note: WebPanePendingNote): PendingDraft {
  const values = draftValues(note)
  return {
    ...values,
    baseAnswer: values.answer,
    baseNote: values.note,
    baseChoices: [...values.choices],
    baseRevision: note.revision ?? 1,
    dirty: false,
  }
}

function responseForPendingNote(note: WebPanePendingNote, draft: PendingDraft): RedlinePageResponse {
  const current = note.response
  if (!current) throw new Error('Pending note does not contain a response')
  const editor = editorFor(note)
  const currentData = responseData(note)
  let data: unknown = current.data
  if (editor.kind === 'choice') {
    const choice = editor.multiple ? [...draft.choices] : draft.answer
    const options = Array.isArray(currentData.options) ? currentData.options as string[] : undefined
    data = boundedChoiceData(choice, options, editor.multiple)
  } else if (editor.kind === 'approve') {
    data = { ...currentData, verdict: draft.answer }
  } else if (editor.kind === 'rating') {
    data = { ...currentData, rating: Number.parseInt(draft.answer, 10), max: editor.max }
  }
  return {
    question: current.question,
    answer: draft.answer,
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(note.queueKey ? { queueKey: note.queueKey } : {}),
    selector: note.selector,
    tag: note.tag,
    ...(note.text ? { text: note.text } : {}),
    rect: note.rect,
  }
}

function itemLabel(note: WebPanePendingNote): string {
  return note.response ? note.response.question : note.selector
}

function itemType(note: WebPanePendingNote): string {
  return note.response ? 'Response' : 'Annotation'
}

function resolvableSelector(selector: string): boolean {
  return selector.length > 0 && !selector.startsWith('redline:')
}

function PendingEditorFields({
  note,
  draft,
  editor,
  busy,
  onChange,
}: {
  note: WebPanePendingNote
  draft: PendingDraft
  editor: PendingEditor
  busy: boolean
  onChange: (change: Partial<Pick<PendingDraft, 'answer' | 'note' | 'choices'>>) => void
}) {
  return (
    <fieldset className="tile-review-editor" disabled={busy}>
      <legend>{note.response ? 'Answer' : 'Comment'}</legend>
      {editor.kind === 'choice' && editor.multiple ? (
        <div className="tile-review-checks">
          {editor.options.map((option) => {
            const values = draft.choices
            return (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={values.includes(option)}
                  onChange={(event) => {
                    const next = new Set(values)
                    if (event.target.checked) next.add(option)
                    else next.delete(option)
                    const choices = editor.options.filter((value) => next.has(value))
                    onChange({
                      answer: displayAnswerForChoices(choices, ''),
                      choices,
                    })
                  }}
                />
                <span>{option}</span>
              </label>
            )
          })}
        </div>
      ) : editor.kind === 'choice' ? (
        <select
          aria-label="Answer"
          value={draft.answer}
          onChange={(event) => onChange({ answer: event.target.value })}
        >
          {editor.options.map((option) => <option key={option}>{option}</option>)}
        </select>
      ) : editor.kind === 'approve' ? (
        <select
          aria-label="Verdict"
          value={draft.answer}
          onChange={(event) => onChange({ answer: event.target.value })}
        >
          {editor.options.map((option) => <option key={option}>{option}</option>)}
        </select>
      ) : editor.kind === 'rating' ? (
        <div className="tile-review-rating" role="radiogroup" aria-label="Rating">
          {Array.from({ length: editor.max }, (_, index) => index + 1).map((rating) => (
            <label key={rating}>
              <input
                type="radio"
                name={`pending-rating-${note.id}`}
                value={rating}
                checked={draft.answer === `${rating}/${editor.max}`}
                onChange={() => onChange({ answer: `${rating}/${editor.max}` })}
              />
              <span>{rating}</span>
            </label>
          ))}
        </div>
      ) : (
        <textarea
          aria-label={note.response ? 'Answer' : 'Comment'}
          value={draft.answer}
          onChange={(event) => onChange({ answer: event.target.value })}
        />
      )}
      {note.response && (
        <label className="tile-review-note-field">
          <span>Optional note</span>
          <textarea
            aria-label="Optional note"
            value={draft.note}
            onChange={(event) => onChange({ note: event.target.value })}
          />
        </label>
      )}
    </fieldset>
  )
}

function QuestionEditorFields({
  question,
  draft,
  busy,
  onChange,
}: {
  question: RedlinePageQuestion
  draft: QuestionDraft
  busy: boolean
  onChange: (change: Partial<QuestionDraft>) => void
}) {
  const choices = draft.choices
  return (
    <fieldset className="tile-review-editor" disabled={busy}>
      <legend>Answer</legend>
      {question.kind === 'choice' && question.multiple ? (
        <div className="tile-review-checks">
          {question.options?.map((option) => (
            <label key={option}>
              <input
                type="checkbox"
                checked={choices.includes(option)}
                onChange={(event) => {
                  const next = new Set(choices)
                  if (event.target.checked) next.add(option)
                  else next.delete(option)
                  const selected = question.options?.filter((value) => next.has(value)) ?? []
                  onChange({
                    answer: displayAnswerForChoices(selected, ''),
                    choices: selected,
                  })
                }}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      ) : question.kind === 'choice' || question.kind === 'approve' ? (
        <select
          aria-label="Answer"
          value={draft.answer}
          onChange={(event) => onChange({ answer: event.target.value })}
        >
          <option value="">Choose an answer</option>
          {question.options?.map((option) => <option key={option}>{option}</option>)}
        </select>
      ) : question.kind === 'rating' ? (
        <div className="tile-review-rating" role="radiogroup" aria-label="Rating">
          {Array.from({ length: question.max ?? 5 }, (_, index) => index + 1).map((rating) => (
            <label key={rating}>
              <input
                type="radio"
                name={`question-rating-${questionKey(question)}`}
                value={rating}
                checked={draft.answer === `${rating}/${question.max}`}
                onChange={() => onChange({ answer: `${rating}/${question.max}` })}
              />
              <span>{rating}</span>
            </label>
          ))}
        </div>
      ) : (
        <textarea
          aria-label="Answer"
          value={draft.answer}
          onChange={(event) => onChange({ answer: event.target.value })}
        />
      )}
      <label className="tile-review-note-field">
        <span>Optional note</span>
        <textarea
          aria-label="Optional note"
          value={draft.note}
          onChange={(event) => onChange({ note: event.target.value })}
        />
      </label>
    </fieldset>
  )
}

function cardPosition(
  rect: TileInspectRect,
  container: DOMRect | null,
  cardWidth = REVIEW_CARD_WIDTH,
  cardHeight = REVIEW_CARD_HEIGHT,
): { x: number; y: number } {
  const width = container?.width ?? cardWidth
  const height = container?.height ?? cardHeight
  const below = rect.y + rect.height + REVIEW_CARD_GAP
  const y = below + cardHeight <= height
    ? below
    : Math.max(REVIEW_CARD_GAP, rect.y - REVIEW_CARD_GAP - cardHeight)
  return {
    x: Math.max(
      REVIEW_CARD_GAP,
      Math.min(rect.x, Math.max(REVIEW_CARD_GAP, width - cardWidth - REVIEW_CARD_GAP)),
    ),
    y: Math.max(REVIEW_CARD_GAP, Math.min(y, Math.max(REVIEW_CARD_GAP, height - REVIEW_CARD_GAP))),
  }
}

function selectorBatch(notes: readonly WebPanePendingNote[]): TileSelectorResolveItem[] {
  const items: TileSelectorResolveItem[] = []
  for (const note of notes) {
    if (!resolvableSelector(note.selector) || items.length >= MAX_SELECTOR_RESOLVE_ITEMS) continue
    const item = { noteId: note.id, selector: note.selector }
    const candidate = [...items, item]
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_SELECTOR_RESOLVE_BYTES) break
    items.push(item)
  }
  return items
}

export function TileReviewLayer({
  webPaneId,
  pageUrl,
  reviewMode,
  active,
  containerRef,
  inputRef,
  pendingQueue,
  surface,
}: TileReviewLayerProps) {
  const [highlight, setHighlight] = useState<TileInspectRect | null>(null)
  const [card, setCard] = useState<{ inspect: TileInspectSuccess; x: number; y: number } | null>(null)
  const [comment, setComment] = useState('')
  const [queued, setQueued] = useState<WebPanePendingNote[]>([])
  const [dropped, setDropped] = useState(0)
  const [questions, setQuestions] = useState<RedlinePageQuestion[]>([])
  const [questionsPageUrl, setQuestionsPageUrl] = useState(pageUrl ?? '')
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({})
  const [questionFilter, setQuestionFilter] = useState<'all' | 'unanswered'>('all')
  const [sentAnswers, setSentAnswers] = useState<WebPanePendingSnapshot['sent']>()
  /** Question key → the sent answer (by sentAt) the owner chose to change here. */
  const [changingSent, setChangingSent] = useState<Record<string, number>>({})
  const [queueingQuestion, setQueueingQuestion] = useState<string | null>(null)
  const queueingQuestionRef = useRef<string | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selectedQuestionKey, setSelectedQuestionKey] = useState<string | null>(null)
  const [popoverId, setPopoverId] = useState<number | null>(null)
  const [queuedAnchors, setQueuedAnchors] = useState<Record<number, TileInspectRect | null>>({})
  const [drafts, setDrafts] = useState<Record<number, PendingDraft>>({})
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set())
  const busyIdsRef = useRef<ReadonlySet<number>>(new Set())
  const [sendingAllMode, setSendingAllMode] = useState<'send' | WebPanePendingSendIntent | null>(null)
  const sendingAllRef = useRef(false)
  const [queueError, setQueueError] = useState('')
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null)
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null)
  const pendingQueueRef = useRef(pendingQueue)
  pendingQueueRef.current = pendingQueue
  const surfaceRef = useRef(surface)
  surfaceRef.current = surface
  const queuedRef = useRef(queued)
  queuedRef.current = queued
  const questionsRef = useRef(questions)
  questionsRef.current = questions
  const questionsPageUrlRef = useRef(questionsPageUrl)
  questionsPageUrlRef.current = questionsPageUrl
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const selectedQuestionKeyRef = useRef(selectedQuestionKey)
  selectedQuestionKeyRef.current = selectedQuestionKey
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const latestSnapshotRevisionRef = useRef<number | undefined>(undefined)
  /** Ids the owner is removing on purpose — their drafts must not be requeued. */
  const removingIdsRef = useRef(new Set<number>())
  const pushedRef = useRef(false)
  const hoverGeneration = useRef(0)
  const clickGeneration = useRef(0)
  const anchorGeneration = useRef(0)
  const queueToggleRef = useRef<HTMLButtonElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const drawerRef = useRef<HTMLElement | null>(null)
  const drawerDetailRef = useRef<HTMLDivElement | null>(null)
  const drawerWasOpenRef = useRef(false)
  const focusDetailAfterQueueRef = useRef(false)
  const unansweredFilterRef = useRef<HTMLButtonElement | null>(null)
  const previousUnansweredCountRef = useRef(0)

  const hasReviewSummary = questions.length > 0 || queued.length > 0 || dropped > 0
  useEffect(() => {
    const container = containerRef.current
    const strip = stripRef.current
    if (!container || !strip || !hasReviewSummary) return
    container.setAttribute('data-review-summary', '')
    container.toggleAttribute('data-review-drawer-open', drawerOpen)
    const measure = () => {
      const height = Math.ceil(strip.getBoundingClientRect().height)
      container.style.setProperty('--tile-review-strip-height', `${height}px`)
      container.toggleAttribute('data-review-short-tile', container.getBoundingClientRect().height < 360)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(strip)
    observer?.observe(container)
    return () => {
      observer?.disconnect()
      container.removeAttribute('data-review-summary')
      container.removeAttribute('data-review-drawer-open')
      container.removeAttribute('data-review-short-tile')
      container.style.removeProperty('--tile-review-strip-height')
    }
  }, [containerRef, hasReviewSummary, drawerOpen])

  useEffect(() => {
    hoverGeneration.current += 1
    clickGeneration.current += 1
    anchorGeneration.current += 1
    setHighlight(null)
    setCard(null)
    setHint(null)
  }, [pageUrl])

  const applySnapshot = (snapshot: WebPanePendingSnapshot, reconcile: DraftReconcile = {}): boolean => {
    const latestRevision = latestSnapshotRevisionRef.current
    if (
      snapshot.revision !== undefined &&
      latestRevision !== undefined &&
      snapshot.revision < latestRevision
    ) return false
    if (snapshot.revision !== undefined) latestSnapshotRevisionRef.current = snapshot.revision

    const currentDrafts = draftsRef.current
    const nextDrafts: Record<number, PendingDraft> = {}
    for (const note of snapshot.notes) {
      const current = currentDrafts[note.id]
      if (!current || reconcile.reset?.has(note.id)) {
        nextDrafts[note.id] = draftFor(note)
        continue
      }
      const serverDraft = draftFor(note)
      // Text the owner typed is never discarded: a dirty draft rebases onto
      // whatever the daemon now holds (both sides of a "conflict" are the owner).
      nextDrafts[note.id] = current.dirty
        ? {
            ...current,
            baseAnswer: serverDraft.baseAnswer,
            baseNote: serverDraft.baseNote,
            baseChoices: serverDraft.baseChoices,
            baseRevision: serverDraft.baseRevision,
            dirty:
              current.answer !== serverDraft.baseAnswer ||
              current.note !== serverDraft.baseNote ||
              !sameChoices(current.choices, serverDraft.baseChoices),
          }
        : serverDraft
    }
    // A note that vanished (sent or removed from another view) takes its
    // unsaved draft with it unless we put the text back in the queue.
    const previousNotes = queuedRef.current
    const orphans = Object.entries(currentDrafts)
      .map(([id, draft]) => ({ id: Number(id), draft }))
      .filter(({ id, draft }) => (
        draft.dirty && !(id in nextDrafts) && !removingIdsRef.current.has(id)
      ))
    draftsRef.current = nextDrafts
    queuedRef.current = snapshot.notes
    setDrafts(nextDrafts)
    for (const { id, draft } of orphans) {
      const note = previousNotes.find((candidate) => candidate.id === id)
      if (note) void requeueDraft(note, draft)
    }
    setQueued(snapshot.notes)
    setDropped(snapshot.dropped)
    setSentAnswers(snapshot.sent)
    if (snapshot.notes.length === 0 && questionsRef.current.length === 0) setDrawerOpen(false)
    const noteIds = new Set(snapshot.notes.map((note) => note.id))
    setQueuedAnchors((current) => Object.fromEntries(
      Object.entries(current).filter(([noteId]) => noteIds.has(Number(noteId))),
    ))
    setPopoverId((current) => current !== null && noteIds.has(current) ? current : null)
    const attachmentIds = new Set(snapshot.notes.flatMap((note) => (
      note.attachments ?? []
    ).map((attachment) => attachment.id)))
    setPreview((current) => current && attachmentIds.has(current.id) ? current : null)
    setSelectedId((current) => {
      if (selectedQuestionKeyRef.current) return null
      return current !== null && noteIds.has(current) ? current : snapshot.notes[0]?.id ?? null
    })
    return true
  }
  const applySnapshotRef = useRef(applySnapshot)
  applySnapshotRef.current = applySnapshot

  /** Puts a draft whose note disappeared back in the queue as a new note. */
  const requeueDraft = async (note: WebPanePendingNote, draft: PendingDraft) => {
    const queue = pendingQueueRef.current
    const notePageUrl = note.pageUrl ?? pageUrl
    try {
      const snapshot = note.response
        ? queue.addResponse
          ? await queue.addResponse(notePageUrl ?? '', responseForPendingNote(note, draft))
          : undefined
        : await queue.add({
            selector: note.selector,
            tag: note.tag,
            ...(note.text !== undefined ? { text: note.text } : {}),
            rect: note.rect,
            comment: draft.answer,
            ...(notePageUrl ? { pageUrl: notePageUrl } : {}),
          })
      if (snapshot) applySnapshotRef.current(snapshot)
      else setQueueError(`"${itemLabel(note)}" was sent elsewhere; your unsaved edit could not be requeued.`)
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not requeue your unsaved edit')
    }
  }

  useEffect(() => {
    let cancelled = false
    pushedRef.current = false
    latestSnapshotRevisionRef.current = undefined
    setHydrated(false)
    const hydrate = async () => {
      let snapshot: WebPanePendingSnapshot
      try {
        snapshot = await pendingQueueRef.current.list()
        const unknown = loadPendingMirror(webPaneId)
          .filter((note) => note.id > snapshot.knownUpTo)
        for (const note of unknown) {
          const { id: _id, ...draft } = note
          snapshot = await pendingQueueRef.current.add(draft)
        }
      } catch {
        snapshot = EMPTY_SNAPSHOT
      }
      if (cancelled || pushedRef.current) return
      applySnapshotRef.current(snapshot)
      setHydrated(true)
    }
    void hydrate()
    return () => {
      cancelled = true
    }
  }, [webPaneId])

  useEffect(() => surface.subscribePending((snapshot) => {
    pushedRef.current = true
    applySnapshotRef.current(snapshot)
    setHydrated(true)
  }), [surface])

  useEffect(() => surface.subscribeQuestions((nextPageUrl, snapshot) => {
    // A hash or query change is navigation within the page, not a new page.
    const pageChanged = redlinePageKey(questionsPageUrlRef.current) !== redlinePageKey(nextPageUrl)
    questionsPageUrlRef.current = nextPageUrl
    setQuestionsPageUrl(nextPageUrl)
    setQuestions(snapshot.questions)
    const keys = new Set(snapshot.questions.map(questionKey))
    const draftKeys = new Set(snapshot.questions.map(questionDraftKey))
    setQuestionDrafts((current) => pageChanged || snapshot.questions.length === 0 ? {} : Object.fromEntries(
      Object.entries(current).filter(([key]) => draftKeys.has(key)),
    ))
    setSelectedQuestionKey((current) => {
      if (current && keys.has(current)) return current
      if (selectedIdRef.current !== null) return null
      return snapshot.questions[0] ? questionKey(snapshot.questions[0]) : null
    })
    if (snapshot.questions.length === 0 && queuedRef.current.length === 0) setDrawerOpen(false)
  }), [surface])

  useEffect(() => {
    if (!hydrated) return
    savePendingMirror(webPaneId, queued)
  }, [hydrated, queued, webPaneId])

  const refreshAnchors = () => {
    const items = selectorBatch(queuedRef.current)
    if (items.length === 0) {
      anchorGeneration.current += 1
      setQueuedAnchors({})
      return
    }
    const generation = ++anchorGeneration.current
    surfaceRef.current.resolveSelectors(items, (anchors) => {
      if (generation !== anchorGeneration.current) return
      const resolved: Record<number, TileInspectRect | null> = Object.fromEntries(
        items.map((item) => [item.noteId, null]),
      )
      for (const anchor of anchors) {
        if (Object.hasOwn(resolved, anchor.noteId)) resolved[anchor.noteId] = anchor.rect
      }
      setQueuedAnchors(resolved)
      setPopoverId((current) => current !== null && resolved[current] === null ? null : current)
    })
  }

  useEffect(() => {
    if (!reviewMode || !active || queued.length === 0) return
    refreshAnchors()
    const timer = window.setInterval(refreshAnchors, ANCHOR_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [active, queued, reviewMode, surface])

  useEffect(() => {
    const presentation: TileReviewHighlightPresentation = {
      hover: active ? highlight : null,
      queued: active ? queued.flatMap((note) => {
        if (!resolvableSelector(note.selector)) return []
        const rect = queuedAnchors[note.id] === undefined ? note.rect : queuedAnchors[note.id]
        if (!rect || rect.width <= 0 || rect.height <= 0) return []
        return [{
          rect,
          kind: note.response ? 'response' as const : 'annotation' as const,
          selected: popoverId === note.id,
        }]
      }) : [],
    }
    surface.presentHighlights?.(presentation)
  }, [active, highlight, popoverId, queued, queuedAnchors, surface])

  useEffect(() => () => {
    surface.presentHighlights?.({ hover: null, queued: [] })
  }, [surface])

  const hoverThrottle = useRef<ReturnType<typeof createInspectThrottle> | null>(null)
  useEffect(() => {
    if (!reviewMode || !active) {
      clickGeneration.current += 1
      setHighlight(null)
      setCard(null)
      setHint(null)
      setPopoverId(null)
      return
    }
    const throttle = createInspectThrottle((x, y) => {
      const generation = ++hoverGeneration.current
      surfaceRef.current.inspect(x, y, 'hover', (result) => {
        if (generation !== hoverGeneration.current) return
        setHighlight(result.ok && !result.navigation ? result.rect : null)
      })
    })
    hoverThrottle.current = throttle
    return () => {
      hoverGeneration.current += 1
      clickGeneration.current += 1
      throttle.dispose()
      hoverThrottle.current = null
    }
  }, [active, reviewMode, surface])

  useEffect(() => {
    const input = inputRef.current
    if (!reviewMode || !active || !input) return
    const pointFor = (event: PointerEvent) => {
      const rect = input.getBoundingClientRect()
      return {
        x: Math.max(0, Math.round(event.clientX - rect.left)),
        y: Math.max(0, Math.round(event.clientY - rect.top)),
      }
    }
    const inspectClick = (event: PointerEvent) => {
      if (event.button !== 0) return
      const point = pointFor(event)
      const generation = ++clickGeneration.current
      surfaceRef.current.inspect(point.x, point.y, 'click', (result) => {
        if (generation !== clickGeneration.current) return
        if (result.ok && result.navigation) {
          setCard(null)
          setHint(null)
          setHighlight(null)
          return
        }
        if (!result.ok) {
          setCard(null)
          setHint(point)
          return
        }
        setHint(null)
        setComment('')
        setCard({
          inspect: result,
          ...cardPosition(result.rect, containerRef.current?.getBoundingClientRect() ?? null),
        })
      })
    }
    const inspectHover = (event: PointerEvent) => {
      const point = pointFor(event)
      hoverThrottle.current?.schedule(point.x, point.y)
    }
    input.addEventListener('pointerdown', inspectClick)
    input.addEventListener('pointermove', inspectHover)
    return () => {
      input.removeEventListener('pointerdown', inspectClick)
      input.removeEventListener('pointermove', inspectHover)
    }
  }, [active, containerRef, inputRef, reviewMode, surface])

  useEffect(() => {
    if (!hint) return
    const timer = window.setTimeout(() => setHint(null), INSPECT_HINT_MS)
    return () => window.clearTimeout(timer)
  }, [hint])

  useEffect(() => {
    if (!preview) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [preview])

  useEffect(() => {
    if (drawerOpen) {
      drawerWasOpenRef.current = true
      drawerRef.current?.focus()
    } else if (drawerWasOpenRef.current) {
      drawerWasOpenRef.current = false
      queueToggleRef.current?.focus()
    }
  }, [drawerOpen])

  useEffect(() => {
    if (!drawerOpen || preview) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [drawerOpen, preview])

  useEffect(() => {
    if (queueingQuestion !== null || !focusDetailAfterQueueRef.current) return
    focusDetailAfterQueueRef.current = false
    drawerDetailRef.current?.focus()
  }, [queueingQuestion])

  useEffect(() => {
    if (popoverId === null) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopoverId(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [popoverId])

  const mutateQueue = async (mutate: () => Promise<WebPanePendingSnapshot>, failure: string) => {
    try {
      applySnapshot(await mutate())
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : failure)
    }
  }

  const changeDraft = (
    noteId: number,
    change: Partial<Pick<PendingDraft, 'answer' | 'note' | 'choices'>>,
  ) => {
    const serverNote = queuedRef.current.find((note) => note.id === noteId)
    if (!serverNote) return
    const current = draftsRef.current[noteId] ?? draftFor(serverNote)
    const nextDraft = { ...current, ...change }
    nextDraft.dirty =
      nextDraft.answer !== nextDraft.baseAnswer ||
      nextDraft.note !== nextDraft.baseNote ||
      !sameChoices(nextDraft.choices, nextDraft.baseChoices)
    const nextDrafts = { ...draftsRef.current, [noteId]: nextDraft }
    draftsRef.current = nextDrafts
    setDrafts(nextDrafts)
    setQueueError('')
  }

  const markBusy = (noteId: number, busy: boolean) => {
    const next = new Set(busyIdsRef.current)
    if (busy) next.add(noteId)
    else next.delete(noteId)
    busyIdsRef.current = next
    setBusyIds(next)
  }

  /** Pulls the daemon's current queue; dirty drafts rebase onto it. */
  const refreshQueue = async (): Promise<void> => {
    applySnapshot(await pendingQueueRef.current.list())
  }

  /**
   * Saves a dirty draft at the daemon's revision. If the daemon moved on (the
   * page re-answered, another view edited), refresh and retry once with the
   * owner's text on top — it is never thrown away for being out of date.
   */
  const saveDraft = async (noteId: number, retry = true): Promise<boolean> => {
    const draft = draftsRef.current[noteId]
    const serverNote = queuedRef.current.find((note) => note.id === noteId)
    if (!draft || !serverNote || !draft.dirty) return Boolean(serverNote)
    try {
      const currentQuestion = questionsRef.current.find((question) => (
        pendingForQuestion(question, [serverNote], questionsPageUrlRef.current)?.id === noteId
      ))
      const currentEditor = editorFor(serverNote)
      const snapshot = await pendingQueueRef.current.update(
        noteId,
        draft.baseRevision,
        currentQuestion
          ? {
              response: responseForQuestion(currentQuestion, {
                answer: draft.answer,
                note: draft.note,
                choices: draft.choices,
              }),
            }
          : serverNote.response
            ? currentEditor.kind === 'choice' && currentEditor.multiple
              ? { response: responseForPendingNote(serverNote, draft) }
              : { answer: draft.answer, note: draft.note }
            : { answer: draft.answer },
      )
      // A newer snapshot may already have arrived; the save still landed.
      applySnapshot(snapshot, { reset: new Set([noteId]) })
      setQueueError('')
      return true
    } catch (error) {
      if (retry && isStaleRevision(error)) {
        await refreshQueue()
        return saveDraft(noteId, false)
      }
      setQueueError(error instanceof Error ? error.message : 'Could not save changes')
      return false
    }
  }

  const saveOne = async (noteId: number) => {
    if (sendingAllRef.current) return
    markBusy(noteId, true)
    try {
      await saveDraft(noteId)
    } finally {
      markBusy(noteId, false)
    }
  }

  const sendOne = async (noteId: number) => {
    if (sendingAllRef.current) return
    markBusy(noteId, true)
    try {
      if (!(await saveDraft(noteId))) return
      const sendLatest = async () => {
        const latest = queuedRef.current.find((note) => note.id === noteId)
        if (!latest) throw new Error('This item is no longer queued.')
        return pendingQueueRef.current.send([{ id: latest.id, revision: latest.revision ?? 1 }])
      }
      let snapshot: WebPanePendingSnapshot
      try {
        snapshot = await sendLatest()
      } catch (error) {
        if (!isStaleRevision(error)) throw error
        // The daemon's copy moved (e.g. re-picked in the page): send that one.
        await refreshQueue()
        snapshot = await sendLatest()
      }
      applySnapshot(snapshot)
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not send this item')
    } finally {
      markBusy(noteId, false)
    }
  }

  /**
   * Sends the daemon's whole queue — not just the items this view has seen —
   * after saving the owner's dirty drafts on top. A build handoff asserts the
   * queue revision so nothing slips in unseen; if it did, refresh and retry.
   */
  const sendAll = async (intent?: WebPanePendingSendIntent) => {
    if (sendingAllRef.current || busyIdsRef.current.size > 0) return
    if (queuedRef.current.length === 0) return
    sendingAllRef.current = true
    setSendingAllMode(intent ?? 'send')
    setQueueError('')
    try {
      for (const note of [...queuedRef.current]) {
        if (draftsRef.current[note.id]?.dirty && !(await saveDraft(note.id))) return
      }
      let snapshot: WebPanePendingSnapshot | undefined
      for (let attempt = 0; snapshot === undefined; attempt += 1) {
        try {
          if (intent === undefined) {
            snapshot = await pendingQueueRef.current.send()
          } else {
            const expectedQueueRevision = latestSnapshotRevisionRef.current
            if (expectedQueueRevision === undefined) {
              setQueueError('The daemon did not provide a queue revision. Update Commando before sending for build.')
              return
            }
            snapshot = await pendingQueueRef.current.send(undefined, { intent, expectedQueueRevision })
          }
        } catch (error) {
          if (attempt >= 2 || !isStaleRevision(error)) throw error
          await refreshQueue()
        }
      }
      applySnapshot(snapshot)
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not send the queue')
    } finally {
      sendingAllRef.current = false
      setSendingAllMode(null)
    }
  }

  const removeOne = async (noteId: number) => {
    if (sendingAllRef.current) return
    markBusy(noteId, true)
    removingIdsRef.current.add(noteId)
    try {
      applySnapshot(await pendingQueueRef.current.remove(noteId))
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not remove the item')
    } finally {
      removingIdsRef.current.delete(noteId)
      markBusy(noteId, false)
    }
  }

  const changeQuestionDraft = (question: RedlinePageQuestion, change: Partial<QuestionDraft>) => {
    const key = questionDraftKey(question)
    setQuestionDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? { answer: '', note: '', choices: [] }), ...change },
    }))
    setQueueError('')
  }

  const queueQuestionAnswer = async (question: RedlinePageQuestion) => {
    const addResponse = pendingQueueRef.current.addResponse
    const key = questionKey(question)
    const draft = questionDrafts[questionDraftKey(question)] ?? { answer: '', note: '', choices: [] }
    if (
      queueingQuestionRef.current !== null ||
      !addResponse ||
      !questionsPageUrl ||
      !draft.answer.trim()
    ) return
    queueingQuestionRef.current = key
    setQueueingQuestion(key)
    try {
      const accepted = applySnapshot(await addResponse(
        questionsPageUrl,
        responseForQuestion(question, draft),
      ))
      if (accepted && drawerOpen) focusDetailAfterQueueRef.current = true
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not queue the answer')
    } finally {
      if (queueingQuestionRef.current === key) {
        queueingQuestionRef.current = null
        setQueueingQuestion(null)
      }
    }
  }

  const uploadAttachment = async (noteId: number, file: File) => {
    if (sendingAllRef.current) return
    const acceptedTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    if (!acceptedTypes.has(file.type)) {
      setQueueError('Choose a PNG, JPEG, GIF, or WebP image.')
      return
    }
    const note = queuedRef.current.find((candidate) => candidate.id === noteId)
    if (!note) return
    markBusy(noteId, true)
    try {
      applySnapshot(await pendingQueueRef.current.upload(noteId, note.revision ?? 1, file))
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not upload the attachment')
    } finally {
      markBusy(noteId, false)
    }
  }

  const removeAttachment = async (noteId: number, attachmentId: string) => {
    if (sendingAllRef.current) return
    const note = queuedRef.current.find((candidate) => candidate.id === noteId)
    if (!note) return
    markBusy(noteId, true)
    try {
      applySnapshot(await pendingQueueRef.current.removeAttachment(noteId, note.revision ?? 1, attachmentId))
      if (preview?.id === attachmentId) setPreview(null)
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not remove the attachment')
    } finally {
      markBusy(noteId, false)
    }
  }

  const questionItems = questions.map((question) => {
    const pending = pendingForQuestion(question, queued, questionsPageUrl)
    return {
      question,
      key: questionKey(question),
      pending,
      // A queued re-answer shadows what was sent before it.
      sent: pending ? undefined : sentForQuestion(question, sentAnswers, questionsPageUrl),
    }
  })
  const answeredQuestions = questionItems.filter((item) => item.pending !== undefined || item.sent !== undefined)
  const unansweredQuestions = questionItems.filter((item) => item.pending === undefined && item.sent === undefined)
  const visibleQuestions = questionFilter === 'unanswered' ? unansweredQuestions : questionItems
  const matchedResponseIds = new Set(answeredQuestions.map((item) => item.pending?.id))
  const otherQueued = queued.filter((note) => !note.response || !matchedResponseIds.has(note.id))
  const selectedQuestion = selectedQuestionKey === null
    ? undefined
    : questionItems.find((item) => item.key === selectedQuestionKey)
  const selectedQuestionDraft = selectedQuestion
    ? questionDrafts[questionDraftKey(selectedQuestion.question)] ?? { answer: '', note: '', choices: [] }
    : undefined
  const selectedSent = selectedQuestion?.sent &&
    changingSent[selectedQuestion.key] !== selectedQuestion.sent.sentAt
    ? selectedQuestion.sent
    : undefined
  const changeSentAnswer = (question: RedlinePageQuestion, sent: WebPaneSentAnswer) => {
    setQuestionDrafts((current) => ({ ...current, [questionDraftKey(question)]: draftFromSent(sent) }))
    setChangingSent((current) => ({ ...current, [questionKey(question)]: sent.sentAt }))
  }
  const selectedQuestionBusy = queueingQuestion !== null
  const selected = selectedQuestion?.pending ?? (
    selectedId === null ? undefined : queued.find((note) => note.id === selectedId)
  )
  const selectedDraft = selected ? drafts[selected.id] ?? draftFor(selected) : undefined
  const selectedEditor = selected
    ? selectedQuestion ? editorForQuestion(selectedQuestion.question) : editorFor(selected)
    : undefined
  const sendingAll = sendingAllMode !== null
  const selectedBusy = selected ? sendingAll || busyIds.has(selected.id) : false
  const popoverNote = popoverId === null ? undefined : queued.find((note) => note.id === popoverId)
  const popoverDraft = popoverNote ? drafts[popoverNote.id] ?? draftFor(popoverNote) : undefined
  const popoverEditor = popoverNote ? editorFor(popoverNote) : undefined
  const popoverBusy = popoverNote ? sendingAll || busyIds.has(popoverNote.id) : false
  const popoverRect = popoverNote
    ? queuedAnchors[popoverNote.id] === undefined ? popoverNote.rect : queuedAnchors[popoverNote.id]
    : undefined
  const popoverPosition = popoverRect
    ? cardPosition(
        popoverRect,
        containerRef.current?.getBoundingClientRect() ?? null,
        REVIEW_POPOVER_WIDTH,
        REVIEW_POPOVER_HEIGHT,
      )
    : undefined
  useEffect(() => {
    if (questionFilter !== 'unanswered') return
    const unansweredKeys = new Set(unansweredQuestions.map((item) => item.key))
    setSelectedQuestionKey((current) => (
      current && unansweredKeys.has(current) ? current : unansweredQuestions[0]?.key ?? null
    ))
  }, [questionFilter, questions, questionsPageUrl, queued])
  useEffect(() => {
    if (
      questionFilter === 'unanswered' &&
      previousUnansweredCountRef.current > 0 &&
      unansweredQuestions.length === 0
    ) {
      unansweredFilterRef.current?.focus()
    }
    previousUnansweredCountRef.current = unansweredQuestions.length
  }, [questionFilter, unansweredQuestions.length])
  const openDrawer = () => {
    setPopoverId(null)
    if (!selectedQuestionKey && selectedId === null) {
      if (questionItems[0]) setSelectedQuestionKey(questionItems[0].key)
      else setSelectedId(otherQueued[0]?.id ?? null)
    }
    setDrawerOpen(true)
  }

  return (
    <>
      {active && queued.map((note) => {
        if (!resolvableSelector(note.selector)) return null
        const rect = queuedAnchors[note.id] === undefined ? note.rect : queuedAnchors[note.id]
        if (!rect || rect.width <= 0 || rect.height <= 0) return null
        const label = `Edit queued ${itemType(note).toLowerCase()}: ${itemLabel(note)}`
        return (
          <button
            key={note.id}
            type="button"
            className={`tile-review-pending-highlight is-${note.response ? 'response' : 'annotation'}${popoverId === note.id ? ' is-selected' : ''}`}
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
            aria-label={label}
            title={label}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setDrawerOpen(false)
              setSelectedQuestionKey(null)
              setSelectedId(note.id)
              setPopoverId(note.id)
              setQueueError('')
            }}
          />
        )
      })}
      {active && highlight && (
        <div
          className="tile-review-highlight"
          style={{
            left: highlight.x,
            top: highlight.y,
            width: highlight.width,
            height: highlight.height,
          }}
        />
      )}
      {active && hint && (
        <div
          className="tile-review-hint"
          style={{ left: hint.x, top: hint.y }}
          role="status"
          data-native-terminal-occluder=""
        >
          couldn't resolve an element here
        </div>
      )}
      {active && card && (
        <div
          className="tile-review-card"
          style={{ left: card.x, top: card.y }}
          data-native-terminal-occluder=""
        >
          <span className="tile-review-card-target" title={card.inspect.selector}>
            {card.inspect.tag}
          </span>
          <textarea
            autoFocus
            value={comment}
            placeholder="What's wrong with this?"
            aria-label={`Note about ${card.inspect.selector}`}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="web-pane-confirm-actions">
            <button
              type="button"
              className="web-pane-action"
              disabled={comment.trim().length === 0}
              onClick={() => {
                const { selector, tag, text, rect } = card.inspect
                void mutateQueue(
                  () => pendingQueueRef.current.add({
                    selector,
                    tag,
                    ...(text !== undefined ? { text } : {}),
                    rect,
                    comment: comment.trim(),
                    ...(pageUrl ? { pageUrl } : {}),
                  }),
                  'Could not queue the note',
                )
                setCard(null)
                setComment('')
              }}
            >
              Queue note
            </button>
            <button
              type="button"
              className="web-pane-action is-ghost"
              onClick={() => {
                setCard(null)
                setComment('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {active && popoverNote && popoverDraft && popoverEditor && popoverPosition && (
        <section
          className="tile-review-pending-popover"
          role="dialog"
          aria-label={`Edit queued ${itemType(popoverNote).toLowerCase()}`}
          style={{ left: popoverPosition.x, top: popoverPosition.y }}
          data-native-terminal-occluder=""
        >
          <header>
            <div>
              <span className={`tile-review-type is-${popoverNote.response ? 'response' : 'annotation'}`}>
                {itemType(popoverNote)}
              </span>
              <strong>{itemLabel(popoverNote)}</strong>
            </div>
            <button type="button" aria-label="Close queued item editor" onClick={() => setPopoverId(null)}>×</button>
          </header>
          <PendingEditorFields
            note={popoverNote}
            draft={popoverDraft}
            editor={popoverEditor}
            busy={popoverBusy}
            onChange={(change) => changeDraft(popoverNote.id, change)}
          />
          {(popoverNote.attachments?.length ?? 0) > 0 && (
            <span className="tile-review-popover-attachments">
              {popoverNote.attachments?.length} image{popoverNote.attachments?.length === 1 ? '' : 's'} in full queue
            </span>
          )}
          {queueError && <div className="tile-review-popover-error" role="alert">{queueError}</div>}
          <footer>
            <button
              type="button"
              className="web-pane-action is-ghost"
             onClick={() => {
               setPopoverId(null)
               openDrawer()
             }}
            >
              Open full queue
            </button>
            <span />
            <button
              type="button"
              className="web-pane-action is-ghost"
              disabled={!popoverDraft.dirty || popoverBusy || !popoverDraft.answer}
              onClick={() => void saveOne(popoverNote.id)}
            >
              {popoverBusy ? 'Working…' : 'Save'}
            </button>
            <button
              type="button"
              className="web-pane-action"
              disabled={popoverBusy || !popoverDraft.answer}
              onClick={() => void sendOne(popoverNote.id)}
            >
              {popoverBusy ? 'Working…' : 'Send this'}
            </button>
          </footer>
        </section>
      )}
      {hasReviewSummary && (
        <>
          {(
            <div
              ref={stripRef}
              className="tile-review-strip"
              data-testid="pending-queue-strip"
              data-native-terminal-occluder=""
            >
              {dropped > 0 && (
                <span className="tile-review-dropped" role="alert">
                  {`${dropped} older answer${dropped === 1 ? '' : 's'} dropped — the queue is full at ${MAX_PENDING_NOTES}. Send to make room.`}
                  <button
                    type="button"
                    className="tile-review-pill-remove"
                    aria-label="Dismiss the dropped-answer warning"
                    onClick={() => {
                      void mutateQueue(
                        () => pendingQueueRef.current.dismissDropped(),
                        'Could not dismiss the warning',
                      )
                    }}
                  >
                    ×
                  </button>
                </span>
              )}
              {(questions.length > 0 || queued.length > 0) && (
                <button
                  ref={queueToggleRef}
                  type="button"
                  className="tile-review-queue-toggle"
                  aria-expanded={drawerOpen}
                  onClick={() => drawerOpen ? setDrawerOpen(false) : openDrawer()}
                >
                  {questions.length > 0
                    ? `Answer queue · ${questions.length}`
                    : `Review queue · ${queued.length}`}
                </button>
              )}
              <span className="tile-review-summary" role="status">
                {questions.length > 0 ? `${unansweredQuestions.length} unanswered · ` : ''}{queued.length} queued
                {questionItems.some((item) => item.sent) ? ` · ${questionItems.filter((item) => item.sent).length} sent` : ''}
              </span>
              <div className="tile-review-strip-items" aria-hidden="true">
                {(questions.length > 0 ? questionItems : queued).slice(0, 3).map((item) => (
                  <span
                    key={'question' in item ? item.key : item.id}
                    className={`tile-review-chip is-${'question' in item ? 'response' : item.response ? 'response' : 'annotation'}`}
                  >
                    {'question' in item
                      ? item.pending?.response?.answer ?? (item.sent ? sentAnswerLabel(item.sent) : 'Unanswered')
                      : item.response ? item.response.answer : item.comment}
                  </span>
                ))}
                {(questions.length > 0 ? questionItems.length : queued.length) > 3 && (
                  <span className="tile-review-chip">
                    +{(questions.length > 0 ? questionItems.length : queued.length) - 3}
                  </span>
                )}
              </div>
              {queued.length > 0 && (
                <div className="tile-review-strip-actions">
                  <button
                    type="button"
                    className="tile-review-send-all"
                    disabled={sendingAll || busyIds.size > 0}
                    onClick={() => void sendAll()}
                  >
                    {sendingAllMode === 'send' ? 'Saving…' : 'Send all'}
                  </button>
                  <button
                    type="button"
                    className="tile-review-send-all is-build"
                    disabled={sendingAll || busyIds.size > 0}
                    onClick={() => void sendAll('build')}
                  >
                    {sendingAllMode === 'build' ? 'Sending for build…' : 'Send all + Build'}
                  </button>
                </div>
              )}
              {queueError && !drawerOpen && <span className="tile-review-error" role="alert">{queueError}</span>}
            </div>
          )}
          {drawerOpen && (
            <section
              ref={drawerRef}
              className="tile-review-drawer"
              role="dialog"
              aria-label={questions.length > 0 ? 'Answer queue' : 'Pending review queue'}
              tabIndex={-1}
              data-testid="pending-queue-drawer"
              data-native-terminal-occluder=""
            >
              <header className="tile-review-drawer-head">
                <div>
                  <span className="tile-review-eyebrow">
                    {questions.length > 0 ? 'Open questions' : 'Pending review'}
                  </span>
                  <strong>
                    {questions.length > 0
                      ? `Answer queue · ${unansweredQuestions.length} unanswered · ${answeredQuestions.length} answered`
                      : `Review queue · ${queued.length}`}
                  </strong>
                  {questions.length > 0 && (
                    <div className="tile-review-filters" role="group" aria-label="Filter questions">
                      <button
                        type="button"
                        className={questionFilter === 'all' ? 'is-active' : ''}
                        aria-pressed={questionFilter === 'all'}
                        onClick={() => setQuestionFilter('all')}
                      >
                        All
                      </button>
                      <button
                        ref={unansweredFilterRef}
                        type="button"
                        className={questionFilter === 'unanswered' ? 'is-active' : ''}
                        aria-pressed={questionFilter === 'unanswered'}
                        onClick={() => {
                          setQuestionFilter('unanswered')
                          setSelectedId(null)
                          setSelectedQuestionKey(unansweredQuestions[0]?.key ?? null)
                        }}
                      >
                        Unanswered · {unansweredQuestions.length}
                      </button>
                    </div>
                  )}
                </div>
                <div className="tile-review-drawer-actions">
                  <button
                    type="button"
                    className="tile-review-collapse"
                    aria-label="Collapse review queue"
                    onClick={() => setDrawerOpen(false)}
                  >
                    ↓
                  </button>
                </div>
              </header>
              {dropped > 0 && (
                <div className="tile-review-drawer-warning" role="alert">
                  <span>{`${dropped} older answer${dropped === 1 ? '' : 's'} dropped because the queue reached ${MAX_PENDING_NOTES}.`}</span>
                  <button
                    type="button"
                    onClick={() => void mutateQueue(
                      () => pendingQueueRef.current.dismissDropped(),
                      'Could not dismiss the warning',
                    )}
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <div className="tile-review-drawer-body">
                <nav
                  className="tile-review-drawer-list"
                  aria-label={questions.length > 0 ? 'Open questions and queued review items' : 'Queued review items'}
                >
                  {visibleQuestions.map(({ question, key, pending, sent }) => (
                    <button
                      key={key}
                      type="button"
                      className={`tile-review-list-item${key === selectedQuestionKey ? ' is-selected' : ''}`}
                      aria-current={key === selectedQuestionKey ? 'true' : undefined}
                      onClick={() => {
                        setSelectedId(null)
                        setSelectedQuestionKey(key)
                        if (resolvableSelector(question.selector)) {
                          surfaceRef.current.revealSelector(question.selector)
                        }
                      }}
                    >
                      <span className="tile-review-list-meta">
                        <span className={`tile-review-type is-${pending ? 'answered' : sent ? 'sent' : 'unanswered'}`}>
                          {pending ? 'Queued' : sent ? 'Sent' : 'Unanswered'}
                        </span>
                      </span>
                      <strong>{question.question}</strong>
                      <span className="tile-review-list-preview">
                        {pending?.response?.answer ??
                          (sent ? sentAnswerLabel(sent) : 'Click to answer and show in page')}
                      </span>
                    </button>
                  ))}
                  {questionFilter === 'all' && otherQueued.map((note) => {
                    const draft = drafts[note.id] ?? draftFor(note)
                    return (
                      <button
                        key={note.id}
                        type="button"
                        className={`tile-review-list-item${note.id === selectedId ? ' is-selected' : ''}`}
                        aria-current={note.id === selectedId ? 'true' : undefined}
                        onClick={() => {
                          setSelectedQuestionKey(null)
                          setSelectedId(note.id)
                          if (resolvableSelector(note.selector)) {
                            surfaceRef.current.revealSelector(note.selector)
                          }
                        }}
                      >
                        <span className="tile-review-list-meta">
                          <span className={`tile-review-type is-${note.response ? 'response' : 'annotation'}`}>
                            {itemType(note)}
                          </span>
                          {(note.attachments?.length ?? 0) > 0 && (
                            <span>{note.attachments?.length} image{note.attachments?.length === 1 ? '' : 's'}</span>
                          )}
                          {draft.dirty && <span className="tile-review-dirty">Edited</span>}
                        </span>
                        <strong>{itemLabel(note)}</strong>
                        <span className="tile-review-list-preview">{draft.answer}</span>
                      </button>
                    )
                  })}
                  {visibleQuestions.length === 0 && (
                    questionFilter === 'unanswered' || otherQueued.length === 0
                  ) && (
                    <div className="tile-review-list-empty" role="status" aria-live="polite">
                      No unanswered questions.
                    </div>
                  )}
                </nav>
                <div ref={drawerDetailRef} className="tile-review-drawer-detail" tabIndex={-1}>
                  {selectedQuestion && !selectedQuestion.pending && selectedSent ? (
                    <>
                      <div className="tile-review-detail-heading">
                        <span className="tile-review-type is-sent">Sent</span>
                        <h3>{selectedQuestion.question.question}</h3>
                        {resolvableSelector(selectedQuestion.question.selector) && (
                          <button
                            type="button"
                            className="tile-review-show-context"
                            onClick={() => surfaceRef.current.revealSelector(selectedQuestion.question.selector)}
                          >
                            Show in page
                          </button>
                        )}
                      </div>
                      <dl className="tile-review-sent">
                        <dt>Answer</dt>
                        <dd>{sentAnswerLabel(selectedSent)}</dd>
                        {selectedSent.response.note && selectedSent.response.answer !== NOTE_ONLY_ANSWER && (
                          <>
                            <dt>Note</dt>
                            <dd>{selectedSent.response.note}</dd>
                          </>
                        )}
                      </dl>
                      <footer className="tile-review-detail-actions">
                        <span className="tile-review-sent-when">{sentAgo(selectedSent.sentAt)}</span>
                        <span className="tile-review-detail-spacer" />
                        <button
                          type="button"
                          className="web-pane-action"
                          disabled={!pendingQueue.addResponse}
                          onClick={() => changeSentAnswer(selectedQuestion.question, selectedSent)}
                        >
                          Change answer
                        </button>
                      </footer>
                    </>
                  ) : selectedQuestion && !selectedQuestion.pending && selectedQuestionDraft ? (
                    <>
                      <div className="tile-review-detail-heading">
                        <span className={`tile-review-type is-${selectedQuestion.sent ? 'sent' : 'unanswered'}`}>
                          {selectedQuestion.sent ? 'Changing sent answer' : 'Unanswered'}
                        </span>
                        <h3>{selectedQuestion.question.question}</h3>
                        {resolvableSelector(selectedQuestion.question.selector) && (
                          <button
                            type="button"
                            className="tile-review-show-context"
                            onClick={() => surfaceRef.current.revealSelector(selectedQuestion.question.selector)}
                          >
                            Show in page
                          </button>
                        )}
                      </div>
                      <QuestionEditorFields
                        question={selectedQuestion.question}
                        draft={selectedQuestionDraft}
                        busy={selectedQuestionBusy}
                        onChange={(change) => changeQuestionDraft(selectedQuestion.question, change)}
                      />
                      <footer className="tile-review-detail-actions">
                        <span className="tile-review-detail-spacer" />
                        <button
                          type="button"
                          className="web-pane-action"
                          disabled={
                            selectedQuestionBusy ||
                            !selectedQuestionDraft.answer.trim() ||
                            !pendingQueue.addResponse
                          }
                          onClick={() => void queueQuestionAnswer(selectedQuestion.question)}
                        >
                          {selectedQuestionBusy ? 'Queueing…' : 'Queue answer'}
                        </button>
                      </footer>
                    </>
                  ) : selected && selectedDraft && selectedEditor ? (
                    <>
                      <div className="tile-review-detail-heading">
                        <span className={`tile-review-type is-${selected.response ? 'response' : 'annotation'}`}>
                          {itemType(selected)}
                        </span>
                        <h3>{selected.response?.question ?? selected.selector}</h3>
                        {!selected.response && <code>{selected.tag}</code>}
                        {resolvableSelector(selected.selector) && (
                          <button
                            type="button"
                            className="tile-review-show-context"
                            onClick={() => surfaceRef.current.revealSelector(selected.selector)}
                          >
                            Show in page
                          </button>
                        )}
                      </div>
                      <PendingEditorFields
                        note={selected}
                        draft={selectedDraft}
                        editor={selectedEditor}
                        busy={selectedBusy}
                        onChange={(change) => changeDraft(selected.id, change)}
                      />
                      <div className="tile-review-attachments">
                        <div className="tile-review-section-head">
                          <strong>Attachments</strong>
                          <label className={`tile-review-add-image${selectedBusy ? ' is-disabled' : ''}`}>
                            <span>Add image</span>
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/gif,image/webp"
                              disabled={selectedBusy}
                              aria-label="Add image attachment"
                              onChange={(event) => {
                                const file = event.target.files?.[0]
                                event.currentTarget.value = ''
                                if (file) void uploadAttachment(selected.id, file)
                              }}
                            />
                          </label>
                        </div>
                        {(selected.attachments?.length ?? 0) > 0 ? (
                          <div className="tile-review-attachment-grid">
                            {selected.attachments?.map((attachment) => (
                              <div key={attachment.id} className="tile-review-attachment">
                                <button
                                  type="button"
                                  className="tile-review-attachment-preview"
                                  onClick={() => setPreview({ id: attachment.id, name: attachment.name })}
                                  aria-label={`Preview ${attachment.name}`}
                                >
                                  <img src={pendingQueue.attachmentUrl(attachment.id)} alt="" />
                                  <span>{attachment.name}</span>
                                </button>
                                <button
                                  type="button"
                                  className="tile-review-attachment-remove"
                                  disabled={selectedBusy}
                                  aria-label={`Remove ${attachment.name}`}
                                  onClick={() => void removeAttachment(selected.id, attachment.id)}
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : <span className="tile-review-empty-attachments">No images attached</span>}
                      </div>
                      <footer className="tile-review-detail-actions">
                        <button
                          type="button"
                          className="tile-review-remove-item"
                          disabled={selectedBusy}
                          onClick={() => void removeOne(selected.id)}
                        >
                          Remove from queue
                        </button>
                        <span className="tile-review-detail-spacer" />
                        <button
                          type="button"
                          className="web-pane-action is-ghost"
                          disabled={!selectedDraft.dirty || selectedBusy || !selectedDraft.answer}
                          onClick={() => void saveOne(selected.id)}
                        >
                          {selectedBusy ? 'Working…' : 'Save changes'}
                        </button>
                        <button
                          type="button"
                          className="web-pane-action"
                          disabled={selectedBusy || !selectedDraft.answer}
                          onClick={() => void sendOne(selected.id)}
                        >
                          {selectedBusy ? 'Working…' : 'Send this'}
                        </button>
                      </footer>
                    </>
                  ) : (
                    <div className="tile-review-empty">Select an item to review.</div>
                  )}
                </div>
              </div>
              {queueError && <div className="tile-review-drawer-error" role="alert">{queueError}</div>}
            </section>
          )}
        </>
      )}
      {preview && (
        <div className="tile-review-preview-backdrop" onMouseDown={() => setPreview(null)}>
          <div
            className="tile-review-preview"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${preview.name}`}
            onMouseDown={(event) => event.stopPropagation()}
            data-native-terminal-occluder=""
          >
            <header>
              <strong>{preview.name}</strong>
              <button type="button" aria-label="Close attachment preview" autoFocus onClick={() => setPreview(null)}>×</button>
            </header>
            <img src={pendingQueue.attachmentUrl(preview.id)} alt={preview.name} />
          </div>
        </div>
      )}
    </>
  )
}

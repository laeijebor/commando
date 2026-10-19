import { useEffect, useRef, useState } from 'react'
import type { WebPanePendingNote, WebPaneSentAnswer } from '../shared/protocol'
import type { RedlinePageQuestion, RedlinePageResponse } from '../shared/redline-response'
import { draftFromSent, draftValues, responseForQuestion, sentAgo, sentAnswerLabel, type QuestionDraft } from './TileReviewLayer'

const EMPTY: QuestionDraft = { answer: '', note: '', choices: [] }
const same = (a: QuestionDraft, b: QuestionDraft) => a.answer === b.answer && a.note === b.note && a.choices.join('\n') === b.choices.join('\n')

/**
 * Answer controls inside a canvas question note. Choices queue as soon as they
 * are picked, like redline's choice control; text and notes queue explicitly.
 */
export function CanvasQuestionControls({ question, recorded, pending, sent, disabled, onQueue, onRemove }: {
  question: RedlinePageQuestion
  /** Answer the agent recorded in canvas.json; the question is settled. */
  recorded?: string
  pending?: WebPanePendingNote
  sent?: WebPaneSentAnswer
  disabled: boolean
  onQueue: (response: RedlinePageResponse) => void
  onRemove: (noteId: number) => void
}) {
  // Choices may only be recoverable from the answer text (a recorded answer, or a sent one without data).
  const withChoices = (values: QuestionDraft): QuestionDraft => question.kind !== 'choice' || values.choices.length ? values
    : { ...values, choices: (question.options ?? []).filter((o) => question.multiple ? values.answer.split(', ').includes(o) : o === values.answer) }
  const queued = pending ? draftValues(pending) : null
  const [draft, setDraft] = useState<QuestionDraft>(() => queued ?? (sent ? withChoices(draftFromSent(sent)) : EMPTY))
  const [reopened, setReopened] = useState(false)
  const [noteOpen, setNoteOpen] = useState(() => !!draft.note)
  const base = queued ?? EMPTY
  const dirty = !same(draft, base)
  // Follow edits made elsewhere (the queue drawer, a send) unless the owner is mid-edit here.
  const pendingIdentity = pending ? `${pending.id}:${pending.revision ?? 1}` : ''
  const lastBase = useRef(base)
  useEffect(() => {
    const previous = lastBase.current
    lastBase.current = base
    setDraft((current) => same(current, previous) ? base : current)
    if (!pending) setReopened(false)
  }, [pendingIdentity])

  if (sent && !pending && !reopened) return <div className="canvas-q-settled">
    <span>{sentAgo(sent.sentAt)}: <b>{sentAnswerLabel(sent)}</b></span>
    <button type="button" onClick={() => { setDraft(withChoices(draftFromSent(sent))); setReopened(true) }}>Change</button>
  </div>
  if (recorded !== undefined && !pending && !reopened) return <div className="canvas-q-settled">
    <span>Answered: <b>{recorded}</b></span>
    <button type="button" onClick={() => { setDraft(withChoices({ ...EMPTY, answer: recorded })); setReopened(true) }}>Reopen</button>
  </div>

  const queue = (next: QuestionDraft) => { if (next.answer.trim()) onQueue(responseForQuestion(question, next)) }
  const pick = (option: string) => {
    if (disabled) return
    if (!question.multiple) {
      const next = { ...draft, answer: option, choices: [option] }
      setDraft(next); queue(next); return
    }
    const choices = draft.choices.includes(option) ? draft.choices.filter((c) => c !== option) : [...draft.choices, option]
    const ordered = (question.options ?? []).filter((o) => choices.includes(o))
    const next = { ...draft, answer: ordered.join(', '), choices: ordered }
    setDraft(next)
    if (ordered.length) queue(next)
    else if (pending) onRemove(pending.id)
  }
  const status = pending ? dirty ? 'Changed since queued' : 'Queued ✓' : ''
  return <div className="canvas-q">
    {question.kind === 'choice'
      ? <div className="canvas-q-options" role={question.multiple ? 'group' : 'radiogroup'} aria-label={question.question}>
        {question.options!.map((option) => <button type="button" key={option} disabled={disabled}
          role={question.multiple ? undefined : 'radio'} aria-checked={question.multiple ? undefined : draft.choices.includes(option)}
          aria-pressed={question.multiple ? draft.choices.includes(option) : undefined}
          className={draft.choices.includes(option) ? 'is-picked' : ''} onClick={() => pick(option)}>{option}</button>)}
      </div>
      : <textarea aria-label={`Answer: ${question.question}`} placeholder="Your answer…" rows={2} disabled={disabled}
        value={draft.answer} onChange={(event) => setDraft({ ...draft, answer: event.target.value })} />}
    {noteOpen
      ? <textarea aria-label="Note (optional)" placeholder="Note (optional)" rows={2} disabled={disabled}
        value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
      : <button type="button" className="canvas-q-link" onClick={() => setNoteOpen(true)}>+ Add note</button>}
    <div className="canvas-q-foot">
      <span className={pending && dirty ? 'is-stale' : ''} role="status">{status}</span>
      {reopened && !pending && <button type="button" className="canvas-q-link" onClick={() => { setReopened(false); setDraft(queued ?? EMPTY) }}>Cancel</button>}
      {(question.kind === 'text' || dirty) && <button type="button" className="canvas-q-queue" disabled={disabled || !dirty || !draft.answer.trim()}
        onClick={() => queue(draft)}>{pending ? 'Update answer' : 'Queue answer'}</button>}
    </div>
  </div>
}

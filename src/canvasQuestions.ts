import { encodeCanvasPath, type CanvasAnnotation } from '../shared/canvas-manifest'
import { MAX_RESPONSE_QUESTION, type RedlinePageQuestion } from '../shared/redline-response'

/** A real selector for the note card, so agents and the queue can point at it. */
export const canvasNoteSelector = (id: string) => `[data-canvas-note="${id}"]`
export const canvasNoteIdFromSelector = (selector: string) => /^\[data-canvas-note="([A-Za-z0-9_-]{1,64})"\]$/.exec(selector)?.[1] ?? null

/** Canvas-level answers belong to the manifest file, apart from any frame page. */
export const canvasQuestionsPage = (artifactBase: string, manifest: string) =>
  new URL(encodeCanvasPath(manifest), new URL(artifactBase, window.location.href)).href

/** The redline question a question note asks: a choice when it lists options, else free text. */
export function canvasQuestion(note: CanvasAnnotation): RedlinePageQuestion | null {
  const question = note.text || note.title || note.id
  // Too long to send whole; the manifest reports it, and a truncated prompt would hide later edits.
  if (note.kind !== 'question' || question.length > MAX_RESPONSE_QUESTION) return null
  return {
    question,
    kind: note.options ? 'choice' : 'text',
    ...(note.options ? { options: note.options, multiple: note.multiple === true } : {}),
    selector: canvasNoteSelector(note.id),
    queueKey: note.key ?? note.id,
  }
}

/** Questions still open for answering; a note with an agent-recorded answer is settled. */
export const openCanvasQuestions = (annotations: CanvasAnnotation[]) =>
  annotations.flatMap((note) => {
    const question = note.answer === undefined ? canvasQuestion(note) : null
    return question ? [question] : []
  })

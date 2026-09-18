import type { WebPanePendingNote } from '@commando/protocol'

/**
 * How a queued item is edited, inferred from the `data` a redline component
 * queued with its answer. Ported from `src/TileReviewLayer.tsx` so the phone
 * offers the same controls as the cockpit for the same question.
 */
export type PendingEditor =
  | { kind: 'choice'; options: string[]; multiple: boolean }
  | { kind: 'approve'; options: string[] }
  | { kind: 'rating'; max: number }
  | { kind: 'text' }

function responseData(note: WebPanePendingNote): Record<string, unknown> {
  const data = note.response?.data
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {}
}

export function editorFor(note: WebPanePendingNote): PendingEditor {
  const data = responseData(note)
  if (Array.isArray(data.options) && data.options.every((option) => typeof option === 'string')) {
    return { kind: 'choice', options: data.options as string[], multiple: data.multiple === true }
  }
  if (typeof data.verdict === 'string') {
    return { kind: 'approve', options: ['approve', 'reject', 'needs-changes'] }
  }
  if (typeof data.max === 'number' && Number.isInteger(data.max) && data.max >= 2) {
    return { kind: 'rating', max: Math.min(10, data.max) }
  }
  return { kind: 'text' }
}

/**
 * The values the editor opens with. A structured answer is rebuilt from
 * `data` rather than from the rendered `answer` string, so re-opening a
 * multi-select shows the boxes that were ticked, not the joined label.
 */
export function draftValues(note: WebPanePendingNote): { answer: string; note: string } {
  if (!note.response) return { answer: note.comment, note: '' }
  const data = responseData(note)
  const editor = editorFor(note)
  let answer = note.response.answer
  if (editor.kind === 'choice') {
    const choice = data.choice
    if (Array.isArray(choice)) answer = choice.map(String).join(', ')
    else if (typeof choice === 'string') answer = choice
  } else if (editor.kind === 'approve' && typeof data.verdict === 'string') {
    answer = data.verdict
  } else if (editor.kind === 'rating') {
    const rating = typeof data.rating === 'number' ? data.rating : Number.parseInt(answer, 10)
    if (Number.isFinite(rating)) answer = `${rating}/${editor.max}`
  }
  const legacyNote = typeof data.comment === 'string' ? data.comment : ''
  return { answer, note: note.response.note ?? legacyNote }
}

/** Multi-select answers are a comma-joined list, in the options' own order. */
export function selectedChoices(answer: string): string[] {
  return answer.split(', ').filter(Boolean)
}

export function toggleChoice(answer: string, options: readonly string[], option: string): string {
  const selected = new Set(selectedChoices(answer))
  if (selected.has(option)) selected.delete(option)
  else selected.add(option)
  return options.filter((value) => selected.has(value)).join(', ')
}

export function pendingItemKind(note: WebPanePendingNote): 'Response' | 'Annotation' {
  return note.response ? 'Response' : 'Annotation'
}

/** The heading of a queued item: what was asked, or what was pointed at. */
export function pendingItemLabel(note: WebPanePendingNote): string {
  return note.response ? note.response.question : note.selector
}

/** One chip in the pending strip: the answer if there is one, else the note. */
export function pendingChipLabel(note: WebPanePendingNote): string {
  if (note.response) return `${note.response.question}: ${note.response.answer}`
  return note.selector || note.comment
}

export function pendingDraftFor(note: WebPanePendingNote): {
  answer: string
  note: string
  baseRevision: number
} {
  return { ...draftValues(note), baseRevision: note.revision ?? 1 }
}

import type { AgentInteractionAnswer, AgentQuestion } from '@commando/protocol'

/**
 * The daemon's shared validator (`server/agent-request-answers.ts`) and the
 * interaction broker both cap an answer at 300 characters and 12 entries per
 * question, and demand exactly one group per `AgentQuestion`. The same limits
 * are enforced here so a phone never sends something the broker will refuse.
 */
export const MAX_ANSWER_LENGTH = 300
export const MAX_ANSWERS_PER_GROUP = 12

/** What the user has picked for one `AgentQuestion` on the answer screen. */
export type QuestionSelection = {
  /** Indices into `AgentQuestion.options`, in the order they were tapped. */
  optionIndices: number[]
  /** Free text typed into the custom-answer field, if the question allows one. */
  custom: string
}

export function emptySelection(): QuestionSelection {
  return { optionIndices: [], custom: '' }
}

export function emptySelections(questions: readonly AgentQuestion[]): QuestionSelection[] {
  return questions.map(() => emptySelection())
}

/**
 * A single-choice question behaves like a radio group (tapping the selected
 * option clears it); a `multiple` one like a checkbox list, capped at the
 * broker's twelve entries per group.
 */
export function toggleOption(
  question: AgentQuestion,
  selection: QuestionSelection,
  index: number,
): QuestionSelection {
  if (!question.multiple) {
    const already = selection.optionIndices.length === 1 && selection.optionIndices[0] === index
    return { ...selection, optionIndices: already ? [] : [index] }
  }
  if (selection.optionIndices.includes(index)) {
    return {
      ...selection,
      optionIndices: selection.optionIndices.filter((candidate) => candidate !== index),
    }
  }
  if (selection.optionIndices.length >= MAX_ANSWERS_PER_GROUP) return selection
  return { ...selection, optionIndices: [...selection.optionIndices, index] }
}

export function isOptionSelected(selection: QuestionSelection, index: number): boolean {
  return selection.optionIndices.includes(index)
}

/** Trims and clips one answer entry to the length the daemon accepts. */
export function clampAnswer(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > MAX_ANSWER_LENGTH ? trimmed.slice(0, MAX_ANSWER_LENGTH) : trimmed
}

/**
 * The labels (and custom text) chosen for one question, in option order, with
 * the custom answer last. Empty strings are dropped: the broker rejects them.
 */
export function selectedAnswers(
  question: AgentQuestion,
  selection: QuestionSelection,
): string[] {
  const chosen = [...selection.optionIndices]
    .sort((left, right) => left - right)
    .map((index) => question.options[index]?.label ?? '')
    .map(clampAnswer)
    .filter((label) => label.length > 0)
  const custom = question.custom ? clampAnswer(selection.custom) : ''
  const answers = custom ? [...chosen, custom] : chosen
  return answers.slice(0, MAX_ANSWERS_PER_GROUP)
}

export function questionIsAnswered(
  question: AgentQuestion,
  selection: QuestionSelection,
): boolean {
  return selectedAnswers(question, selection).length > 0
}

export function answersAreComplete(
  questions: readonly AgentQuestion[],
  selections: readonly QuestionSelection[],
): boolean {
  if (questions.length === 0) return false
  return questions.every((question, index) => {
    const selection = selections[index]
    return selection !== undefined && questionIsAnswered(question, selection)
  })
}

/**
 * A note is not part of `AgentInteractionAnswer`, so it cannot travel as its
 * own field. When the user typed one it is appended to the last answer of the
 * last question — the text the agent reads — and the screen says so in a hint.
 */
export function appendNote(answer: string, note: string): string {
  const trimmed = note.trim()
  if (!trimmed) return answer
  return clampAnswer(`${answer}\n\n${trimmed}`)
}

/**
 * One group per `AgentQuestion`, which is exactly what the broker's
 * `validAnswer` demands — a missing or empty group makes the whole answer
 * invalid, so callers gate on `answersAreComplete` first.
 */
export function buildAnswerGroups(
  questions: readonly AgentQuestion[],
  selections: readonly QuestionSelection[],
  note = '',
): string[][] {
  const groups = questions.map((question, index) =>
    selectedAnswers(question, selections[index] ?? emptySelection()))
  const lastGroup = groups[groups.length - 1]
  const trimmedNote = note.trim()
  if (trimmedNote && lastGroup && lastGroup.length > 0) {
    const lastIndex = lastGroup.length - 1
    lastGroup[lastIndex] = appendNote(lastGroup[lastIndex] ?? '', trimmedNote)
  }
  return groups
}

export function buildQuestionAnswer(
  questions: readonly AgentQuestion[],
  selections: readonly QuestionSelection[],
  note = '',
): AgentInteractionAnswer {
  return { action: 'answer', answers: buildAnswerGroups(questions, selections, note) }
}

/** Rejecting carries no answers; the broker accepts `reject` on its own. */
export function buildRejectAnswer(): AgentInteractionAnswer {
  return { action: 'reject' }
}

export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'

export function buildPermissionAnswer(decision: PermissionDecision): AgentInteractionAnswer {
  return { action: decision }
}

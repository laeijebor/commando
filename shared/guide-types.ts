/**
 * Guide types and limits with no runtime imports, so the companion app can
 * share them without bundling the remark parser in guide.ts.
 */

/** A tickable step parsed from a guide: a `- [ ]` task item or a `<checkpoint>` tag. */
export type GuideStep = {
  id: string
  /** Plain-text label, without any trailing `{#id}`. */
  label: string
  checkpoint: boolean
  /** `[x]` in the source: the agent marked the step done. */
  sourceChecked: boolean
  /** Source offset of the task item or checkpoint tag (task items use it as the render-time lookup key). */
  offset: number
}

export type GuideOutline = { title: string; steps: GuideStep[] }

/** The user's own tick and/or note on a step; a tick wins over the source `[x]`. */
export type GuideMark = { checked?: boolean; note?: string; at: number }

/** What the agent was last told about a step. */
export type GuideDelivered = { checked?: boolean; note?: string }

export type GuideChange = { id: string; label: string; checkpoint: boolean; checked: boolean; note?: string; checkedChanged: boolean; noteChanged: boolean }

export type GuideSnapshot = {
  title: string
  steps: Array<GuideStep & { checked: boolean; note?: string; byUser: boolean }>
  marks: Record<string, GuideMark>
  /** User changes the agent has not been told about yet. */
  changes: GuideChange[]
  /** "Update agent" was pressed and the push is waiting for the agent to go idle. */
  waiting: boolean
  deliveredAt?: number
  error?: string
}

export const GUIDE_STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const MAX_GUIDE_LABEL = 500
export const MAX_GUIDE_NOTE = 2_000

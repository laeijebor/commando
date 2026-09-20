import type {
  AgentStatus,
  AgentTask,
  PaneScreenshotFolder,
  SessionBrief,
  SessionBriefUpdate,
  SessionBriefUpdateKind,
} from '@commando/protocol'

import { parseMarkdown, type MarkdownBlock } from './markdown'

/**
 * The Info sheet's worklog section, as data. Everything the desktop
 * `PaneWorklog` derives is derived here instead, so the numbers on the phone
 * and on the Mac cannot drift and the rules are unit-testable without a
 * renderer.
 */

export type PlanProgress = {
  /** Tasks in display order, cancelled ones included so they can be struck through. */
  tasks: AgentTask[]
  completed: number
  /** Cancelled tasks are excluded, exactly as the desktop's `activeTasks` is. */
  total: number
  ratio: number
}

export type TimelineEntry = {
  id: string
  kind: SessionBriefUpdateKind
  text: string
  detail?: string
  createdAt: number
  /** 'You', 'Agent update' or 'Lifecycle', matching the desktop's byline. */
  author: string
  screenshotFolderId?: string
}

export type WorklogView = {
  headline: string
  state: SessionBrief['state']
  headlineSource: 'hook' | 'agent'
  recap: MarkdownBlock[]
  next?: string
  plan: PlanProgress
  timeline: TimelineEntry[]
  screenshots: PaneScreenshotFolder[]
  updatedAt: number
}

/** Verbatim port of the desktop's progress rule: cancelled tasks leave the denominator. */
export function planProgress(tasks: readonly AgentTask[] | undefined): PlanProgress {
  const all = tasks ? [...tasks] : []
  const active = all.filter((task) => task.status !== 'cancelled')
  const completed = active.filter((task) => task.status === 'completed').length
  return {
    tasks: all,
    completed,
    total: active.length,
    ratio: active.length ? completed / active.length : 0,
  }
}

function authorLabel(update: SessionBriefUpdate): string {
  if (update.author === 'user') return 'You'
  return update.source === 'agent' ? 'Agent update' : 'Lifecycle'
}

/**
 * Newest first. The daemon appends updates in the order they arrive, and the
 * desktop reads its timeline top-down after scrolling to the start, so the
 * phone sorts explicitly rather than trusting arrival order.
 */
export function timelineEntries(updates: readonly SessionBriefUpdate[] | undefined): TimelineEntry[] {
  return (updates ? [...updates] : [])
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((update) => ({
      id: update.id,
      kind: update.kind,
      text: update.text,
      createdAt: update.createdAt,
      author: authorLabel(update),
      ...(update.detail ? { detail: update.detail } : {}),
      ...(update.screenshotFolderId ? { screenshotFolderId: update.screenshotFolderId } : {}),
    }))
}

export function buildWorklogView(brief: SessionBrief): WorklogView {
  return {
    headline: brief.headline,
    state: brief.state,
    headlineSource: brief.headlineSource,
    recap: parseMarkdown(brief.recapMarkdown),
    ...(brief.next ? { next: brief.next } : {}),
    plan: planProgress(brief.tasks),
    timeline: timelineEntries(brief.updates),
    screenshots: brief.screenshots ?? [],
    updatedAt: brief.updatedAt,
  }
}

export type HudDetailsView = {
  intent?: string
  activity?: string
  checks: { label: string; status: 'running' | 'passed' | 'failed' }[]
  changes?: { fileCount: number; additions: number; deletions: number }
  plan: PlanProgress
}

/**
 * What the sheet shows when the daemon has an agent status but no worklog: the
 * same fields the desktop HUD card falls back to.
 */
export function hudDetailsView(status: AgentStatus | undefined): HudDetailsView | null {
  const details = status?.details
  if (!details) return null
  const activity = details.currentActivity?.label
    ?? details.recentActivities[0]?.label
  return {
    ...(details.intent ? { intent: details.intent } : {}),
    ...(activity ? { activity } : {}),
    checks: details.checks.map((check) => ({ label: check.label, status: check.status })),
    ...(details.changes ? { changes: details.changes } : {}),
    plan: planProgress(details.tasks),
  }
}

export const UPDATE_KIND_LABEL: Record<SessionBriefUpdateKind, string> = {
  changed: 'changed',
  decision: 'decision',
  check: 'check',
  blocker: 'blocker',
  note: 'note',
  screenshots: 'shots',
}

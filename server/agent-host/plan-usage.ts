import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ChatPlanLimit, ChatPlanSeverity, ChatPlanUsage } from '../../shared/agent-chat.js'

/**
 * Claude's plan limits come from two SDK sources, both read defensively since neither
 * is a stable API: the `/usage` report (`usage_EXPERIMENTAL…`), which has every
 * window, and `rate_limit_event`, which updates the 5h and weekly windows
 * mid-turn through its undocumented `unifiedWindows`.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined
}

function isoTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

function severity(value: unknown): ChatPlanSeverity {
  return value === 'warning' || value === 'critical' ? value : 'normal'
}

function displayName(value: unknown): string | undefined {
  return isRecord(value) && typeof value.display_name === 'string' && value.display_name.trim() ? value.display_name.trim() : undefined
}

function limitTitle(kind: string, group: unknown, scope: unknown): string {
  const scoped = isRecord(scope) ? displayName(scope.model) ?? displayName(scope.surface) : undefined
  if (kind === 'session') return 'Current session'
  if (kind === 'weekly_all') return 'Weekly · all models'
  if (group === 'weekly') return scoped ? `Weekly · ${scoped}` : 'Weekly'
  return scoped ?? kind.replace(/_/g, ' ')
}

function limit(fields: Omit<ChatPlanLimit, 'resetsAt' | 'reached'>, resetsAt: number | undefined): ChatPlanLimit {
  return {
    ...fields,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(fields.percent >= 100 ? { reached: true } : {}),
  }
}

/** Plan limits don't apply to this login (API key, Bedrock, Vertex); they won't start mid-session. */
export const NO_PLAN_LIMITS = 'no_plan_limits'

/**
 * The windows of a `/usage` report. Null when this reading failed (the usage
 * fetch is down, or every window came back empty): the last reading stands.
 */
export function toPlanUsage(report: unknown, now: number): ChatPlanUsage | typeof NO_PLAN_LIMITS | null {
  if (!isRecord(report)) return null
  if (report.rate_limits_available === false) return NO_PLAN_LIMITS
  if (!isRecord(report.rate_limits)) return null
  const rateLimits = report.rate_limits
  let limits: ChatPlanLimit[] = []
  if (Array.isArray(rateLimits.limits)) {
    limits = rateLimits.limits.flatMap((row) => {
      if (!isRecord(row) || typeof row.kind !== 'string' || !row.kind) return []
      const used = percent(row.percent)
      if (used === undefined) return []
      return [limit({ kind: row.kind, title: limitTitle(row.kind, row.group, row.scope), percent: used, severity: severity(row.severity) }, isoTime(row.resets_at))]
    })
  }
  // A server that predates the rows still has the two headline windows.
  if (!limits.length) {
    for (const [key, kind] of [['five_hour', 'session'], ['seven_day', 'weekly_all']] as const) {
      const window = rateLimits[key]
      if (!isRecord(window)) continue
      const used = percent(window.utilization)
      if (used === undefined) continue
      limits.push(limit({ kind, title: limitTitle(kind, undefined, undefined), percent: used, severity: 'normal' }, isoTime(window.resets_at)))
    }
    // Per-model weekly windows (e.g. Fable) come separately in this shape.
    for (const window of Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : []) {
      if (!isRecord(window)) continue
      const used = percent(window.utilization)
      const name = displayName(window)
      if (used === undefined || !name) continue
      limits.push(limit({ kind: 'weekly_scoped', title: `Weekly · ${name}`, percent: used, severity: 'normal' }, isoTime(window.resets_at)))
    }
  }
  if (!limits.length) return null
  const plan = typeof report.subscription_type === 'string' && report.subscription_type ? report.subscription_type : undefined
  return { limits, ...(plan ? { plan } : {}), updatedAt: now }
}

/** The report rows the event's window types correspond to. */
const EVENT_KINDS: Record<string, string> = { five_hour: 'session', seven_day: 'weekly_all' }
const SCOPED_EVENT_MODELS: Record<string, string> = { seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet' }

function eventRow(limits: readonly ChatPlanLimit[], type: string): number {
  const kind = EVENT_KINDS[type]
  if (kind) return limits.findIndex((entry) => entry.kind === kind)
  const model = SCOPED_EVENT_MODELS[type]
  return model ? limits.findIndex((entry) => entry.kind === 'weekly_scoped' && entry.title.includes(model)) : -1
}

function eventTitle(type: string): string {
  const kind = EVENT_KINDS[type]
  if (kind) return limitTitle(kind, undefined, undefined)
  const model = SCOPED_EVENT_MODELS[type]
  if (model) return `Weekly · ${model}`
  return type === 'overage' ? 'Extra usage' : 'Weekly'
}

/**
 * Folds a mid-turn `rate_limit_event` into the last reading: fresh 5h and
 * weekly figures, and the window a warning or refusal is about. Returns the
 * reading unchanged when the event says nothing it can use.
 */
export function applyRateLimitEvent(current: ChatPlanUsage | undefined, info: SDKRateLimitInfo, now: number): ChatPlanUsage | undefined {
  const limits = [...(current?.limits ?? [])]
  let changed = false
  const patch = (index: number, fields: Partial<ChatPlanLimit>) => {
    const next: ChatPlanLimit = { ...limits[index]!, ...fields }
    if (!next.reached) delete next.reached
    limits[index] = next
    changed = true
  }
  const windows = (info as { unifiedWindows?: unknown }).unifiedWindows
  if (isRecord(windows)) {
    for (const type of Object.keys(EVENT_KINDS)) {
      const window = windows[type]
      if (!isRecord(window)) continue
      // Utilization here is a fraction (0.37), unlike the report's percentages.
      const used = typeof window.utilization === 'number' ? percent(window.utilization * 100) : undefined
      if (used === undefined) continue
      const resetsAt = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? { resetsAt: window.resetsAt * 1000 } : {}
      let index = eventRow(limits, type)
      if (index < 0) index = limits.push({ kind: EVENT_KINDS[type]!, title: eventTitle(type), percent: used, severity: 'normal' }) - 1
      // A full window that dropped back under 100% has reset, so it is open again.
      const reopened = used < 100 && limits[index]!.reached
      patch(index, { percent: used, reached: used >= 100, ...(reopened ? { severity: 'normal' as const } : {}), ...resetsAt })
    }
  }
  const type = info.rateLimitType
  if (type && (info.status === 'allowed_warning' || info.status === 'rejected')) {
    const resetsAt = typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt * 1000 } : {}
    let index = eventRow(limits, type)
    // A warning only colours a window we know; a refusal is worth a row of its own.
    if (index < 0 && info.status === 'rejected') index = limits.push({ kind: EVENT_KINDS[type] ?? type, title: eventTitle(type), percent: 100, severity: 'critical' }) - 1
    if (index >= 0) {
      patch(index, info.status === 'rejected'
        ? { severity: 'critical', reached: true, ...resetsAt }
        : { severity: limits[index]!.severity === 'critical' ? 'critical' : 'warning', ...resetsAt })
    }
  }
  if (!changed) return current
  return { ...current, limits, updatedAt: now }
}

/** Codex doesn't grade its windows, so the meter does: amber from 75%, red from 90%. */
function gradedSeverity(used: number): ChatPlanSeverity {
  return used >= 90 ? 'critical' : used >= 75 ? 'warning' : 'normal'
}

function codexWindow(minutes: unknown, fallback: 'session' | 'weekly_all'): { kind: string; title: string } {
  if (minutes === 300 || (minutes == null && fallback === 'session')) return { kind: 'session', title: 'Current session' }
  if (minutes === 10_080 || minutes == null) return { kind: 'weekly_all', title: 'Weekly' }
  const span = typeof minutes === 'number' && minutes % 1_440 === 0 ? `${minutes / 1_440}d` : `${Math.round(Number(minutes) / 60)}h`
  return { kind: `window_${String(minutes)}`, title: `${span} window` }
}

/**
 * Folds a Codex rate-limit snapshot (`account/rateLimits/read`'s `rateLimits`,
 * or a sparse `account/rateLimits/updated`) into the last reading. A window the
 * snapshot leaves out keeps its last value. Undefined until a window is known.
 */
export function applyCodexRateLimits(current: ChatPlanUsage | undefined, snapshot: unknown, now: number): ChatPlanUsage | undefined {
  if (!isRecord(snapshot)) return current
  const limits = [...(current?.limits ?? [])]
  let changed = false
  for (const [key, fallback] of [['primary', 'session'], ['secondary', 'weekly_all']] as const) {
    const window = snapshot[key]
    const used = isRecord(window) ? percent(window.usedPercent) : undefined
    if (used === undefined || !isRecord(window)) continue
    const { kind, title } = codexWindow(window.windowDurationMins, fallback)
    const index = limits.findIndex((entry) => entry.kind === kind)
    const resetsAt = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : limits[index]?.resetsAt
    const next = limit({ kind, title, percent: used, severity: gradedSeverity(used) }, resetsAt)
    if (index >= 0) limits[index] = next
    else limits.push(next)
    changed = true
  }
  // Codex says a window limit was hit but not which; the fullest window is the one.
  // Its other reasons are about workspace credits, not these windows.
  if (snapshot.rateLimitReachedType === 'rate_limit_reached' && limits.length && !limits.some((entry) => entry.reached)) {
    const fullest = limits.reduce((top, entry, index) => entry.percent > limits[top]!.percent ? index : top, 0)
    limits[fullest] = { ...limits[fullest]!, severity: 'critical', reached: true }
    changed = true
  }
  const plan = typeof snapshot.planType === 'string' && snapshot.planType && snapshot.planType !== 'unknown' ? snapshot.planType : current?.plan
  if (!changed || !limits.length) return current
  return { limits, ...(plan ? { plan } : {}), updatedAt: now }
}

import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ChatPlanLimit, ChatPlanSeverity, ChatPlanUsage } from '../../shared/agent-chat.js'

/**
 * Plan limits come from two SDK sources, both read defensively since neither
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

/** The windows of a `/usage` report; null when the account has no plan limits. */
export function toPlanUsage(report: unknown, now: number): ChatPlanUsage | null {
  if (!isRecord(report) || report.rate_limits_available === false || !isRecord(report.rate_limits)) return null
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
      const used = isRecord(window) ? percent(window.utilization) : undefined
      if (used === undefined || !isRecord(window)) continue
      limits.push(limit({ kind, title: limitTitle(kind, undefined, undefined), percent: used, severity: 'normal' }, isoTime(window.resets_at)))
    }
  }
  if (!limits.length) return null
  const plan = typeof report.subscription_type === 'string' && report.subscription_type ? report.subscription_type : undefined
  return { limits, ...(plan ? { plan } : {}), updatedAt: now }
}

const EVENT_KINDS: Record<string, string> = { five_hour: 'session', seven_day: 'weekly_all' }

/**
 * Folds a mid-turn `rate_limit_event` into the last reading: fresh 5h and
 * weekly figures, and the window a warning or refusal is about. Returns the
 * reading unchanged when the event says nothing it can use.
 */
export function applyRateLimitEvent(current: ChatPlanUsage | undefined, info: SDKRateLimitInfo, now: number): ChatPlanUsage | undefined {
  const limits = [...(current?.limits ?? [])]
  let changed = false
  const upsert = (kind: string, patch: Partial<ChatPlanLimit>) => {
    const index = limits.findIndex((entry) => entry.kind === kind)
    const base = index >= 0 ? limits[index]! : { kind, title: limitTitle(kind, undefined, undefined), percent: 0, severity: 'normal' as const }
    const next: ChatPlanLimit = { ...base, ...patch }
    if (!next.reached) delete next.reached
    if (index >= 0) limits[index] = next
    else limits.push(next)
    changed = true
  }
  const windows = (info as { unifiedWindows?: unknown }).unifiedWindows
  if (isRecord(windows)) {
    for (const [key, kind] of Object.entries(EVENT_KINDS)) {
      const window = windows[key]
      if (!isRecord(window)) continue
      // Utilization here is a fraction (0.37), unlike the report's percentages.
      const used = typeof window.utilization === 'number' ? percent(window.utilization * 100) : undefined
      if (used === undefined) continue
      const resetsAt = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : undefined
      // A full window that dropped back under 100% has reset, so it is open again.
      const reopened = used < 100 && limits.some((entry) => entry.kind === kind && entry.reached)
      upsert(kind, { percent: used, reached: used >= 100, ...(reopened ? { severity: 'normal' as const } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) })
    }
  }
  const kind = info.rateLimitType ? EVENT_KINDS[info.rateLimitType] ?? info.rateLimitType : undefined
  if (kind && (info.status === 'allowed_warning' || info.status === 'rejected')) {
    const resetsAt = typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt * 1000 } : {}
    const existing = limits.find((entry) => entry.kind === kind)
    upsert(kind, info.status === 'rejected'
      ? { severity: 'critical', reached: true, ...resetsAt }
      : { severity: existing?.severity === 'critical' ? 'critical' : 'warning', ...resetsAt })
  }
  if (!changed) return current
  return { ...current, limits, updatedAt: now }
}

import { createContext, useContext } from 'react'
import type { ChatPlanLimit, ChatPlanUsage, ChatSessionInfo } from '../../shared/agent-chat'

/** A reading older than this, or one whose window has since reset, shows as stale. */
export const PLAN_USAGE_STALE_MS = 10 * 60_000

/** The newest plan reading per Claude login (config dir); chats on one login share a plan. */
export const PlanUsageContext = createContext<ReadonlyMap<string, ChatPlanUsage> | null>(null)

/**
 * Only Claude chats name their login (the config dir). A Codex chat's
 * CODEX_HOME isn't in its session, so Codex chats keep their own reading.
 */
const loginKey = (session: ChatSessionInfo) => session.provider === 'claude' ? `claude:${session.configDir ?? ''}` : undefined

export function newestPlanUsage(sessions: Iterable<ChatSessionInfo | undefined>): Map<string, ChatPlanUsage> {
  const newest = new Map<string, ChatPlanUsage>()
  for (const session of sessions) {
    if (!session?.planUsage) continue
    const key = loginKey(session)
    if (key === undefined) continue
    const current = newest.get(key)
    if (!current || session.planUsage.updatedAt > current.updatedAt) newest.set(key, session.planUsage)
  }
  return newest
}

/** The chat's own reading, or a newer one another chat on the same login made. */
export function usePlanUsage(session: ChatSessionInfo): ChatPlanUsage | undefined {
  const map = useContext(PlanUsageContext)
  const key = loginKey(session)
  const shared = key === undefined ? undefined : map?.get(key)
  const own = session.planUsage
  if (!own) return shared
  return shared && shared.updatedAt > own.updatedAt ? shared : own
}

/** The windows the composer bar shows: the 5h session and the all-models week. */
export function headlineLimits(usage: ChatPlanUsage): ChatPlanLimit[] {
  const picked = ['session', 'weekly_all'].flatMap((kind) => usage.limits.filter((limit) => limit.kind === kind))
  return picked.length ? picked : usage.limits.slice(0, 2)
}

export function shortLimitLabel(limit: ChatPlanLimit): string {
  if (limit.kind === 'session') return '5h'
  if (limit.kind === 'weekly_all') return 'wk'
  return limit.title
}

/** The window refused a request and has not reset since. */
export function isLimitReached(limit: ChatPlanLimit, now: number): boolean {
  return Boolean(limit.reached) && (limit.resetsAt === undefined || limit.resetsAt > now)
}

export function reachedLimit(usage: ChatPlanUsage, now: number): ChatPlanLimit | undefined {
  return usage.limits.find((limit) => isLimitReached(limit, now))
}

export function isPlanUsageStale(usage: ChatPlanUsage, now: number): boolean {
  if (now - usage.updatedAt > PLAN_USAGE_STALE_MS) return true
  return headlineLimits(usage).some((limit) => limit.resetsAt !== undefined && limit.resetsAt <= now)
}

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayClock = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/** "3:59 PM", or "Fri 12:59 PM" when it is a day or more away. */
export function formatResetTime(resetsAt: number, now: number): string {
  return (resetsAt - now >= 24 * 3_600_000 ? dayClock : clock).format(resetsAt)
}

/** "1h 50m", "12m", "<1m". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/** "just now", "4m ago", "as of 2:14 PM". */
export function formatReadingAge(updatedAt: number, now: number): string {
  const age = now - updatedAt
  if (age < 60_000) return 'just now'
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m ago`
  return `as of ${clock.format(updatedAt)}`
}


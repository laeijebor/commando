import { describe, expect, it } from 'vitest'
import type { ChatPlanUsage, ChatSessionInfo } from '../../shared/agent-chat'
import { formatDuration, formatReadingAge, isPlanUsageStale, newestPlanUsage, reachedLimit } from './planUsage'

const usage = (updatedAt: number, limits: ChatPlanUsage['limits'] = [{ kind: 'session', title: 'Current session', percent: 10, severity: 'normal' }]): ChatPlanUsage => ({ updatedAt, limits })
const session = (configDir: string | undefined, planUsage?: ChatPlanUsage) => ({ paneId: '%1', provider: 'claude', cwd: '/', status: 'idle', hostPid: 1, hostVersion: 1, ...(configDir ? { configDir } : {}), ...(planUsage ? { planUsage } : {}) }) as ChatSessionInfo

describe('plan usage helpers', () => {
  it('keeps the newest reading per login', () => {
    const map = newestPlanUsage([session('/a', usage(5)), session('/a', usage(9)), session('/b', usage(1)), session(undefined, usage(2)), session('/c')])
    expect([...map].map(([key, value]) => [key, value.updatedAt])).toEqual([['/a', 9], ['/b', 1], ['', 2]])
  })

  it('goes stale after ten minutes or once a shown window has reset', () => {
    expect(isPlanUsageStale(usage(0), 9 * 60_000)).toBe(false)
    expect(isPlanUsageStale(usage(0), 11 * 60_000)).toBe(true)
    expect(isPlanUsageStale(usage(0, [{ kind: 'session', title: 'Current session', percent: 90, severity: 'warning', resetsAt: 1_000 }]), 2_000)).toBe(true)
  })

  it('only counts a reached window until it resets', () => {
    const full = usage(0, [{ kind: 'session', title: 'Current session', percent: 100, severity: 'critical', reached: true, resetsAt: 5_000 }])
    expect(reachedLimit(full, 4_000)?.kind).toBe('session')
    expect(reachedLimit(full, 6_000)).toBeUndefined()
  })

  it('formats durations and reading ages', () => {
    expect(formatDuration(30_000)).toBe('<1m')
    expect(formatDuration(110 * 60_000)).toBe('1h 50m')
    expect(formatDuration(50 * 3_600_000)).toBe('2d 2h')
    expect(formatReadingAge(0, 30_000)).toBe('just now')
    expect(formatReadingAge(0, 4 * 60_000)).toBe('4m ago')
    expect(formatReadingAge(0, 2 * 3_600_000)).toMatch(/^as of /)
  })
})

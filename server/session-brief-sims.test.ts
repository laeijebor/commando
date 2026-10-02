import { describe, expect, it } from 'vitest'
import type { SessionBrief } from '../shared/protocol.js'
import { SimLeaseRegistry } from './sim-leases.js'
import { parseSessionBrief } from './session-briefs.js'
import { withSimulatorClaim } from './session-brief-sims.js'

const pane = { id: '%1', targetId: '550e8400-e29b-41d4-a716-446655440000', sessionId: '$1' }
const target = { sessionId: '$1', sessionName: 'Session', repo: { root: '/repo', name: 'repo', branch: 'old', isWorktree: false } }
const input = { udid: '11111111-1111-1111-1111-111111111111', originalName: 'iPhone', via: 'simslim', task: 'Check checkout', ports: [{ name: 'metro', port: 8101 }] }
const brief: SessionBrief = { paneId: '%1', targetId: pane.targetId, sessionId: '$1', sessionName: 'Session', state: 'working', headline: 'Working', headlineSource: 'agent', references: [{ kind: 'feature_flag', value: 'checkout' }], updates: [], updatedAt: 123 }

describe('client simulator claims', () => {
  it('derives from the current lease and live repo without changing references or stored content', () => {
    const registry = new SimLeaseRegistry()
    registry.upsert('%1', target, input)
    const claim = () => registry.list(() => true)[0]
    const joined = withSimulatorClaim(brief, pane, 'Session', claim(), { ...target.repo, branch: 'live-branch' })
    expect(joined.simulator).toEqual({ udid: input.udid, label: 'Session · Check checkout', task: input.task, sessionName: 'Session', branch: 'live-branch', ports: input.ports, idle: false })
    expect(brief.simulator).toBeUndefined()
    expect(joined.references).toEqual(brief.references)
    expect(parseSessionBrief(joined)).toEqual(brief)
    joined.simulator!.ports[0].port = 9999
    expect(claim().ports[0].port).toBe(8101)
    registry.touch('%1', target, { branchOverride: 'override', task: 'Review checkout', ports: [] })
    expect(withSimulatorClaim(brief, pane, 'Session', claim(), target.repo).simulator).toMatchObject({ branch: 'override', task: 'Review checkout', ports: [] })
  })

  it('uses the existing empty worklog shape and removes released claims without persistence', () => {
    let now = 0
    const registry = new SimLeaseRegistry({ now: () => now })
    registry.upsert('%1', target, input)
    now = 30 * 60 * 1000
    const joined = withSimulatorClaim(null, pane, 'Session', registry.list(() => true)[0])
    expect(joined).toMatchObject({ paneId: pane.id, targetId: pane.targetId, headline: 'Pane worklog', headlineSource: 'hook', updates: [], updatedAt: 0, simulator: { idle: true } })
    expect(joined.simulator).not.toHaveProperty('branch')
    expect(joined.references).toBeUndefined()
    registry.delete('%1')
    expect(withSimulatorClaim(joined, pane, 'Session').simulator).toBeUndefined()
    expect(withSimulatorClaim(null, pane, 'Session').updatedAt).toBe(0)
  })
})

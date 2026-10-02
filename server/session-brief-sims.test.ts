import { describe, expect, it, vi } from 'vitest'
import type { SessionBrief, TmuxPane } from '../shared/protocol.js'
import { SimLeaseRegistry } from './sim-leases.js'
import { PaneRepoResolver } from './pane-repos.js'
import { parseSessionBrief } from './session-briefs.js'
import { assembleClientSessionBriefs, withSimulatorClaim } from './session-brief-sims.js'

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
    expect(joined.simulator).toEqual({ udid: input.udid, originalName: input.originalName, label: 'Session · Check checkout', task: input.task, sessionName: 'Session', branch: 'live-branch', ports: input.ports, idle: false })
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

describe('client brief assembly', () => {
  const livePane = { ...pane, path: '/worktree/one' } as TmuxPane
  const secondPane = { ...pane, id: '%2', path: '/worktree/two' } as TmuxPane
  const branch = 'live-checkpoint-01-profile-played'

  it('awaits live repo resolution for publication and ignores stale lease repo metadata', async () => {
    const registry = new SimLeaseRegistry()
    registry.upsert(pane.id, target, input)
    let resolve!: (value: Map<string, typeof target.repo>) => void
    const resolveRepos = vi.fn(() => new Promise<Map<string, typeof target.repo>>((done) => { resolve = done }))
    const sent = vi.fn()
    const publication = assembleClientSessionBriefs([brief], {
      panes: [livePane], leases: () => registry.list(() => true), resolveRepos,
    }, false).then(sent)
    await Promise.resolve()
    expect(sent).not.toHaveBeenCalled()
    resolve(new Map([[livePane.path, { ...target.repo, branch }]]))
    await publication
    expect(sent.mock.calls[0][0][0].simulator.branch).toBe(branch)
    expect(brief).not.toHaveProperty('simulator')
  })

  it('assembles initial and reconciliation snapshots in one batch without losing either pane branch to cache pruning', async () => {
    const registry = new SimLeaseRegistry()
    registry.upsert(pane.id, target, input)
    registry.upsert('%2', target, { ...input, udid: '22222222-2222-2222-2222-222222222222' })
    const resolver = new PaneRepoResolver(async (path) => ({
      isRepo: true, root: path, mainRoot: '/worktree', name: 'repo', branch: path === livePane.path ? branch : 'second-live-branch',
    }))
    const resolveRepos = vi.fn((paths: string[]) => resolver.resolve(paths))
    const dependencies = { panes: [livePane, secondPane], leases: () => registry.list(() => true), resolveRepos }
    // %2 has no stored worklog: its claim still belongs in the initial client snapshot.
    const assembled = await assembleClientSessionBriefs([brief], dependencies)
    expect(assembled.map((entry) => [entry.paneId, entry.simulator?.branch])).toEqual([
      ['%1', branch], ['%2', 'second-live-branch'],
    ])
    expect(resolveRepos).toHaveBeenCalledTimes(1)
    expect(assembled[1]).toMatchObject({ headline: 'Pane worklog', updatedAt: 0 })
    registry.touch('%2', target, { branchOverride: 'explicit-override' })
    expect((await assembleClientSessionBriefs([brief], dependencies))[1].simulator?.branch).toBe('explicit-override')
    registry.delete('%1')
    expect((await assembleClientSessionBriefs([brief], dependencies))[0].simulator).toBeUndefined()
  })

  it('uses the pane live repo if the resolver returns no entry, and omits branch when neither exists', async () => {
    const registry = new SimLeaseRegistry()
    registry.upsert(pane.id, target, input)
    const dependencies = { panes: [{ ...livePane, repo: { ...target.repo, branch } }] as TmuxPane[], leases: () => registry.list(() => true), resolveRepos: async () => new Map() }
    expect((await assembleClientSessionBriefs([brief], dependencies, false))[0].simulator?.branch).toBe(branch)
    dependencies.panes = [livePane]
    expect((await assembleClientSessionBriefs([brief], dependencies, false))[0].simulator).not.toHaveProperty('branch')
  })
})

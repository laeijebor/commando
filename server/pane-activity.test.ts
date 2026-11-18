import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatus } from '../shared/protocol.js'
import { AgentStatusRegistry } from './agent-status-registry.js'
import { PaneActivity } from './pane-activity.js'
import { PaneSeen } from './pane-seen.js'

const status = (value: AgentStatus['status'], updatedAt: number, source: AgentStatus['source'] = 'hook'): AgentStatus => ({
  paneId: '%1', provider: 'claude', status: value, summary: '', source, confidence: 'high', reason: '', updatedAt,
})
const bound = (path?: string) => { const activity = new PaneActivity(path); activity.bindServer('1:1'); return activity }

const dirs: string[] = []
const tempPath = (name: string) => { const dir = mkdtempSync(join(tmpdir(), 'pane-activity-')); dirs.push(dir); return join(dir, name) }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('PaneActivity', () => {
  it('records working and the end of a turn, not a state first seen after a restart', () => {
    const activity = bound()
    expect(activity.record(status('done', 100))).toBeNull()
    expect(activity.record(status('needs_input', 110))).toBeNull()
    expect(activity.record(status('working', 120))).toEqual({ '%1': 120 })
    expect(activity.record(status('done', 130))).toEqual({ '%1': 130 })
    expect(activity.record(status('done', 140))).toBeNull()
    expect(activity.get('%1')).toBe(130)
  })

  it('takes a turn recap seen on its own at its completion time', () => {
    const activity = bound()
    const recapped = { ...status('done', 500), details: { recentActivities: [], checks: [], recap: { outcome: 'done' as const, summary: 'Done', completedAt: 300 } } }
    expect(activity.record(recapped)).toEqual({ '%1': 300 })
    expect(activity.record({ ...recapped, updatedAt: 600 })).toBeNull()
  })

  it('does not count inferred working as activity, but does count the end of that turn', () => {
    const activity = bound()
    expect(activity.record(status('working', 10, 'heuristic'))).toBeNull()
    expect(activity.has('%1')).toBe(false)
    expect(activity.record(status('done', 20, 'heuristic'))).toEqual({ '%1': 20 })
    expect(activity.record(status('done', 30, 'heuristic'))).toBeNull()
  })

  it('saves a done after a blocked or failed state, as the registry settles it now, across a restart', () => {
    for (const source of ['heuristic', 'hook'] as const) {
      for (const before of ['needs_input', 'failed', 'stale'] as const) {
        const path = tempPath('activity.json')
        const activity = bound(path)
        activity.record(status(before, 10, source))
        expect(activity.record(status('done', 20, source))).toEqual({ '%1': 20 })
        activity.flush()
        expect(bound(path).settledAt('%1')).toBe(20)
      }
    }
  })

  it('stores every working update but publishes a busy agent at most once a minute', () => {
    const activity = bound()
    expect(activity.record(status('working', 1_000))).toEqual({ '%1': 1_000 })
    expect(activity.record(status('working', 30_000))).toBeNull()
    expect(activity.get('%1')).toBe(30_000)
    expect(activity.record(status('working', 61_000))).toEqual({ '%1': 61_000 })
    expect(activity.record(status('done', 62_000))).toEqual({ '%1': 62_000 })
  })

  it('seeds only panes with no record', () => {
    const activity = bound()
    expect(activity.seed('%2', 5)).toEqual({ '%2': 5 })
    expect(activity.seed('%2', 9)).toBeNull()
    activity.record(status('working', 50))
    expect(activity.seed('%1', 7)).toBeNull()
  })

  it('treats the first state after forget as a fresh start', () => {
    const activity = bound()
    activity.record(status('working', 10))
    activity.forget('%1')
    expect(activity.settledAt('%1')).toBe(10)
    // A blocked agent that goes away leaves no pending turn behind.
    activity.record(status('needs_input', 15))
    expect(activity.settledAt('%1')).toBeUndefined()
    activity.forget('%1')
    expect(activity.settledAt('%1')).toBe(10)
    expect(activity.record(status('done', 20))).toBeNull()
  })

  it('survives a restart, and a pane working at shutdown settles now rather than at its last activity', () => {
    const path = tempPath('activity.json')
    const before = bound(path)
    before.record(status('working', 10))
    before.record(status('done', 20))
    expect(before.settledAt('%1')).toBe(20)
    before.record(status('working', 30, 'heuristic'))
    before.flush()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ serverId: '1:1', panes: { '%1': { at: 20, inTurn: true } } })

    const after = new PaneActivity(path)
    expect(after.get('%1')).toBeUndefined()
    expect(after.bindServer('1:1')).toBe(true)
    expect(after.get('%1')).toBe(20)
    expect(after.snapshot()).toEqual({ '%1': 20 })
    // An inferred `unknown` while restarting keeps the turn pending; the `done` clears it.
    after.record(status('unknown', 40, 'heuristic'))
    expect(after.settledAt('%1')).toBeUndefined()
    // That turn ended unseen while the daemon was down; its end is saved for the next restart.
    expect(after.record(status('done', 50, 'heuristic'))).toEqual({ '%1': 50 })
    expect(after.settledAt('%1')).toBe(50)
    after.flush()
    const again = new PaneActivity(path)
    again.bindServer('1:1')
    expect(again.settledAt('%1')).toBe(50)
  })

  it('keeps a blocked turn pending across a restart, so its unseen end settles now', () => {
    const path = tempPath('activity.json')
    const before = bound(path)
    before.record(status('working', 10))
    before.record(status('needs_input', 20))
    expect(before.settledAt('%1')).toBeUndefined()
    before.flush()
    // The user answered and the turn finished while the daemon was down.
    const after = bound(path)
    expect(after.settledAt('%1')).toBeUndefined()
    expect(after.record(status('done', 40))).toEqual({ '%1': 40 })
    expect(after.settledAt('%1')).toBe(40)
  })

  it('saves when an inferred working turn stops at a prompt', () => {
    const activity = bound()
    activity.record(status('working', 10, 'heuristic'))
    expect(activity.record(status('needs_input', 20, 'heuristic'))).toEqual({ '%1': 20 })
  })

  it('lets the registry reproduce an unseen turn end after each restart', () => {
    const path = tempPath('activity.json')
    // One daemon run: statuses go through the registry, then are recorded, as in index.ts.
    const run = (statuses: AgentStatus[]) => {
      const activity = bound(path)
      const registry = new AgentStatusRegistry({ lastActivity: (id) => activity.settledAt(id) })
      for (const next of statuses) {
        const change = registry.applyInferred(next)
        if (change?.type === 'upsert') activity.record(change.status)
      }
      activity.flush()
      return registry.get('%1')?.settledAt
    }
    // Blocked when the daemon stops; the turn ends while it is down.
    run([status('working', 10, 'heuristic'), status('needs_input', 20, 'heuristic')])
    expect(run([status('done', 40, 'heuristic')])).toBe(40)
    // Another restart re-infers the same idle agent: still the turn's end, not now.
    expect(run([status('done', 90, 'heuristic')])).toBe(40)
    // A stale or failed pane that finishes after a restart ends its turn then.
    run([status('working', 100, 'heuristic'), status('failed', 110, 'heuristic')])
    expect(run([status('done', 120, 'heuristic')])).toBe(120)
    expect(run([status('done', 130, 'heuristic')])).toBe(120)
  })

  it('drops saved panes from another tmux server', () => {
    const path = tempPath('activity.json')
    const before = bound(path)
    before.record(status('working', 10))
    before.flush()
    const after = new PaneActivity(path)
    expect(after.bindServer('2:2')).toBe(true)
    expect(after.get('%1')).toBeUndefined()
    expect(after.bindServer('2:2')).toBe(false)
  })
})

describe('PaneSeen persistence', () => {
  it('reloads seen times for the same tmux server', () => {
    const path = tempPath('seen.json')
    const seen = new PaneSeen(path)
    seen.bindServer('1:1')
    seen.mark(['%4'], 25)
    seen.flush()
    const reloaded = new PaneSeen(path)
    expect(reloaded.snapshot()).toEqual({})
    reloaded.bindServer('1:1')
    expect(reloaded.snapshot()).toEqual({ '%4': 25 })
  })

  it('starts empty from a missing or damaged file, skipping invalid entries', () => {
    const missing = new PaneSeen(tempPath('missing.json'))
    missing.bindServer('1:1')
    expect(missing.snapshot()).toEqual({})
    const damaged = tempPath('damaged.json')
    writeFileSync(damaged, '{"serverId": "1:1", "panes": {')
    const fromDamaged = new PaneSeen(damaged)
    fromDamaged.bindServer('1:1')
    expect(fromDamaged.snapshot()).toEqual({})
    const mixed = tempPath('mixed.json')
    writeFileSync(mixed, JSON.stringify({ serverId: '1:1', panes: { '%1': 5, nope: 6, '%2': 'x', '%3': null } }))
    const fromMixed = new PaneSeen(mixed)
    fromMixed.bindServer('1:1')
    expect(fromMixed.snapshot()).toEqual({ '%1': 5 })
  })
})

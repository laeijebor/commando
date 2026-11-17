import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatus } from '../shared/protocol.js'
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

  it('does not count inferred statuses as activity', () => {
    const activity = bound()
    expect(activity.record(status('working', 10, 'heuristic'))).toBeNull()
    expect(activity.has('%1')).toBe(false)
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
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ serverId: '1:1', panes: { '%1': { at: 20, working: true } } })

    const after = new PaneActivity(path)
    expect(after.get('%1')).toBeUndefined()
    expect(after.bindServer('1:1')).toBe(true)
    expect(after.get('%1')).toBe(20)
    expect(after.snapshot()).toEqual({ '%1': 20 })
    // An inferred `unknown` while restarting keeps the turn pending; the `done` clears it.
    after.record(status('unknown', 40, 'heuristic'))
    expect(after.settledAt('%1')).toBeUndefined()
    after.record(status('done', 50, 'heuristic'))
    expect(after.settledAt('%1')).toBe(20)
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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatus } from '../shared/protocol.js'
import { PaneActivity } from './pane-activity.js'
import { PaneSeen } from './pane-seen.js'

const status = (value: AgentStatus['status'], updatedAt: number, source: AgentStatus['source'] = 'hook'): AgentStatus => ({
  paneId: '%1', provider: 'claude', status: value, summary: '', source, confidence: 'high', reason: '', updatedAt,
})

const dirs: string[] = []
const tempPath = (name: string) => { const dir = mkdtempSync(join(tmpdir(), 'pane-activity-')); dirs.push(dir); return join(dir, name) }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('PaneActivity', () => {
  it('records working and the end of a turn, not a state first seen after a restart', () => {
    const activity = new PaneActivity()
    expect(activity.record(status('done', 100))).toBeNull()
    expect(activity.record(status('needs_input', 110))).toBeNull()
    expect(activity.record(status('working', 120))).toEqual({ '%1': 120 })
    expect(activity.record(status('done', 130))).toEqual({ '%1': 130 })
    expect(activity.record(status('done', 140))).toBeNull()
    expect(activity.get('%1')).toBe(130)
  })

  it('takes a turn recap seen on its own at its completion time', () => {
    const activity = new PaneActivity()
    const recapped = { ...status('done', 500), details: { recentActivities: [], checks: [], recap: { outcome: 'done' as const, summary: 'Done', completedAt: 300 } } }
    expect(activity.record(recapped)).toEqual({ '%1': 300 })
    expect(activity.record({ ...recapped, updatedAt: 600 })).toBeNull()
  })

  it('ignores inferred statuses', () => {
    const activity = new PaneActivity()
    expect(activity.record(status('working', 10, 'heuristic'))).toBeNull()
    expect(activity.has('%1')).toBe(false)
  })

  it('stores every working update but publishes a busy agent at most once a minute', () => {
    const activity = new PaneActivity()
    expect(activity.record(status('working', 1_000))).toEqual({ '%1': 1_000 })
    expect(activity.record(status('working', 30_000))).toBeNull()
    expect(activity.get('%1')).toBe(30_000)
    expect(activity.record(status('working', 61_000))).toEqual({ '%1': 61_000 })
    expect(activity.record(status('done', 62_000))).toEqual({ '%1': 62_000 })
  })

  it('seeds only panes with no record', () => {
    const activity = new PaneActivity()
    expect(activity.seed('%2', 5)).toEqual({ '%2': 5 })
    expect(activity.seed('%2', 9)).toBeNull()
    activity.record(status('working', 50))
    expect(activity.seed('%1', 7)).toBeNull()
  })

  it('treats the first state after forget as a fresh start', () => {
    const activity = new PaneActivity()
    activity.record(status('working', 10))
    activity.forget('%1')
    expect(activity.record(status('done', 20))).toBeNull()
  })

  it('survives a restart through its file', () => {
    const path = tempPath('activity.json')
    const before = new PaneActivity(path)
    before.record(status('working', 10))
    before.flush()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ '%1': 10 })
    expect(new PaneActivity(path).get('%1')).toBe(10)
  })
})

describe('PaneSeen persistence', () => {
  it('reloads seen times and starts empty from a damaged file', () => {
    const path = tempPath('seen.json')
    const seen = new PaneSeen(path)
    seen.mark(['%4'], 25)
    seen.flush()
    expect(new PaneSeen(path).snapshot()).toEqual({ '%4': 25 })
    expect(new PaneSeen(tempPath('missing.json')).snapshot()).toEqual({})
  })
})

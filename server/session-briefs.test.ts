import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentStatus } from '../shared/protocol.js'
import { parseSessionBrief, SessionBriefStore } from './session-briefs.js'

const directories: string[] = []

async function store(): Promise<SessionBriefStore> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-session-brief-'))
  directories.push(directory)
  return new SessionBriefStore(join(directory, 'nested', 'briefs.json'))
}

function status(
  paneId: string,
  state: AgentStatus['status'],
  updatedAt: number,
  summary: string,
  taskContent?: string,
): AgentStatus {
  return {
    paneId,
    provider: 'opencode',
    status: state,
    summary,
    source: 'hook',
    confidence: 'high',
    reason: 'test',
    updatedAt,
    details: {
      intent: 'Ship session updates',
      recentActivities: [],
      checks: state === 'needs_input' ? [] : [{ label: 'tests', status: 'passed', updatedAt }],
      ...(taskContent ? {
        tasks: [{
          id: 'task-1',
          content: taskContent,
          status: state === 'done' ? 'completed' : 'in_progress',
          priority: 'high',
          createdAt: 50,
          updatedAt,
        }],
      } : {}),
      ...(state === 'needs_input' ? { attention: 'Choose the release target' } : {}),
    },
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SessionBriefStore', () => {
  it('persists and replays independent briefs for each pane', async () => {
    const briefs = await store()
    await briefs.syncFromStatuses('$1', 'gizmo', [
      status('%1', 'working', 100, 'Running tests'),
      status('%2', 'needs_input', 120, 'Waiting for input'),
    ], 120)

    await briefs.applyAgentPatch('$1', 'gizmo', '%1', {
      recapMarkdown: 'Verified the **typed brief** pipeline.',
      next: 'Choose the release target',
      update: { kind: 'decision', text: 'Keep the brief pane-scoped' },
    }, 140)
    const updated = await briefs.applyAgentPatch('$1', 'gizmo', '%1', {
      update: { kind: 'decision', text: 'Keep the brief pane-scoped' },
    }, 150)

    expect(updated).toMatchObject({
      paneId: '%1',
      sessionId: '$1',
      sessionName: 'gizmo',
      state: 'working',
      headline: 'Ship session updates',
      headlineSource: 'hook',
      recapMarkdown: 'Verified the **typed brief** pipeline.',
      next: 'Choose the release target',
      updatedAt: 150,
    })
    expect(updated.updates.map((entry) => [entry.source, entry.paneId, entry.kind])).toEqual([
      ['agent', '%1', 'decision'],
      ['agent', '%1', 'decision'],
      ['hook', '%1', 'check'],
    ])
    expect(briefs.get('%2')).toMatchObject({
      paneId: '%2',
      state: 'needs_input',
      headline: 'Choose the release target',
      updates: [{ paneId: '%2', kind: 'blocker' }],
    })

    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    expect(replay.get('%1')).toEqual(updated)
  })

  it('keeps the handoff but marks it stale when the last agent status disappears', async () => {
    const briefs = await store()
    await briefs.syncFromStatuses('$2', 'commando', [status('%3', 'done', 100, 'Complete')], 100)

    const [stale] = await briefs.syncFromStatuses('$2', 'commando', [], 200)

    expect(stale).toMatchObject({ state: 'stale', headline: 'Ship session updates', updatedAt: 200 })
    expect(stale.updates).toHaveLength(1)
  })

  it('keeps an agent-authored headline while hook milestones continue changing', async () => {
    const briefs = await store()
    await briefs.syncFromStatuses('$3', 'commando', [status('%4', 'working', 100, 'Generic activity')], 100)
    await briefs.applyAgentPatch('$3', 'commando', '%4', { headline: 'Handoff ready' }, 110)

    const refreshed = await briefs.syncFromStatuses(
      '$3',
      'commando',
      [{
        ...status('%4', 'working', 120, 'Producing output'),
        details: {
          ...status('%4', 'working', 120, 'Producing output').details!,
          checks: [],
          currentActivity: { label: 'Producing output', kind: 'edit', state: 'running', updatedAt: 120 },
        },
      }],
      120,
    )

    expect(refreshed[0]).toMatchObject({ headline: 'Handoff ready', headlineSource: 'agent' })
    expect(refreshed[0]?.updates[0].createdAt).toBe(120)
    expect(refreshed[0]?.updates).toHaveLength(2)
  })

  it('keeps meaningful hook history, current tasks, and dedupes identical heartbeats', async () => {
    const briefs = await store()
    await briefs.syncFromStatuses('$4', 'worklog', [status('%5', 'working', 100, 'Starting', 'Implement worklog')], 100)
    await briefs.applyAgentPatch('$4', 'worklog', '%5', {
      update: { kind: 'decision', text: 'Keep history pane-local' },
    }, 110)
    await briefs.syncFromStatuses('$4', 'worklog', [status('%5', 'working', 120, 'Starting', 'Implement worklog')], 120)
    const changed = await briefs.syncFromStatuses('$4', 'worklog', [{
      ...status('%5', 'working', 130, 'Writing tests', 'Implement worklog'),
      details: {
        ...status('%5', 'working', 130, 'Writing tests', 'Implement worklog').details!,
        checks: [],
        currentActivity: { label: 'Writing tests', kind: 'check', state: 'running', updatedAt: 130 },
      },
    }], 130)

    expect(changed[0]?.tasks).toEqual([{
      id: 'task-1',
      content: 'Implement worklog',
      status: 'in_progress',
      priority: 'high',
      createdAt: 50,
      updatedAt: 130,
    }])
    expect(changed[0]?.updates.map((update) => [update.source, update.text])).toEqual([
      ['hook', 'Writing tests'],
      ['hook', 'tests: passed'],
      ['agent', 'Keep history pane-local'],
    ])
    expect(new Set(changed[0]?.updates.map((update) => update.id)).size).toBe(3)
  })

  it('coalesces repeated lifecycle text when its kind or detail changes', async () => {
    const briefs = await store()
    const intent = 'OK great - create the local branch and run Tilt'
    const first = status('%5', 'working', 100, intent)
    first.details = { ...first.details!, checks: [], intent }
    await briefs.syncFromStatuses('$4', 'worklog', [first], 100)

    const changed = status('%5', 'working', 120, intent)
    changed.details = {
      ...changed.details!,
      checks: [],
      intent,
      changes: { fileCount: 2, additions: 5, deletions: 1 },
    }
    await briefs.syncFromStatuses('$4', 'worklog', [changed], 120)

    expect(briefs.get('%5')?.updates).toEqual([
      expect.objectContaining({ text: intent, kind: 'changed', detail: '2 files · +5 −1', author: 'user' }),
    ])
  })

  it('dedupes repeated lifecycle text while loading existing state', async () => {
    const briefs = await store()
    await mkdir(dirname(briefs.statePath), { recursive: true })
    const entry = {
      paneId: '%5', sessionId: '$4', sessionName: 'worklog', state: 'working',
      headline: 'Current', headlineSource: 'hook', updatedAt: 120,
      updates: [
        { id: 'hook:new', paneId: '%5', kind: 'changed', text: 'Repeated intent', detail: '2 files', source: 'hook', createdAt: 120 },
        { id: 'hook:old', paneId: '%5', kind: 'note', text: 'Repeated intent', source: 'hook', createdAt: 100 },
      ],
    }
    await writeFile(briefs.statePath, JSON.stringify({ version: 3, briefs: { '%5': entry } }))

    await briefs.load()

    expect(briefs.get('%5')?.updates).toEqual([
      expect.objectContaining({ id: 'hook:new', kind: 'changed' }),
    ])
  })

  it('drops generic command and heartbeat churn but records task transitions', async () => {
    const briefs = await store()
    const initial = status('%5', 'working', 100, 'OpenCode is working', 'Implement worklog')
    initial.details = {
      ...initial.details!,
      checks: [],
      intent: undefined,
      currentActivity: { label: 'bash', kind: 'command', state: 'running', updatedAt: 100 },
    }

    expect(await briefs.syncFromStatuses('$4', 'worklog', [initial], 100)).toHaveLength(1)
    expect(briefs.get('%5')?.updates).toEqual([])

    const completed = status('%5', 'working', 120, 'OpenCode is working', 'Implement worklog')
    completed.details = {
      ...completed.details!,
      checks: [],
      intent: undefined,
      tasks: completed.details!.tasks!.map((task) => ({ ...task, status: 'completed' as const, updatedAt: 120 })),
      currentActivity: { label: 'OpenCode is working', kind: 'other', state: 'running', updatedAt: 120 },
    }

    await briefs.syncFromStatuses('$4', 'worklog', [completed], 120)

    expect(briefs.get('%5')?.updates.map((update) => update.text)).toEqual([
      'Task completed: Implement worklog',
    ])
  })

  it('clears the current plan when the provider sends an empty task snapshot', async () => {
    const briefs = await store()
    await briefs.syncFromStatuses('$4', 'worklog', [status('%5', 'working', 100, 'Starting', 'Implement worklog')], 100)
    const cleared = status('%5', 'working', 120, 'Done')
    cleared.details = { ...cleared.details!, tasks: [], progress: { completed: 0, total: 0 } }

    await briefs.syncFromStatuses('$4', 'worklog', [cleared], 120)

    expect(briefs.get('%5')?.tasks).toEqual([])
  })

  it('bounds pane history to 150 meaningful updates', async () => {
    const briefs = await store()
    for (let index = 0; index < 155; index += 1) {
      await briefs.applyAgentPatch('$5', 'bounded', '%6', {
        update: { kind: 'note', text: `Milestone ${index}` },
      }, index + 1)
    }

    const retained = briefs.get('%6')?.updates ?? []
    expect(retained).toHaveLength(150)
    expect(retained[0]?.text).toBe('Milestone 154')
    expect(retained.at(-1)?.text).toBe('Milestone 5')
  })

  it('removes briefs only for tmux sessions that no longer exist and persists cleanup', async () => {
    const briefs = await store()
    await briefs.syncFromStatuses('$6', 'keep', [status('%7', 'working', 10, 'Keep')], 10)
    await briefs.syncFromStatuses('$7', 'remove', [status('%8', 'working', 20, 'Remove')], 20)

    expect(await briefs.removeMissingSessions(['$6'])).toBe(true)
    expect(briefs.get('%7')).not.toBeNull()
    expect(briefs.get('%8')).toBeNull()

    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    expect(replay.values().map((brief) => brief.sessionId)).toEqual(['$6'])
  })

  it('splits persisted session aggregates into pane-local briefs', async () => {
    const briefs = await store()
    await mkdir(dirname(briefs.statePath), { recursive: true })
    await writeFile(briefs.statePath, JSON.stringify({
      version: 1,
      briefs: {
        '$1': {
          sessionId: '$1',
          sessionName: 'commando',
          state: 'working',
          headline: 'Pane one is leading',
          headlineSource: 'hook',
          recapMarkdown: 'Only the leading pane owns this recap.',
          updates: [
            { id: 'hook:1', paneId: '%1', kind: 'note', text: 'Pane one is leading', source: 'hook', createdAt: 20 },
            { id: 'hook:2', paneId: '%2', kind: 'check', text: 'Pane two passed tests', source: 'hook', createdAt: 10 },
          ],
          next: 'Finish pane one',
          updatedAt: 20,
        },
      },
    }))

    await briefs.load()

    expect(briefs.get('%1')).toMatchObject({
      paneId: '%1',
      headline: 'Pane one is leading',
      recapMarkdown: 'Only the leading pane owns this recap.',
      next: 'Finish pane one',
      updates: [{ paneId: '%1' }],
    })
    expect(briefs.get('%2')).toMatchObject({
      paneId: '%2',
      headline: 'Pane two passed tests',
      updates: [{ paneId: '%2' }],
    })
    expect(briefs.get('%2')).not.toHaveProperty('recapMarkdown')
    expect(briefs.get('%2')).not.toHaveProperty('next')
  })

  it('loads v2 briefs and writes the richer v3 format without losing history', async () => {
    const briefs = await store()
    await mkdir(dirname(briefs.statePath), { recursive: true })
    await writeFile(briefs.statePath, JSON.stringify({
      version: 2,
      briefs: {
        '%9': {
          paneId: '%9',
          sessionId: '$9',
          sessionName: 'legacy',
          state: 'working',
          headline: 'Legacy brief',
          headlineSource: 'hook',
          updates: [
            { id: 'hook:9', paneId: '%9', kind: 'note', text: 'Legacy update', source: 'hook', createdAt: 10 },
          ],
          updatedAt: 10,
        },
      },
    }))

    await briefs.load()
    await briefs.applyAgentPatch('$9', 'legacy', '%9', {
      update: { kind: 'check', text: 'Migration verified' },
    }, 20)

    expect(briefs.get('%9')?.updates.map((update) => update.text)).toEqual([
      'Migration verified',
      'Legacy update',
    ])
    expect(JSON.parse(await readFile(briefs.statePath, 'utf8'))).toMatchObject({ version: 3 })
  })

  it('rejects oversized or malformed persisted records', () => {
    expect(parseSessionBrief({ sessionId: 'gizmo' })).toBeNull()
    expect(parseSessionBrief({
      paneId: '%1',
      sessionId: '$1',
      sessionName: 'gizmo',
      state: 'working',
      headline: 'x'.repeat(181),
      headlineSource: 'hook',
      updates: [],
      updatedAt: 1,
    })).toBeNull()
  })
})

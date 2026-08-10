import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      ...(state === 'needs_input' ? { attention: 'Choose the release target' } : {}),
    },
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SessionBriefStore', () => {
  it('aggregates pane statuses, persists agent notes, and replays the result', async () => {
    const briefs = await store()
    await briefs.syncFromStatuses('$1', 'gizmo', [
      status('%1', 'working', 100, 'Running tests'),
      status('%2', 'needs_input', 120, 'Waiting for input'),
    ], 120)

    await briefs.applyAgentPatch('$1', 'gizmo', '%1', {
      recapMarkdown: 'Verified the **typed brief** pipeline.',
      next: 'Choose the release target',
      update: { kind: 'decision', text: 'Keep the brief session-scoped' },
    }, 140)
    const updated = await briefs.applyAgentPatch('$1', 'gizmo', '%1', {
      update: { kind: 'decision', text: 'Keep the brief session-scoped' },
    }, 150)

    expect(updated).toMatchObject({
      sessionId: '$1',
      sessionName: 'gizmo',
      state: 'needs_input',
      headline: 'Choose the release target',
      headlineSource: 'hook',
      recapMarkdown: 'Verified the **typed brief** pipeline.',
      next: 'Choose the release target',
      updatedAt: 150,
    })
    expect(updated.updates.map((entry) => [entry.source, entry.paneId, entry.kind])).toEqual([
      ['agent', '%1', 'decision'],
      ['hook', '%2', 'blocker'],
      ['hook', '%1', 'check'],
    ])

    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    expect(replay.get('$1')).toEqual(updated)
  })

  it('keeps the handoff but marks it stale when the last agent status disappears', async () => {
    const briefs = await store()
    await briefs.syncFromStatuses('$2', 'commando', [status('%3', 'done', 100, 'Complete')], 100)

    const stale = await briefs.syncFromStatuses('$2', 'commando', [], 200)

    expect(stale).toMatchObject({ state: 'stale', headline: 'Ship session updates', updatedAt: 200 })
    expect(stale?.updates).toHaveLength(1)
  })

  it('keeps an agent-authored headline while hook milestones continue changing', async () => {
    const briefs = await store()
    await briefs.syncFromStatuses('$3', 'commando', [status('%4', 'working', 100, 'Generic activity')], 100)
    await briefs.applyAgentPatch('$3', 'commando', '%4', { headline: 'Handoff ready' }, 110)

    const refreshed = await briefs.syncFromStatuses(
      '$3',
      'commando',
      [status('%4', 'working', 120, 'Producing output')],
      120,
    )

    expect(refreshed).toMatchObject({ headline: 'Handoff ready', headlineSource: 'agent' })
    expect(refreshed?.updates[0].createdAt).toBe(120)
  })

  it('rejects oversized or malformed persisted records', () => {
    expect(parseSessionBrief({ sessionId: 'gizmo' })).toBeNull()
    expect(parseSessionBrief({
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

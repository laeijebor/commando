import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatus } from '../shared/protocol.js'
import { SessionBriefStore, validSessionCommand } from '../server/session-briefs.js'

const directories: string[] = []
const identity = {
  paneId: '%1', targetId: '550e8400-e29b-41d4-a716-446655440000',
  sessionId: '$1', sessionName: 'cursor-worklog',
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-cursor-worklog-'))
  directories.push(directory)
  // An explicit state path prevents all real-HOME persistence; no bridge runs.
  const briefs = new SessionBriefStore(join(directory, 'briefs.json'))
  await briefs.reconcilePanes([identity])
  return briefs
}

describe('Cursor worklog guidance contracts', () => {
  it('persists an explicit Cursor resume ID and replaces it when the conversation changes', async () => {
    const briefs = await store()
    const command = 'agent --resume=d227943a-841a-4dfa-94c7-afe2e0774487'
    expect(validSessionCommand(command)).toBe(true)
    await briefs.applyAgentPatch('$1', identity.sessionName, '%1', {
      reference: { action: 'upsert', kind: 'session', value: command },
    }, 100)
    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    expect(replay.get('%1')?.references).toEqual([{ kind: 'session', value: command }])
    const nextCommand = 'agent --resume=550e8400-e29b-41d4-a716-446655440000'
    await replay.applyAgentPatch('$1', identity.sessionName, '%1', {
      reference: { action: 'upsert', kind: 'session', value: nextCommand },
    }, 101)
    expect(replay.get('%1')?.references).toEqual([{ kind: 'session', value: nextCommand }])
  })

  it.each([
    'agent --resume=conversation; echo injected',
    'agent --resume=$(echo injected)',
    'agent --resume=`echo injected`',
    'agent --resume="conversation"',
    'agent --resume=conversation\n',
  ])('rejects unsafe text in a typed resume reference: %j', (command) => {
    expect(validSessionCommand(command)).toBe(false)
  })

  it('stores a textual plan and next action without inventing a structured checklist', async () => {
    const briefs = await store()
    await briefs.applyAgentPatch('$1', identity.sessionName, '%1', {
      recapMarkdown: 'Plan: inspect, fix, verify', next: 'Inspect the failing path',
    }, 100)
    expect(briefs.get('%1')).toMatchObject({
      recapMarkdown: 'Plan: inspect, fix, verify', next: 'Inspect the failing path',
    })
    expect(briefs.get('%1')?.tasks).toBeUndefined()
  })

  it('keeps saved Cursor history stale under heuristic detection and reconnects only with hook provenance', async () => {
    const briefs = await store()
    const status: AgentStatus = {
      paneId: '%1', provider: 'cursor', status: 'working', summary: 'Inspecting',
      source: 'hook', confidence: 'high', reason: 'native hook fixture', updatedAt: 100,
      details: { intent: 'Saved Cursor handoff', recentActivities: [], checks: [] },
    }
    await briefs.syncFromStatuses('$1', identity.sessionName, [status], 100)
    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    await replay.reconcilePanes([identity])
    await replay.syncFromStatuses('$1', identity.sessionName, [{
      ...status, source: 'heuristic', updatedAt: 200,
      details: { intent: 'Guessed from title', recentActivities: [], checks: [] },
    }], 200)
    expect(replay.get('%1')).toMatchObject({ state: 'stale', headline: 'Saved Cursor handoff' })
    await replay.syncFromStatuses('$1', identity.sessionName, [{
      ...status, updatedAt: 300,
      details: { intent: 'Resumed with native hooks', recentActivities: [], checks: [] },
    }], 300)
    expect(replay.get('%1')).toMatchObject({ state: 'working', headline: 'Resumed with native hooks' })
  })
})

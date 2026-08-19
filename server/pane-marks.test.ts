import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SessionBrief, SessionBriefUpdate } from '../shared/protocol.js'
import { PaneMarkStore, parsePaneMark, validatePaneMarkInput } from './pane-marks.js'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const directories: string[] = []

async function store(): Promise<PaneMarkStore> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-pane-marks-'))
  directories.push(directory)
  return new PaneMarkStore(join(directory, 'nested', 'marks.json'))
}

function update(
  id: string,
  createdAt: number,
  text: string,
  source: SessionBriefUpdate['source'] = 'hook',
): SessionBriefUpdate {
  return { id, paneId: '%1', kind: 'note', text, source, createdAt }
}

function brief(updates: SessionBriefUpdate[], updatedAt = 100): SessionBrief {
  return {
    paneId: '%1',
    sessionId: '$1',
    sessionName: 'commando',
    state: 'working',
    headline: 'Building',
    headlineSource: 'hook',
    updates,
    updatedAt,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PaneMarkStore', () => {
  it('persists, reloads, acknowledges, and removes marks by durable target id', async () => {
    const marks = await store()
    const marked = await marks.set(TARGET_ID, { label: 'Waiting for PR', tone: 'amber' }, 100)

    expect(marked).toEqual({
      targetId: TARGET_ID,
      label: 'Waiting for PR',
      tone: 'amber',
      markedAt: 100,
      activityCount: 0,
    })

    const replay = new PaneMarkStore(marks.statePath)
    await replay.load()
    expect(replay.get(TARGET_ID)).toEqual(marked)

    const acknowledged = await replay.acknowledge(TARGET_ID)
    expect(acknowledged?.activityCount).toBe(0)
    expect(await replay.remove(TARGET_ID)).toBe(true)
    expect(replay.get(TARGET_ID)).toBeNull()
  })

  it('counts only new semantic milestones after the mark', async () => {
    const marks = await store()
    await marks.set(TARGET_ID, { label: 'Blocked', tone: 'red' }, 100)
    const before = brief([update('old', 90, 'Old event')], 100)
    const first = brief([update('edit-1', 110, 'Edited App.tsx'), ...before.updates], 110)

    expect(await marks.observeBrief(TARGET_ID, before, first)).toMatchObject({
      activityCount: 1,
      lastActivityAt: 110,
    })

    const promoted = brief([update('edit-2', 120, 'Edited App.tsx'), ...before.updates], 120)
    expect(await marks.observeBrief(TARGET_ID, first, promoted)).toBeNull()

    const deliberate = brief([update('agent-1', 130, 'Ready for review', 'agent'), ...promoted.updates], 130)
    expect(await marks.observeBrief(TARGET_ID, promoted, deliberate)).toMatchObject({
      activityCount: 2,
      lastActivityAt: 130,
    })

    expect(await marks.observeBrief(TARGET_ID, deliberate, { ...deliberate, state: 'done', updatedAt: 140 })).toBeNull()
    expect(await marks.acknowledge(TARGET_ID)).toMatchObject({
      label: 'Blocked',
      activityCount: 0,
      lastActivityAt: 130,
    })
  })

  it('rejects invalid labels, tones, targets, and persisted records', async () => {
    expect(() => validatePaneMarkInput({ label: '', tone: 'amber' })).toThrow('1-48')
    expect(() => validatePaneMarkInput({ label: 'Waiting', tone: 'cyan' })).toThrow('tone')
    expect(parsePaneMark({ targetId: TARGET_ID, label: 'Waiting', tone: 'amber', markedAt: 1, activityCount: -1 })).toBeNull()

    const marks = await store()
    await expect(marks.set('not-a-target', { label: 'Waiting', tone: 'amber' })).rejects.toThrow('target')
  })
})

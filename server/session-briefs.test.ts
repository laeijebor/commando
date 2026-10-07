import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentStatus } from '../shared/protocol.js'
import { AgentStatusRegistry } from './agent-status-registry.js'
import { association } from './cursor-hook-test-fixtures.js'
import { defaultSessionBriefStatePath, parseSessionBrief, SessionBriefStore } from './session-briefs.js'

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
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('recap provenance', () => {
  const targetId = '550e8400-e29b-41d4-a716-446655440000'
  const identity = { paneId: '%1', targetId, sessionId: '$1', sessionName: 'cursor' }

  function cursor(briefs: SessionBriefStore) {
    const registry = new AgentStatusRegistry()
    let now = 0
    return async (event: string, patch: Record<string, unknown> = {}) => {
      ++now
      registry.applyCursorHook('%1', { hook_event_name: event, conversation_id: 'conversation-1',
        generation_id: 'generation-1', emittedAt: String(now), ...patch }, now, 'node', association)
      const current = registry.get('%1')!
      await briefs.syncFromStatuses('$1', 'cursor', [current], now)
      return briefs.get('%1')!
    }
  }

  it('replaces a stop fallback with the late actual final recap', async () => {
    const briefs = await store(); const apply = cursor(briefs)
    await apply('beforeSubmitPrompt', { prompt: 'Verify recap projection' })
    expect(await apply('stop', { status: 'completed' })).toMatchObject({
      recapMarkdown: 'Cursor completed the turn', recapSource: 'hook',
    })
    expect(await apply('afterAgentResponse', { text: '🟢 Verified the final recap' })).toMatchObject({
      headline: 'Verified the final recap', recapMarkdown: 'Verified the final recap', recapSource: 'hook',
    })
    const saved = new SessionBriefStore(briefs.statePath); await saved.load()
    expect(saved.get('%1')).toEqual(briefs.get('%1'))
  })

  it('clears hook-owned recap on new working generation and reports cancellation truthfully', async () => {
    const briefs = await store(); const apply = cursor(briefs)
    await apply('beforeSubmitPrompt')
    await apply('stop', { status: 'completed' })
    const working = await apply('beforeSubmitPrompt', { generation_id: 'generation-2', prompt: 'Next turn' })
    expect(working.state).toBe('working')
    expect(working).not.toHaveProperty('recapMarkdown')
    expect(working).not.toHaveProperty('recapSource')
    const cancelled = await apply('stop', { generation_id: 'generation-2', status: 'aborted' })
    expect(cancelled).toMatchObject({ headline: 'Cursor turn cancelled', recapMarkdown: 'Cursor turn cancelled', recapSource: 'hook' })
    expect(cancelled.recapMarkdown).not.toContain('completed')
  })

  it('preserves an agent-authored handoff through hook activity, corrections and cancellation', async () => {
    const briefs = await store(); const apply = cursor(briefs)
    await apply('beforeSubmitPrompt')
    await apply('stop', { status: 'completed' })
    expect(await briefs.applyAgentPatch('$1', 'cursor', '%1', { recapMarkdown: '**Manual handoff**: review the changes' }, 10)).toMatchObject({ recapSource: 'agent' })
    await apply('afterAgentResponse', { text: '🟢 Hook correction' })
    await apply('beforeSubmitPrompt', { generation_id: 'generation-2' })
    await apply('preToolUse', { generation_id: 'generation-2', tool_name: 'Read', tool_use_id: 'opaque-1' })
    await apply('stop', { generation_id: 'generation-2', status: 'aborted' })
    await briefs.applyAgentPatch('$1', 'cursor', '%1', { update: { kind: 'note', text: 'Reviewed handoff' } }, 11)
    expect(briefs.get('%1')).toMatchObject({ recapMarkdown: '**Manual handoff**: review the changes', recapSource: 'agent' })
    const saved = new SessionBriefStore(briefs.statePath); await saved.load()
    expect(saved.get('%1')).toEqual(briefs.get('%1'))
  })

  it('clears provenance with an explicit recap removal and lets subsequent hooks own a fresh recap', async () => {
    const briefs = await store(); const apply = cursor(briefs)
    await briefs.applyAgentPatch('$1', 'cursor', '%1', { recapMarkdown: 'Old authored recap' }, 1)
    const removed = await briefs.applyAgentPatch('$1', 'cursor', '%1', { recapMarkdown: null }, 2)
    expect(removed).not.toHaveProperty('recapMarkdown')
    expect(removed).not.toHaveProperty('recapSource')
    await apply('beforeSubmitPrompt')
    expect(await apply('stop', { status: 'completed' })).toMatchObject({ recapSource: 'hook', recapMarkdown: 'Cursor completed the turn' })
  })

  it.each([1, 2, 3, 4])('preserves unknown authorship when restoring legacy version %s', async (version) => {
    const briefs = await store()
    const legacy = { paneId: '%1', sessionId: '$1', sessionName: 'cursor', state: 'done',
      headline: 'Saved headline', headlineSource: 'hook', recapMarkdown: 'Legacy manual handoff',
      updates: [{ id: 'hook:1', paneId: '%1', kind: 'note', text: 'Saved update', source: 'hook', createdAt: 1 }], updatedAt: 1 }
    await mkdir(dirname(briefs.statePath), { recursive: true })
    await writeFile(briefs.statePath, JSON.stringify({ version, briefs: { [version === 1 ? '$1' : '%1']: legacy }, ...(version === 4 ? { detached: {} } : {}) }))
    await briefs.load()
    const apply = cursor(briefs)
    await apply('beforeSubmitPrompt')
    await apply('stop', { status: 'aborted' })
    await briefs.applyAgentPatch('$1', 'cursor', '%1', { next: 'Review legacy handoff' }, 3)
    expect(briefs.get('%1')).toMatchObject({ recapMarkdown: 'Legacy manual handoff' })
    expect(briefs.get('%1')).not.toHaveProperty('recapSource')
    const saved = new SessionBriefStore(briefs.statePath); await saved.load()
    expect(saved.get('%1')).toEqual(briefs.get('%1'))
    expect(JSON.parse(await readFile(briefs.statePath, 'utf8')).briefs['%1']).not.toHaveProperty('recapSource')
  })

  it.each(['hook', 'agent'] as const)('round-trips %s provenance through clones, detached storage and pane rebinding', async (source) => {
    const briefs = await store(); await briefs.reconcilePanes([identity])
    const apply = cursor(briefs)
    await apply('beforeSubmitPrompt')
    await apply('stop', { status: 'completed' })
    if (source === 'agent') await briefs.applyAgentPatch('$1', 'cursor', '%1', { recapMarkdown: 'Authored handoff' }, 10)
    const recap = briefs.get('%1')!.recapMarkdown
    briefs.get('%1')!.recapSource = source === 'hook' ? 'agent' : 'hook'
    briefs.values()[0].recapMarkdown = 'Mutated clone'
    expect(briefs.get('%1')).toMatchObject({ recapSource: source, recapMarkdown: recap })
    await briefs.removeMissingSessions([])
    const saved = new SessionBriefStore(briefs.statePath); await saved.load()
    await saved.reconcilePanes([{ ...identity, paneId: '%2', sessionId: '$2' }])
    expect(saved.get('%2')).toMatchObject({ recapSource: source, recapMarkdown: recap })
    await saved.syncFromStatuses('$2', 'cursor', [status('%2', 'working', 20, 'New turn')], 20)
    if (source === 'hook') expect(saved.get('%2')).not.toHaveProperty('recapMarkdown')
    else expect(saved.get('%2')).toMatchObject({ recapSource: 'agent', recapMarkdown: recap })
  })

  it('validates optional provenance without deriving it from headline or recap contents', () => {
    const brief = { paneId: '%1', sessionId: '$1', sessionName: 'cursor', state: 'done', headline: 'Done',
      headlineSource: 'hook', recapMarkdown: 'Cursor completed the turn', updates: [], updatedAt: 1 }
    expect(parseSessionBrief(brief)).not.toHaveProperty('recapSource')
    for (const recapSource of ['agent', 'hook']) expect(parseSessionBrief({ ...brief, recapSource })).toMatchObject({ recapSource })
    for (const recapSource of ['unknown', null, true]) expect(parseSessionBrief({ ...brief, recapSource })).toBeNull()
  })
})

describe('SessionBriefStore', () => {
  const targetId = '550e8400-e29b-41d4-a716-446655440000'
  const identity = { paneId: '%1', targetId, sessionId: '$1', sessionName: 'original' }

  it('keeps a single session term per pane, replaced when the conversation changes', async () => {
    const briefs = await store()
    await briefs.reconcilePanes([identity])
    await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', kind: 'feature_flag', value: 'new-checkout' } }, 100)
    await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', kind: 'session', value: 'claudep --resume aaaaaaaa-1' } }, 101)
    await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', kind: 'session', value: 'claudep --resume bbbbbbbb-2' } }, 102)
    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    expect(replay.get('%1')?.references).toEqual([
      { kind: 'feature_flag', value: 'new-checkout' },
      { kind: 'session', value: 'claudep --resume bbbbbbbb-2' },
    ])
    await replay.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'remove', kind: 'session', value: 'claudep --resume bbbbbbbb-2' } }, 103)
    expect(replay.get('%1')?.references).toEqual([{ kind: 'feature_flag', value: 'new-checkout' }])
  })

  it('upserts and removes references without losing them on lifecycle updates, reload or pane moves', async () => {
    const briefs = await store()
    await briefs.reconcilePanes([identity])
    await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', kind: 'feature_flag', value: 'new-checkout' } }, 100)
    await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', kind: 'url', value: 'http://localhost:5273/checkout', label: 'Checkout' } }, 101)
    await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', kind: 'url', value: 'http://localhost:5273/checkout', label: 'Checkout preview' } }, 102)
    await briefs.syncFromStatuses('$1', 'original', [status('%1', 'working', 103, 'Running')], 103)
    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    await replay.reconcilePanes([{ ...identity, paneId: '%2', sessionId: '$2', sessionName: 'moved' }])
    expect(replay.get('%2')?.references).toEqual([
      { kind: 'feature_flag', value: 'new-checkout' },
      { kind: 'url', value: 'http://localhost:5273/checkout', label: 'Checkout preview' },
    ])
    await replay.applyAgentPatch('$2', 'moved', '%2', { reference: { action: 'remove', kind: 'feature_flag', value: 'new-checkout' } }, 104)
    expect(replay.get('%2')?.references).toEqual([{ kind: 'url', value: 'http://localhost:5273/checkout', label: 'Checkout preview' }])
    expect(replay.get('%1')).toBeNull()
  })

  it('bounds the pinned reference list without dropping existing entries', async () => {
    const briefs = await store()
    for (let index = 0; index < 20; index += 1) {
      await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', kind: 'feature_flag', value: `flag-${index}` } }, 100 + index)
    }
    await expect(briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', kind: 'feature_flag', value: 'overflow' } }, 121))
      .rejects.toThrow('Too many session references')
    expect(briefs.get('%1')?.references).toHaveLength(20)
    await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'remove', kind: 'feature_flag', value: 'flag-0' } }, 122)
    await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', kind: 'feature_flag', value: 'replacement' } }, 123)
    expect(briefs.get('%1')?.references).toHaveLength(20)
  })

  it('persists distinct issue, deployment, build and release references and replaces linked builds', async () => {
    const briefs = await store()
    await briefs.reconcilePanes([identity])
    for (const reference of [
      { kind: 'issue' as const, value: 'https://github.com/acme/app/issues/42', label: 'Bug #42' },
      { kind: 'deployment' as const, value: 'https://preview.example.com/', label: 'Preview' },
      { kind: 'build' as const, value: '1842', url: 'https://ci.example.com/build/1842' },
      { kind: 'release' as const, value: 'v2.3.0' },
    ]) await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', ...reference } })
    await briefs.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'upsert', kind: 'build', value: '1842', url: 'https://ci.example.com/build/1842/retry' } })
    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    expect(replay.get('%1')?.references).toEqual([
      { kind: 'issue', value: 'https://github.com/acme/app/issues/42', label: 'Bug #42' },
      { kind: 'deployment', value: 'https://preview.example.com/', label: 'Preview' },
      { kind: 'release', value: 'v2.3.0' },
      { kind: 'build', value: '1842', url: 'https://ci.example.com/build/1842/retry' },
    ])
    await replay.applyAgentPatch('$1', 'original', '%1', { reference: { action: 'remove', kind: 'issue', value: 'https://github.com/acme/app/issues/42' } })
    expect(replay.get('%1')?.references?.some((reference) => reference.kind === 'issue')).toBe(false)
  })

  it('keeps tasks, authored history and screenshots across rename, move and daemon reload', async () => {
    const briefs = await store()
    await briefs.reconcilePanes([identity])
    await briefs.syncFromStatuses('$1', 'original', [status('%1', 'working', 100, 'Working', 'Keep the plan')], 100)
    await briefs.applyAgentPatch('$1', 'original', '%1', {
      headline: 'Authored handoff', recapMarkdown: 'Keep this recap', next: 'Review',
      update: { kind: 'decision', text: 'Preserve history' },
      publishedScreenshots: { id: '0123456789abcdef', dir: '/tmp/shots', topic: 'review', imageCount: 0, otherCount: 0, bytes: 0, updatedAt: 100, preview: [] },
    }, 101)
    // A rename must be safe even before the next discovery reconciliation.
    await briefs.applyAgentPatch('$1', 'renamed', '%1', { update: { kind: 'note', text: 'After rename' } }, 102)
    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    const moved = { ...identity, sessionId: '$2', sessionName: 'destination' }
    await replay.reconcilePanes([moved])
    await replay.syncFromStatuses('$2', 'destination', [{ ...status('%1', 'done', 103, 'Done'), details: undefined }], 103)
    expect(replay.get('%1')).toMatchObject({
      targetId, sessionId: '$2', sessionName: 'destination', headline: 'Authored handoff',
      recapMarkdown: 'Keep this recap', next: 'Review',
      tasks: [{ content: 'Keep the plan' }], screenshots: [{ id: '0123456789abcdef' }],
    })
    expect(replay.get('%1')?.updates.map(({ text }) => text)).toEqual(expect.arrayContaining(['Preserve history', 'After rename']))
  })

  it('preserves disk history during empty discovery, rebinds matching targets and rejects recycled pane IDs', async () => {
    const briefs = await store()
    await briefs.reconcilePanes([identity])
    await briefs.applyAgentPatch('$1', 'original', '%1', { update: { kind: 'note', text: 'Original owner' } }, 100)
    expect(await briefs.reconcilePanes([])).toBe(false)
    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    expect(replay.get('%1')?.headline).toBe('Original owner')
    await replay.reconcilePanes([{ ...identity, paneId: '%2' }])
    expect(replay.get('%1')).toBeNull()
    expect(replay.get('%2')?.updates[0].paneId).toBe('%2')
    await replay.reconcilePanes([{ ...identity, paneId: '%2', targetId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' }])
    expect(replay.get('%2')).toBeNull()
  })

  it('migrates legacy ownership once and prunes closed panes on populated discovery', async () => {
    const briefs = await store()
    await briefs.applyAgentPatch('$1', 'original', '%1', { headline: 'Legacy' }, 100)
    await briefs.applyAgentPatch('$1', 'original', '%2', { headline: 'Closed sibling' }, 100)
    expect(await briefs.reconcilePanes([{ ...identity, sessionName: 'renamed' }])).toBe(true)
    expect(briefs.get('%1')).toMatchObject({ targetId, headline: 'Legacy', sessionName: 'renamed' })
    expect(briefs.get('%2')).toBeNull()
    expect(await briefs.reconcilePanes([{ ...identity, sessionName: 'renamed' }])).toBe(false)
  })

  it('retains detached history across partial restoration, recycled IDs and another daemon restart', async () => {
    const briefs = await store()
    await briefs.reconcilePanes([identity])
    await briefs.syncFromStatuses('$1', 'original', [status('%1', 'working', 100, 'Working', 'Retain plan')], 100)
    await briefs.applyAgentPatch('$1', 'original', '%1', {
      headline: 'Saved handoff', recapMarkdown: 'Saved recap', next: 'Resume review',
      update: { kind: 'decision', text: 'Saved decision' },
      reference: { action: 'upsert', kind: 'session', value: 'opencode --session ses_original' },
    }, 101)
    const unrelated = { ...identity, targetId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' }
    await briefs.reconcilePanes([unrelated])
    expect(briefs.get('%1')).toBeNull()
    expect(briefs.values()).toEqual([])
    await briefs.applyAgentPatch('$1', 'original', '%1', { headline: 'Different owner' }, 102)
    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    await replay.reconcilePanes([unrelated, { ...identity, paneId: '%8', sessionId: '$4' }])
    expect(replay.get('%1')?.headline).toBe('Different owner')
    expect(replay.get('%8')).toMatchObject({
      targetId, headline: 'Saved handoff', recapMarkdown: 'Saved recap', next: 'Resume review',
      tasks: [{ content: 'Retain plan' }], references: [{ value: 'opencode --session ses_original' }],
    })
    expect(replay.get('%8')?.updates.map((update) => update.text)).toContain('Saved decision')
    expect(replay.get('%8')?.updates.every((update) => update.paneId === '%8')).toBe(true)
  })

  it('keeps a restored hook headline and plan until fresh provider hooks arrive', async () => {
    const briefs = await store()
    await briefs.reconcilePanes([identity])
    await briefs.syncFromStatuses('$1', 'original', [status('%1', 'working', 100, 'Working', 'Keep the plan')], 100)
    await briefs.syncFromStatuses('$1', 'original', [{ ...status('%1', 'working', 200, 'Guessed from title', 'Wrong plan'), source: 'heuristic' }], 200)
    expect(briefs.get('%1')).toMatchObject({ state: 'stale', headline: 'Ship session updates', tasks: [{ content: 'Keep the plan' }] })
    await briefs.syncFromStatuses('$1', 'original', [status('%1', 'working', 300, 'Resumed', 'Continue the plan')], 300)
    expect(briefs.get('%1')).toMatchObject({ state: 'working', tasks: [{ content: 'Continue the plan' }] })
  })

  it('isolates alternate socket persistence while preserving the default and explicit paths', () => {
    vi.stubEnv('COMMANDO_SESSION_BRIEFS_PATH', '')
    vi.stubEnv('COMMANDO_TMUX_SOCKET_PATH', '')
    vi.stubEnv('COMMANDO_TMUX_SOCKET_NAME', '')
    const defaultPath = defaultSessionBriefStatePath()
    expect(defaultPath).toMatch(/\/session-briefs.json$/)
    vi.stubEnv('COMMANDO_TMUX_SOCKET_NAME', 'default')
    expect(defaultSessionBriefStatePath()).toBe(defaultPath)
    vi.stubEnv('COMMANDO_TMUX_SOCKET_NAME', 'verification')
    const alternate = defaultSessionBriefStatePath()
    expect(alternate).not.toBe(defaultPath)
    vi.stubEnv('COMMANDO_TMUX_SOCKET_PATH', '/tmp/verification')
    expect(defaultSessionBriefStatePath()).not.toBe(alternate)
    vi.stubEnv('COMMANDO_SESSION_BRIEFS_PATH', '/tmp/explicit-briefs.json')
    expect(defaultSessionBriefStatePath()).toBe('/tmp/explicit-briefs.json')
  })

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

  it('round-trips screenshot folders and emits republish events only when the preview fingerprint changes', async () => {
    const briefs = await store()
    const folder = {
      id: '0123456789abcdef',
      dir: '/tmp/project/.screenshots/review',
      topic: 'review',
      imageCount: 2,
      otherCount: 1,
      bytes: 30,
      updatedAt: 100,
      truncated: true as const,
      preview: [{ name: 'one.png', size: 10, modifiedAt: 90 }],
    }
    const published = await briefs.applyAgentPatch('$1', 'gizmo', '%1', { publishedScreenshots: folder }, 100)
    await briefs.applyAgentPatch('$1', 'gizmo', '%1', {
      publishedScreenshots: { ...folder, updatedAt: 110 },
    }, 110)
    await briefs.applyAgentPatch('$1', 'gizmo', '%1', {
      publishedScreenshots: {
        ...folder,
        updatedAt: 120,
        preview: [{ ...folder.preview[0], modifiedAt: 115 }],
      },
    }, 120)

    expect(published.screenshots).toEqual([folder])
    expect(briefs.get('%1')?.updates.filter((update) => update.kind === 'screenshots')).toEqual([
      expect.objectContaining({ screenshotFolderId: folder.id, createdAt: 120 }),
      expect.objectContaining({ screenshotFolderId: folder.id, createdAt: 100 }),
    ])
    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    expect(replay.get('%1')?.screenshots?.[0]).toMatchObject({ id: folder.id, updatedAt: 120 })
  })

  it('lets lifecycle status replace a screenshots-only synthesized headline', async () => {
    const briefs = await store()
    await briefs.applyAgentPatch('$1', 'gizmo', '%1', {
      publishedScreenshots: {
        id: '0123456789abcdef',
        dir: '/tmp/project/.screenshots/review',
        topic: 'review',
        imageCount: 1,
        otherCount: 0,
        bytes: 10,
        updatedAt: 100,
        preview: [{ name: 'one.png', size: 10, modifiedAt: 90 }],
      },
    }, 100)

    const nextStatus = status('%1', 'working', 110, 'Rendering the new headline')
    nextStatus.details = { ...nextStatus.details!, intent: undefined, checks: [], currentActivity: { label: 'Rendering the new headline', kind: 'edit', state: 'running', updatedAt: 110 } }
    const [refreshed] = await briefs.syncFromStatuses('$1', 'gizmo', [nextStatus], 110)

    expect(refreshed).toMatchObject({ headline: 'Rendering the new headline', headlineSource: 'hook' })
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

  it('loads v2 briefs and writes v4 without losing history', async () => {
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
    expect(JSON.parse(await readFile(briefs.statePath, 'utf8'))).toMatchObject({ version: 4, detached: {} })
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

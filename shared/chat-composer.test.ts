import { describe, expect, it } from 'vitest'
import type { ChatSessionInfo } from './agent-chat.js'
import { permissionDescription, permissionLabel, permissionModeOptions, providerLabel } from './chat-composer.js'

const session: ChatSessionInfo = {
  paneId: '%1', provider: 'claude', cwd: '/work', status: 'idle', hostPid: 1, hostVersion: 3,
  permissionMode: 'default',
  models: [{ value: 'default', displayName: 'Default', supportsAutoMode: true }],
}
const codex = { ...session, provider: 'codex' as const }

describe('provider-aware composer permissions', () => {
  it('names both providers', () => {
    expect(providerLabel(session)).toBe('Claude')
    expect(providerLabel(codex)).toBe('Codex')
  })

  it.each([
    ['default', 'Workspace access'],
    ['acceptEdits', 'Workspace access'],
    ['plan', 'Read only'],
    ['bypassPermissions', 'Full access'],
  ])('labels Codex %s as %s', (mode, label) => {
    expect(permissionLabel(mode, codex)).toBe(label)
  })

  it('keeps the original labels for Claude and callers without a provider', () => {
    expect(permissionLabel('default', session)).toBe('Ask before edits')
    expect(permissionLabel('plan')).toBe('Plan mode')
    expect(permissionLabel('future-mode', codex)).toBe('future-mode')
  })

  it('describes Codex sandbox access without promising plan-mode behavior', () => {
    expect(permissionDescription('default', codex)).toContain('sandboxed commands')
    expect(permissionDescription('acceptEdits', codex)).toBe(permissionDescription('default', codex))
    expect(permissionDescription('plan', codex)).toBe('Read-only sandbox; Codex asks before escalating access.')
    expect(permissionDescription('bypassPermissions', codex)).toContain('without approval prompts')
    expect(permissionDescription('plan', session)).toBe('Claude explores and plans without changing anything.')
  })

  it('limits Codex to workspace and read-only access even when its model supports auto mode', () => {
    expect(permissionModeOptions(codex)).toEqual(['default', 'plan'])
  })

  it('keeps Muse full access to chats started with it, and offers sandboxed approve-everything otherwise', () => {
    const muse = { ...codex, provider: 'muse' as const }
    expect(permissionModeOptions({ ...muse, bypassAllowed: true })).toEqual(['default', 'acceptEdits'])
    expect(permissionModeOptions({ ...muse, permissionMode: 'bypassPermissions', bypassAllowed: true })).toEqual(['bypassPermissions'])
    expect(permissionLabel('bypassPermissions', muse)).toBe('Full access')
    expect(permissionDescription('acceptEdits', muse)).toContain('inside its sandbox')
  })

  it('offers full access only when enabled or already current', () => {
    expect(permissionModeOptions({ ...codex, bypassAllowed: true })).toEqual(['default', 'plan', 'bypassPermissions'])
    expect(permissionModeOptions({ ...codex, permissionMode: 'bypassPermissions' })).toEqual(['default', 'plan', 'bypassPermissions'])
  })

  it('retains a legacy current Codex mode without offering other Claude-only modes', () => {
    expect(permissionModeOptions({ ...codex, permissionMode: 'acceptEdits' })).toEqual(['default', 'acceptEdits', 'plan'])
    expect(permissionModeOptions({ ...codex, permissionMode: 'dontAsk' })).toEqual(['default', 'plan', 'dontAsk'])
  })

  it('preserves Claude model capabilities, launch permissions, and the current mode', () => {
    expect(permissionModeOptions(session)).toEqual(['default', 'acceptEdits', 'plan', 'auto'])
    expect(permissionModeOptions({ ...session, models: [], bypassAllowed: true, permissionMode: 'dontAsk' }))
      .toEqual(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'])
  })
})


describe('Cursor composer permissions', () => {
  const cursor = { ...session, provider: 'cursor' as const }
  it('names Cursor and offers exactly its four modes, independent of Claude model capabilities', () => {
    expect(providerLabel(cursor)).toBe('Cursor')
    expect(permissionModeOptions({ ...cursor, models: [], permissionMode: 'dontAsk' }))
      .toEqual(['bypassPermissions', 'default', 'auto', 'plan'])
  })
  it.each([
    ['bypassPermissions', 'Full access', 'No sandbox and no review; Cursor never asks.'],
    ['default', 'Sandboxed', "Commands run in Cursor's sandbox; anything outside it is refused, since Cursor can't ask."],
    ['auto', 'Auto-review', "Cursor's reviewer approves or blocks risky actions; nothing asks you."],
    ['plan', 'Plan', 'Cursor plans without changing anything.'],
  ] as const)('labels and describes %s', (mode, label, description) => {
    expect(permissionLabel(mode, cursor)).toBe(label)
    expect(permissionDescription(mode, cursor)).toBe(description)
  })
})

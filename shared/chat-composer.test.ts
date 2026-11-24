import { describe, expect, it } from 'vitest'
import type { ChatSessionInfo, ChatSessionUsage } from './agent-chat.js'
import { formatSessionUsageSummary, formatUsdCents, permissionDescription, permissionLabel, permissionModeOptions, providerLabel } from './chat-composer.js'

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
    const muse = { ...codex, provider: 'muse' as const, sandboxed: true }
    expect(permissionModeOptions({ ...muse, bypassAllowed: true })).toEqual(['default', 'acceptEdits'])
    const full = { ...muse, permissionMode: 'bypassPermissions', bypassAllowed: true, sandboxed: false }
    expect(permissionModeOptions(full)).toEqual(['bypassPermissions'])
    expect(permissionLabel('bypassPermissions', full)).toBe('Full access')
    expect(permissionDescription('acceptEdits', muse)).toContain('inside its sandbox')
  })

  it('shows an older Muse host\'s bypassPermissions as the sandboxed approve-everything it is, and lets it be lowered', () => {
    const legacy = { ...codex, provider: 'muse' as const, permissionMode: 'bypassPermissions', bypassAllowed: true }
    expect(permissionModeOptions(legacy)).toEqual(['default', 'bypassPermissions'])
    expect(permissionLabel('bypassPermissions', legacy)).toBe('Approve everything')
    expect(permissionDescription('bypassPermissions', legacy)).toContain('inside its sandbox')
    expect(permissionModeOptions({ ...legacy, permissionMode: 'default', bypassAllowed: false })).toEqual(['default'])
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

describe('session usage formatting', () => {
  it.each([
    [0, '$0.00'],
    [-5, '$0.00'],
    [Number.NaN, '$0.00'],
    [0.01, '<$0.01'],
    [0.4, '<$0.01'],
    [0.99, '<$0.01'],
    [1, '$0.01'],
    [4.2, '$0.04'],
    [125, '$1.25'],
    [1234.6, '$12.35'],
  ])('formats %s cents as %s', (cents, expected) => {
    expect(formatUsdCents(cents)).toBe(expected)
  })

  it('summarizes tokens alone unless billed cost is positive', () => {
    const baseUsage: ChatSessionUsage = { inputTokens: 10_000, outputTokens: 4_200, totalTokens: 14_200, updatedAt: 1_000 }
    expect(formatSessionUsageSummary(baseUsage)).toBe('14k tok')
    expect(formatSessionUsageSummary({ ...baseUsage, totalTokens: 850 })).toBe('850 tok')
    expect(formatSessionUsageSummary({ ...baseUsage, totalTokens: 1_500_000 })).toBe('1.5M tok')
    expect(formatSessionUsageSummary({ ...baseUsage, chargedCents: 4.2 })).toBe('14k tok · $0.04')
    expect(formatSessionUsageSummary({ ...baseUsage, chargedCents: 0.3 })).toBe('14k tok · <$0.01')
    // Plan-included (chargedCents === 0 with rawCostCents > 0) stays concise in the footer badge.
    expect(formatSessionUsageSummary({ ...baseUsage, chargedCents: 0, rawCostCents: 18 })).toBe('14k tok')
  })
})

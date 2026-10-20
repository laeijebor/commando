import { describe, expect, it } from 'vitest'
import { groupChatConversations, matchesChatConversation, isChatConversationSessionId, parseChatConversations, type ChatConversation } from './chat-conversations.js'

const conversation = (cwd: string, extra: Partial<ChatConversation> = {}): ChatConversation => ({ provider: 'claude', sessionId: 'aaaaaaaa-0001', cwd, title: 't', updatedAt: 1, ...extra })

const current = { id: '$1', name: 'current' }

describe('conversation response validation', () => {
  it('preserves server open pane ids and drops malformed optional ids', () => {
    const open = conversation('/repo', { openPaneId: '%7' })
    expect(parseChatConversations({ conversations: [open] })).toEqual([open])
    for (const openPaneId of [undefined, null, 7, '', '7', '%7extra']) {
      expect(parseChatConversations({ conversations: [{ ...open, openPaneId }] })).toEqual([conversation('/repo')])
    }
  })

  it('accepts Cursor and OpenCode while keeping session ids shell-safe and bounded', () => {
    const cursor = conversation('/repo', { provider: 'cursor' })
    const opencode = conversation('/repo', { provider: 'opencode', sessionId: 'ses_ed3f6d576ffeGGkSAFgSk4Snvz' })
    const muse = conversation('/repo', { provider: 'muse', sessionId: '01a1509e-bbc8-7a33-bd71-167c86ced013' })
    expect(parseChatConversations({ conversations: [cursor, opencode, muse] })).toEqual([cursor, opencode, muse])
    for (const id of ['ses_a;whoami', 'ses_$(pwd)', 'ses_abc\n', 'ses_a bcd', 'ses_abc/def', 'ses_abc_def', `ses_${'a'.repeat(77)}`]) {
      expect(isChatConversationSessionId(id)).toBe(false)
      expect(parseChatConversations({ conversations: [{ ...opencode, sessionId: id }] })).toEqual([])
    }
  })

  it('preserves enrichment including false paneOpen and drops malformed optional metadata', () => {
    const enriched = conversation('/repo', { session: { id: '$1', name: 'vivi', group: 'Subscriptions' },
      agentTitle: 'Stable picker title', headline: 'Picker ready', refs: [{ label: 'PR #540', url: 'https://example.com/540' }, { label: 'Preview' }], paneOpen: false, profile: 'claudep' })
    expect(parseChatConversations({ conversations: [enriched] })).toEqual([enriched])
    expect(parseChatConversations({ conversations: [{ ...conversation('/repo'), session: { id: 1, name: [] }, headline: 2,
      refs: [null, { label: 3 }, { label: 'PR #540', url: 1 }], profile: [], paneOpen: 'yes' }] }))
      .toEqual([{ ...conversation('/repo'), refs: [{ label: 'PR #540' }] }])
  })
})

describe('groupChatConversations', () => {
  it('puts this session first, other sessions by their newest chat, and Outside Commando last', () => {
    const entries = [
      conversation('/elsewhere', { updatedAt: 100 }),
      conversation('/repo', { session: { id: '$2', name: 'vivi', group: 'Subscriptions' }, updatedAt: 20 }),
      conversation('/repo', { session: current, updatedAt: 1 }),
      conversation('/other', { session: { id: '$3', name: 'review' }, updatedAt: 50 }),
      conversation('/repo', { session: { id: '$2', name: 'vivi', group: 'Subscriptions' }, updatedAt: 60 }),
      conversation('/elsewhere', { updatedAt: 90 }),
      conversation('/repo', { session: current, updatedAt: 2 }),
    ]
    const original = [...entries]
    const groups = groupChatConversations(entries, current)
    expect(groups.map((group) => [group.id, group.label, group.conversations.map((entry) => entry.updatedAt)]))
      .toEqual([['session:current', 'This session · current', [2, 1]], ['session:vivi', 'vivi · Subscriptions', [60, 20]], ['session:review', 'review', [50]], ['outside', 'Outside Commando', [100, 90]]])
    expect(entries).toEqual(original)
    expect(groupChatConversations(entries, current, 'review').map((group) => group.label)).toEqual(['review'])
    expect(groupChatConversations([], current)).toEqual([])
  })

  it('uses case-sensitive names across restarts and trusts matching ids only for open panes', () => {
    const entries = [
      conversation('/repo', { title: 'Reused id', session: { id: '$1', name: 'old-work' }, paneOpen: false, updatedAt: 100 }),
      conversation('/repo', { title: 'Same name, older id', session: { id: '$99', name: 'current' }, paneOpen: false, updatedAt: 10 }),
      conversation('/repo', { title: 'Open pane', session: { id: '$1', name: 'before-rename' }, paneOpen: true, updatedAt: 20 }),
      conversation('/repo', { title: 'Other old id', session: { id: '$55', name: 'old-work', group: 'Work' }, updatedAt: 110 }),
      conversation('/repo', { title: 'Different case', session: { id: '$1', name: 'Current' }, updatedAt: 30 }),
    ]
    const groups = groupChatConversations(entries, current)
    expect(groups.map((group) => [group.label, group.conversations.map((entry) => entry.title)])).toEqual([
      ['This session · current', ['Open pane', 'Same name, older id']],
      ['old-work · Work', ['Other old id', 'Reused id']],
      ['Current', ['Different case']],
    ])
  })

  it('matches every word across session, group, headline, title, refs, branch, folder, provider and profile', () => {
    const entry = conversation('/repo/picker', { title: 'Conversation finder', agentTitle: 'Durable topic name', headline: 'Ready for review', branch: 'feature/session',
      session: { id: '$2', name: 'vivi', group: 'Subscriptions' }, refs: [{ label: 'PR #540' }], profile: 'claudep' })
    for (const query of ['durable TOPIC', '540', '#540', 'PR 540', 'VIVI subscriptions', 'ready finder', 'feature picker claude claudep', '  ']) {
      expect(matchesChatConversation(entry, query), query).toBe(true)
    }
    expect(matchesChatConversation(entry, '540 missing')).toBe(false)
    expect(groupChatConversations([entry], current, '#540').flatMap((group) => group.conversations)).toEqual([entry])
  })
})


it('decodes Cursor SDK agent ids alongside Claude and Codex conversations', () => {
  const cursor = conversation('/repo', { provider: 'cursor', sessionId: 'agent-11111111-2222-3333-4444-555555555555' })
  expect(parseChatConversations({ conversations: [cursor, { ...cursor, provider: 'unknown' }, { ...cursor, sessionId: 'bad id!' }] })).toEqual([cursor])
})

import { describe, expect, it } from 'vitest'
import type { ChatAsideRecord, ChatSessionInfo } from '../shared/agent-chat.js'
import { asideSessionIds, isMainChatKey } from './chat-main-key.js'

describe('pane-level chat discovery and ask attribution', () => {
  it('keeps parent panes and excludes aside keys for conversation lists, sent-message search and answersAsk', () => {
    const chats = [{ paneId: '%4' }, { paneId: '%4~abcd1234' }, { paneId: '%9' }]
    expect(chats.filter((chat) => isMainChatKey(chat.paneId))).toEqual([chats[0], chats[2]])
    expect(isMainChatKey('%4~abcd1234')).toBe(false)
  })
})

describe('aside conversation picker exclusions', () => {
  const record = (sessionId: string | undefined, status: 'open' | 'closed'): ChatAsideRecord => ({
    id: 'abcd1234', title: 'Aside', mode: 'read-only', method: 'fork', readOnlyEnforced: true,
    sessionId, status, forkedFrom: { sessionId: 'parent-session' }, createdAt: 1,
  })
  const session = (sessionId?: string): ChatSessionInfo => ({
    paneId: '%4', provider: 'claude', cwd: '/x', status: 'idle', hostPid: 1, hostVersion: 9, sessionId,
  })

  it('collects every chat record and live aside session, without excluding parent transcripts', () => {
    expect(asideSessionIds([
      { paneId: '%4', session: session('parent-session'), asides: [record('open-session', 'open'), record('closed-session', 'closed'), record(undefined, 'open')] },
      { paneId: '%9', session: session('other-main'), asides: [record('other-closed-session', 'closed')] },
      { paneId: '%4~abcd1234', session: session('live-unrecorded'), asides: [record('aside-record', 'closed')] },
      { paneId: '%9~abcd1234', session: session('open-session') },
      { paneId: '%9~abcd5678', session: session() },
    ])).toEqual(new Set(['open-session', 'closed-session', 'other-closed-session', 'live-unrecorded', 'aside-record']))
  })

  it('has no exclusions for ordinary chats without aside records', () => {
    expect(asideSessionIds([{ paneId: '%4', session: session('normal-session') }])).toEqual(new Set())
  })
})

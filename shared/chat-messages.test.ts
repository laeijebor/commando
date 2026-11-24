import { describe, expect, it } from 'vitest'
import type { ChatState } from './agent-chat.js'
import {
  buildSentMessageSnippet,
  canSearchSentMessages,
  formatSentMessageTime,
  matchesSentMessageQuery,
  parseSentMessageSearchResponse,
  searchLiveChatMessages,
} from './chat-messages.js'

describe('shared/chat-messages', () => {
  it('requires at least 3 trimmed characters to search', () => {
    expect(canSearchSentMessages('')).toBe(false)
    expect(canSearchSentMessages('ab')).toBe(false)
    expect(canSearchSentMessages('  ab  ')).toBe(false)
    expect(canSearchSentMessages('abc')).toBe(true)
    expect(canSearchSentMessages('  abc ')).toBe(true)
  })

  it('matches all query words case-insensitively', () => {
    expect(matchesSentMessageQuery('Refactor the authentication middleware', 'auth mid')).toBe(true)
    expect(matchesSentMessageQuery('Refactor the authentication middleware', 'auth missing')).toBe(false)
    expect(matchesSentMessageQuery('Refactor the authentication middleware', 'au')).toBe(false)
  })

  it('builds a windowed snippet centered around the first match with highlight segments', () => {
    const longText = `${'leading '.repeat(25)}deploy pipeline timeout fix${' trailing'.repeat(25)}`
    const segments = buildSentMessageSnippet(longText, 'pipeline fix', 80)
    const rendered = segments.map((s) => s.text).join('')
    expect(rendered.startsWith('…')).toBe(true)
    expect(rendered.endsWith('…')).toBe(true)
    expect(rendered.toLowerCase()).toContain('pipeline')
    expect(segments.filter((s) => s.match).map((s) => s.text.toLowerCase())).toEqual(['pipeline', 'fix'])
  })

  it('formats sent timestamps by recency', () => {
    const now = new Date(2026, 10, 24, 15, 30, 0).getTime()
    expect(formatSentMessageTime(now - 20_000, now)).toBe('just now')
    expect(formatSentMessageTime(now - 12 * 60_000, now)).toBe('12m ago')
    expect(formatSentMessageTime(new Date(2026, 10, 24, 9, 15, 0).getTime(), now)).toMatch(/09:15|9:15/)
    expect(formatSentMessageTime(new Date(2026, 10, 23, 14, 5, 0).getTime(), now)).toMatch(/^Yesterday /)
    expect(formatSentMessageTime(new Date(2026, 10, 10, 11, 0, 0).getTime(), now)).toMatch(/Nov 10|10 Nov/)
    expect(formatSentMessageTime(0, now)).toBe('')
  })

  it('searches live chats ordered newest first and strips attachment notes', () => {
    const chat: ChatState = {
      paneId: '%12',
      hostConnected: true,
      session: {
        paneId: '%12',
        provider: 'claude',
        cwd: '/repo/app',
        status: 'idle',
        sessionId: '11111111-1111-1111-1111-111111111111',
        title: 'Fix login redirect',
        configDir: '/Users/me/.claudew',
        hostPid: 123,
        hostVersion: 8,
      },
      items: [
        {
          id: 'u1',
          turnId: 't1',
          kind: 'user_message',
          status: 'completed',
          createdAt: 1000,
          updatedAt: 1000,
          text: 'Check oauth callback [Attached image "shot.png" is saved at: /tmp/a.png]',
        },
        {
          id: 'a1',
          turnId: 't1',
          kind: 'assistant_message',
          status: 'completed',
          createdAt: 1500,
          updatedAt: 1500,
          text: 'oauth callback looks broken',
        },
        {
          id: 'u2',
          turnId: 't2',
          kind: 'user_message',
          status: 'completed',
          createdAt: 2000,
          updatedAt: 2000,
          text: 'Retry oauth token refresh',
        },
      ],
    }

    const results = searchLiveChatMessages(
      { '%12': chat },
      'oauth',
      () => ({ sessionName: 'auth-work', commandoSessionId: '$2', branch: 'feat/oauth' }),
    )
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      text: 'Retry oauth token refresh',
      sentAt: 2000,
      openPaneId: '%12',
      itemId: 'u2',
      sessionName: 'auth-work',
      chatTitle: 'Fix login redirect',
      providerLabel: 'claudew',
      branch: 'feat/oauth',
    })
    expect(results[1]!.text).toBe('Check oauth callback')
  })

  it('parses valid search responses and drops malformed entries', () => {
    const parsed = parseSentMessageSearchResponse({
      indexing: true,
      messages: [
        {
          id: 'm1',
          text: 'Deploy canary build',
          sentAt: 1700000000000,
          provider: 'codex',
          sessionId: '22222222-2222-2222-2222-222222222222',
          sessionName: 'release',
          chatTitle: 'Canary rollout',
          providerLabel: 'Codex',
        },
        { id: 'bad', text: '', sentAt: 10, provider: 'codex', providerLabel: 'Codex' },
        { id: 'bad2', text: 'hi', sentAt: 10, provider: 'unknown', providerLabel: 'X' },
      ],
    })
    expect(parsed.indexing).toBe(true)
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0]!.sessionName).toBe('release')
  })
})

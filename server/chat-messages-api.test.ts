import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { ChatState } from '../shared/agent-chat.js'
import { CHAT_MESSAGE_SEARCH_ROUTE } from '../shared/chat-messages.js'
import type { CommandoSnapshot } from '../shared/protocol.js'
import { ChatMessagesApi } from './chat-messages-api.js'
import type { IndexedSentMessage } from './chat-message-index.js'
import type { ConversationBriefRecord } from './session-briefs.js'

const emptySnapshot: CommandoSnapshot = {
  revision: 1,
  capturedAt: 1000,
  ports: [],
  sessions: [
    { id: '$1', name: 'payments', attached: true, activeWindowId: '@1', windowIds: ['@1'] },
  ],
  windows: [
    { id: '@1', sessionId: '$1', index: 0, name: 'main', active: true, layout: '', paneIds: ['%1'] },
  ],
  panes: [
    {
      id: '%1',
      targetId: 't1',
      sessionId: '$1',
      windowId: '@1',
      index: 0,
      title: 'Claude',
      command: 'node',
      path: '/repo/payments',
      active: true,
      dead: false,
      width: 120,
      height: 40,
      cursorX: 0,
      cursorY: 0,
      alternateSavedX: 0,
      alternateSavedY: 0,
      alternateOn: false,
      cursorVisible: true,
      cursorShape: 'default',
      cursorBlinking: false,
      scrollRegionUpper: 0,
      scrollRegionLower: 39,
      wrapFlag: true,
      originFlag: false,
      insertFlag: false,
      keypadFlag: false,
      keypadCursorFlag: false,
      mouseAnyFlag: false,
      mouseSgrFlag: false,
      paneTabs: [],
      repo: { root: '/repo/payments', name: 'payments', branch: 'feat/retry', isWorktree: false },
    },
  ],
}

function makeResponse() {
  let statusCode = 0
  let body = ''
  const headers: Record<string, string | number> = {}
  const response = {
    setHeader: (name: string, value: string) => { headers[name] = value },
    writeHead: (code: number, map: Record<string, string | number>) => {
      statusCode = code
      Object.assign(headers, map)
    },
    end: (chunk: string) => { body = chunk },
  } as unknown as ServerResponse
  return { response, read: () => ({ statusCode, headers, json: JSON.parse(body) as Record<string, unknown> }) }
}

describe('ChatMessagesApi', () => {
  it('merges live chats and disk index, deduplicates resumed messages preserving original timestamp, and orders by recency', async () => {
    const liveChat: ChatState = {
      paneId: '%1',
      hostConnected: true,
      session: {
        paneId: '%1',
        provider: 'claude',
        cwd: '/repo/payments',
        status: 'idle',
        sessionId: '11111111-1111-1111-1111-111111111111',
        title: 'Retry logic',
        configDir: '/home/dev/.claudew',
        hostPid: 100,
        hostVersion: 8,
      },
      items: [
        {
          id: 'item-replayed',
          turnId: 't1',
          kind: 'user_message',
          status: 'completed',
          // Replayed at resume time (newer than true transcript time 5000).
          createdAt: 9000,
          updatedAt: 9000,
          text: 'Check webhook retry backoff',
        },
        {
          id: 'item-fresh',
          turnId: 't2',
          kind: 'user_message',
          status: 'completed',
          createdAt: 10000,
          updatedAt: 10000,
          text: 'Add jitter to retry delay',
        },
      ],
    }

    const diskHits: IndexedSentMessage[] = [
      {
        id: 10,
        provider: 'codex',
        sessionId: '22222222-2222-2222-2222-222222222222',
        messageId: 'codex-1',
        text: 'Investigate retry storm in worker',
        sentAt: 7000,
        cwd: '/repo/worker',
        branch: 'fix/worker',
        title: 'Worker storm',
      },
      {
        id: 11,
        provider: 'claude',
        sessionId: '11111111-1111-1111-1111-111111111111',
        messageId: 'u-orig',
        text: 'Check webhook retry backoff',
        sentAt: 5000,
        cwd: '/repo/payments',
        branch: 'feat/retry',
        configDir: '/home/dev/.claudew',
        title: 'Retry logic',
      },
    ]

    const briefs: ConversationBriefRecord[] = [
      {
        provider: 'codex',
        id: '22222222-2222-2222-2222-222222222222',
        sessionId: '$9',
        sessionName: 'worker-ops',
        paneOpen: false,
        title: 'Worker retry fix',
        references: [],
        updatedAt: 7500,
      },
    ]

    const api = new ChatMessagesApi({
      index: {
        search: vi.fn(() => diskHits),
        triggerSync: vi.fn(async () => {}),
        isSyncing: () => false,
        hasSynced: () => true,
      },
      snapshot: () => emptySnapshot,
      briefs: { conversationRecords: () => briefs },
      chats: () => [liveChat],
      agentSessions: () => [],
      home: '/home/dev',
    })

    const { response, read } = makeResponse()
    const handled = await api.handle(
      { method: 'GET' } as IncomingMessage,
      response,
      new URL(`http://localhost${CHAT_MESSAGE_SEARCH_ROUTE}?q=retry`),
    )
    expect(handled).toBe(true)
    const result = read()
    expect(result.statusCode).toBe(200)
    const messages = result.json.messages as Record<string, unknown>[]
    expect(messages).toHaveLength(3)
    // Ordered newest first: 10000 (fresh live), 7000 (codex disk), 5000 (deduplicated live with original disk sentAt!).
    expect(messages.map((m) => [m.text, m.sentAt, m.sessionName, m.openPaneId])).toEqual([
      ['Add jitter to retry delay', 10000, 'payments', '%1'],
      ['Investigate retry storm in worker', 7000, 'worker-ops', undefined],
      ['Check webhook retry backoff', 5000, 'payments', '%1'],
    ])
    expect(messages[1]).toMatchObject({ chatTitle: 'Worker retry fix', providerLabel: 'Codex', paneOpen: false })
    expect(messages[2]).toMatchObject({ itemId: 'item-replayed', providerLabel: 'claudew', paneOpen: true })
  })

  it('returns empty results for queries shorter than 3 chars without touching the index', async () => {
    const search = vi.fn(() => [])
    const api = new ChatMessagesApi({
      index: { search, triggerSync: vi.fn(async () => {}), isSyncing: () => false, hasSynced: () => true },
      snapshot: () => emptySnapshot,
      briefs: { conversationRecords: () => [] },
      chats: () => [],
      agentSessions: () => [],
    })

    const res = await api.search('re')
    expect(res).toEqual({ messages: [] })
    expect(search).not.toHaveBeenCalled()
  })
})

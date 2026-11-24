// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatState } from '../shared/agent-chat'
import type { SentMessageMatch } from '../shared/chat-messages'
import type { ChatMessagesApi } from './chatMessagesApi'
import { useSentMessageSearch } from './useSentMessageSearch'

afterEach(cleanup)

const liveChat: ChatState = {
  paneId: '%7',
  hostConnected: true,
  session: {
    paneId: '%7',
    provider: 'claude',
    cwd: '/repo/demo',
    status: 'idle',
    sessionId: '11111111-1111-1111-1111-111111111111',
    title: 'Auth refactor',
    hostPid: 10,
    hostVersion: 8,
  },
  items: [
    {
      id: 'u1',
      turnId: 't1',
      kind: 'user_message',
      status: 'completed',
      createdAt: 5000,
      updatedAt: 5000,
      text: 'Update oauth callback URL',
    },
  ],
}

const daemonHit: SentMessageMatch = {
  id: 'idx:1',
  text: 'Fix oauth state mismatch',
  sentAt: 8000,
  provider: 'codex',
  sessionId: '22222222-2222-2222-2222-222222222222',
  sessionName: 'old-session',
  chatTitle: 'OAuth state bug',
  providerLabel: 'Codex',
  paneOpen: false,
}

describe('useSentMessageSearch', () => {
  it('stays inactive below 3 characters and never calls the API', () => {
    const search = vi.fn(async () => ({ messages: [] }))
    const api: ChatMessagesApi = { search }

    const { result } = renderHook(() => useSentMessageSearch({
      open: true,
      query: 'oa',
      connected: true,
      api,
      chats: { '%7': liveChat },
      lookupPane: () => ({ sessionName: 'demo' }),
      debounceMs: 10,
    }))

    expect(result.current).toEqual({ active: false, messages: [], loading: false, indexing: false })
    expect(search).not.toHaveBeenCalled()
  })

  it('shows instant live matches immediately, then replaces with daemon results ordered by recency', async () => {
    let resolveSearch!: (value: { messages: SentMessageMatch[] }) => void
    const search = vi.fn(() => new Promise<{ messages: SentMessageMatch[] }>((resolve) => {
      resolveSearch = resolve
    }))
    const api: ChatMessagesApi = { search }

    const { result } = renderHook(() => useSentMessageSearch({
      open: true,
      query: 'oauth',
      connected: true,
      api,
      chats: { '%7': liveChat },
      lookupPane: () => ({ sessionName: 'demo', branch: 'feat/oauth' }),
      debounceMs: 10,
    }))

    // Live match appears immediately before daemon responds.
    expect(result.current.active).toBe(true)
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0]!.text).toBe('Update oauth callback URL')
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(search).toHaveBeenCalledWith('oauth', expect.objectContaining({ signal: expect.any(AbortSignal) })))

    act(() => {
      resolveSearch({ messages: [daemonHit, result.current.messages[0]!] })
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.messages.map((m) => m.text)).toEqual([
      'Fix oauth state mismatch',
      'Update oauth callback URL',
    ])
  })
})

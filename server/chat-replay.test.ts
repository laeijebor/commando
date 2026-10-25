import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatState } from '../shared/agent-chat.js'
import { chatHistoryBudget, chatMessageForClient, windowChatState } from './chat-replay.js'
import { parseClientMessage } from './client-messages.js'

let counter = 0
function command(output: string): ChatItem {
  counter += 1
  return { id: `i${counter}`, turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'command', toolUseId: `u${counter}`, command: 'cat', output }
}
function chat(items: ChatItem[]): ChatState {
  return { paneId: '%1', session: { paneId: '%1', provider: 'claude', cwd: '/tmp', status: 'idle', hostPid: 1, hostVersion: 6 }, items, hostConnected: true }
}

describe('bounded chat replay', () => {
  it('reads the budget from the socket URL, clamped, and nothing without one', () => {
    expect(chatHistoryBudget(new URL('http://h/ws'))).toBeUndefined()
    expect(chatHistoryBudget(new URL('http://h/ws?chatHistory=262144'))).toBe(262_144)
    expect(chatHistoryBudget(new URL('http://h/ws?chatHistory=1'))).toBe(16 * 1024)
    expect(chatHistoryBudget(new URL('http://h/ws?chatHistory=999999999999'))).toBe(64 * 1024 * 1024)
    expect(chatHistoryBudget(new URL('http://h/ws?chatHistory=lots'))).toBeUndefined()
  })

  it('keeps the newest items that fit and counts the rest', () => {
    const items = Array.from({ length: 10 }, () => command('x'.repeat(1_000)))
    const windowed = windowChatState(chat(items), 3_500)
    expect(windowed.items.map((item) => item.id)).toEqual(items.slice(-3).map((item) => item.id))
    expect(windowed.omittedItems).toBe(7)
  })

  it('always keeps the newest item, even one over budget', () => {
    const items = [command('a'), command('x'.repeat(50_000))]
    const windowed = windowChatState(chat(items), 1_000)
    expect(windowed.items).toEqual([items[1]])
    expect(windowed.omittedItems).toBe(1)
  })

  it('leaves a chat that fits untouched', () => {
    const state = chat([command('a'), command('b')])
    expect(windowChatState(state, 100_000)).toBe(state)
  })

  it('keeps an old request that still waits for an answer', () => {
    const request: ChatItem = { id: 'req', turnId: 't', status: 'running', createdAt: 1, updatedAt: 1, kind: 'request', requestId: 'r1', requestKind: 'approval', toolName: 'Bash', title: 'Run it?' }
    const items = [request, ...Array.from({ length: 10 }, () => command('x'.repeat(1_000)))]
    const windowed = windowChatState(chat(items), 2_500)
    expect(windowed.items[0]).toBe(request)
    expect(windowed.items).toHaveLength(3)
    expect(windowed.omittedItems).toBe(8)
  })

  it('keeps an older item the host is still updating, so its updates land in place', () => {
    const subagent: ChatItem = { id: 'sub', turnId: 't', status: 'running', createdAt: 1, updatedAt: 1, kind: 'tool', toolUseId: 'a1', toolName: 'Task', title: 'Explore' }
    const items = [command('old'), subagent, ...Array.from({ length: 10 }, () => command('x'.repeat(1_000)))]
    const windowed = windowChatState(chat(items), 2_500)
    expect(windowed.items.map((item) => item.id)).toEqual(['sub', ...items.slice(-2).map((item) => item.id)])
  })

  it('leaves the chats a client fetched in full whole', () => {
    const items = Array.from({ length: 10 }, () => command('x'.repeat(1_000)))
    const message = { type: 'chat_state' as const, chat: chat(items) }
    const whole = chatMessageForClient(message, 2_400, new Set(['%1']))
    expect(whole.type === 'chat_state' && whole.chat).toBe(message.chat)
    const other = chatMessageForClient(message, 2_400, new Set(['%2']))
    expect(other.type === 'chat_state' && other.chat.items).toHaveLength(2)
  })

  it('bounds chat snapshots and states for a budgeted client only', () => {
    const items = Array.from({ length: 10 }, () => command('x'.repeat(1_000)))
    const snapshot = { type: 'chat_snapshot' as const, chats: [chat(items)] }
    expect(chatMessageForClient(snapshot, undefined)).toBe(snapshot)
    const bounded = chatMessageForClient(snapshot, 16 * 1024)
    expect(bounded.type === 'chat_snapshot' && bounded.chats[0]!.items).toHaveLength(10)
    const small = chatMessageForClient({ type: 'chat_state', chat: chat(items) }, 2_400)
    expect(small.type === 'chat_state' && small.chat.items).toHaveLength(2)
    const other = { type: 'chat_removed' as const, paneId: '%1' }
    expect(chatMessageForClient(other, 2_200)).toBe(other)
  })

  it('parses a request for one chat in full', () => {
    expect(parseClientMessage({ type: 'chat_history', paneId: '%3', requestId: 'h1' })).toEqual({ ok: true, message: { type: 'chat_history', paneId: '%3', requestId: 'h1' } })
    expect(parseClientMessage({ type: 'chat_history', paneId: 'nope', requestId: 'h1' }).ok).toBe(false)
  })
})

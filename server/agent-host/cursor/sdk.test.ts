import { describe, expect, it, vi } from 'vitest'
import type { ConversationTurn } from '@cursor/sdk'
import { MAX_CHAT_ITEMS } from '../../../shared/agent-chat.js'
import { cursorHistory } from './sdk.js'
import { CursorItemMapper } from './items.js'

const turn = (text: string): ConversationTurn => ({ type: 'agentConversationTurn', turn: { userMessage: { text }, steps: [] } })
describe('cursorHistory', () => {
  it('reads runs and conversations newest first, then returns turns oldest first with a skipped count', async () => {
    const order: string[] = []
    const read = vi.fn(async (_id: string, options: { cursor?: string }) => options.cursor ? {
      items: [{ createdAt: 2, conversation: async () => { order.push('bad'); throw new Error('unreadable') } },
        { createdAt: 3, conversation: async () => { order.push('new'); return [turn('new-1'), turn('new-2')] } }],
    } : {
      items: [{ createdAt: 1, conversation: async () => { order.push('old'); return [turn('old')] } }], nextCursor: 'next',
    })
    const log = vi.fn()
    expect(await cursorHistory(read, 'agent', '/workspace', log)).toEqual({ turns: [turn('old'), turn('new-1'), turn('new-2')], skipped: 1 })
    expect(order).toEqual(['new', 'bad', 'old'])
    expect(read.mock.calls).toEqual([['agent', { runtime: 'local', cwd: '/workspace', limit: 100 }], ['agent', { runtime: 'local', cwd: '/workspace', limit: 100, cursor: 'next' }]])
    expect(log).toHaveBeenCalledWith("Couldn't load a Cursor run: unreadable")
  })
  it('scans oldest-first metadata pages but stops reading conversations when the newest items fill the window', async () => {
    const old = vi.fn(async () => [turn('old')])
    const newest = Array.from({ length: MAX_CHAT_ITEMS + 4 }, (_, i) => turn(String(i)))
    const read = vi.fn(async (_id: string, options: { cursor?: string }) => options.cursor
      ? { items: [{ createdAt: 2, conversation: async () => newest }] }
      : { items: [{ createdAt: 1, conversation: old }], nextCursor: 'newer' })
    expect(await cursorHistory(read, 'agent', '/w')).toEqual({ turns: newest.slice(-MAX_CHAT_ITEMS), skipped: 0 })
    expect(read).toHaveBeenCalledTimes(2)
    expect(old).not.toHaveBeenCalled()
  })
  it('bounds history by mapped items rather than the number of turns', async () => {
    const full: ConversationTurn = { type: 'agentConversationTurn', turn: { steps: Array.from({ length: MAX_CHAT_ITEMS }, () => ({ type: 'assistantMessage', message: { text: 'message' } })) } }
    const old = vi.fn(async () => [turn('old')])
    const read = vi.fn(async () => ({ items: [{ createdAt: 2, conversation: async () => [turn('older in run'), full] }, { createdAt: 1, conversation: old }] }))
    expect(await cursorHistory(read, 'agent', '/w')).toEqual({ turns: [full], skipped: 0 })
    expect(old).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('logs failures from plain SDK errors and counts every skipped run', async () => {
    const log = vi.fn()
    const result = await cursorHistory(async () => ({ items: [
      { conversation: async () => { throw { message: 'plain SDK error' } } },
      { conversation: async () => { throw new Error('second failure') } },
    ] }), 'agent', '/w', log)
    expect(result).toEqual({ turns: [], skipped: 2 })
    expect(log).toHaveBeenCalledWith("Couldn't load a Cursor run: plain SDK error")
    expect(log).toHaveBeenCalledWith("Couldn't load a Cursor run: second failure")
  })
  it('rejects repeated cursors rather than looping forever', async () => {
    await expect(cursorHistory(async () => ({ items: [], nextCursor: 'same' }), 'agent', '/w')).rejects.toThrow('repeated')
  })
  it('fills missing user messages using paginated local messages and global turn indices', async () => {
    const conversation = (text: string): ConversationTurn => ({ type: 'agentConversationTurn', turn: { steps: [{ type: 'assistantMessage', message: { text } }] } })
    const message = (index: number, text: string) => ({ type: 'user' as const, uuid: `agent:${index}`, message: { agentConversationTurn: { userMessage: { text }, steps: [] } } })
    const read = vi.fn(async (_id: string, options: { cursor?: string }) => options.cursor ? {
      items: [{ turn_number: 3, createdAt: 3, conversation: async () => [conversation('third'), conversation('fourth')] }],
    } : {
      items: [{ turn_number: 1, createdAt: 1, conversation: async () => [conversation('first')] },
        { turn_number: 2, createdAt: 2, conversation: async () => { throw new Error('skipped') } }], nextCursor: 'next',
    })
    const messages = vi.fn(async (_id: string, options: { offset?: number }) => options.offset
      ? [message(2, 'Third prompt'), message(3, 'Fourth prompt')]
      : [message(0, 'First prompt'), message(1, 'Skipped prompt'), ...Array.from({ length: 98 }, () => ({ type: 'assistant' as const, uuid: 'agent:0', message: { agentConversationTurn: { steps: [] } } }))])
    const result = await cursorHistory(read, 'agent', '/w', undefined, messages)
    expect(messages.mock.calls).toEqual([['agent', { runtime: 'local', cwd: '/w', limit: 100, offset: 0 }], ['agent', { runtime: 'local', cwd: '/w', limit: 100, offset: 100 }]])
    expect(result.skipped).toBe(1)
    expect(result.turns).toMatchObject([
      { turn: { userMessage: { text: 'First prompt' } } },
      { turn: { userMessage: { text: 'Third prompt' } } },
      { turn: { userMessage: { text: 'Fourth prompt' } } },
    ])
    const mapper = new CursorItemMapper()
    result.turns.forEach((entry) => mapper.replay(entry))
    expect(mapper.list().filter((entry) => entry.kind === 'user_message')).toMatchObject([{ text: 'First prompt' }, { text: 'Third prompt' }, { text: 'Fourth prompt' }])
  })
  it('uses oldest-first run positions when run handles omit turn_number and preserves existing user text', async () => {
    const read = async () => ({ items: [{ conversation: async (): Promise<ConversationTurn[]> => [turn('Existing')] },
      { conversation: async (): Promise<ConversationTurn[]> => [{ type: 'agentConversationTurn', turn: { steps: [] } }] }] })
    const result = await cursorHistory(read, 'agent', '/w', undefined, async () => [
      { type: 'user', uuid: 'agent:0', message: { agentConversationTurn: { userMessage: { text: 'Do not replace' }, steps: [] } } },
      { type: 'user', uuid: 'agent:1', message: { agentConversationTurn: { userMessage: { text: 'Restored' }, steps: [] } } },
    ])
    expect(result.turns).toMatchObject([{ turn: { userMessage: { text: 'Existing' } } }, { turn: { userMessage: { text: 'Restored' } } }])
  })
  it('logs a messages failure and replays without partially loaded user texts', async () => {
    const log = vi.fn()
    const entry: ConversationTurn = { type: 'agentConversationTurn', turn: { steps: [{ type: 'assistantMessage', message: { text: 'Reply' } }] } }
    const messages = vi.fn(async (_id: string, options: { offset?: number }) => {
      if (options.offset) throw new Error('messages unavailable')
      return Array.from({ length: 100 }, (_, index) => ({ type: 'user' as const, uuid: `agent:${index}`, message: { agentConversationTurn: { userMessage: { text: 'Partial' }, steps: [] } } }))
    })
    expect(await cursorHistory(async () => ({ items: [{ conversation: async () => [entry] }] }), 'agent', '/w', log, messages))
      .toEqual({ turns: [entry], skipped: 0 })
    expect(log).toHaveBeenCalledWith("Couldn't load Cursor user messages: messages unavailable")
  })
})

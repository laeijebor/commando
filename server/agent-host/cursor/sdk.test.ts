import { describe, expect, it, vi } from 'vitest'
import type { ConversationTurn } from '@cursor/sdk'
import { MAX_CHAT_ITEMS } from '../../../shared/agent-chat.js'
import { cursorHistory } from './sdk.js'

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
})

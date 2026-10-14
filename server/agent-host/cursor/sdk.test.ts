import { describe, expect, it, vi } from 'vitest'
import type { ConversationTurn } from '@cursor/sdk'
import { cursorHistory } from './sdk.js'

describe('cursorHistory', () => {
  it('paginates local runs, sorts oldest first and skips failed conversations', async () => {
    const turn = (text: string): ConversationTurn => ({ type: 'agentConversationTurn', turn: { userMessage: { text }, steps: [] } })
    const read = vi.fn(async (_id: string, options: { cursor?: string }) => options.cursor ? {
      items: [{ createdAt: 1, conversation: async () => [turn('old')] }],
    } : {
      items: [{ createdAt: 3, conversation: async () => [turn('new')] }, { createdAt: 2, conversation: async () => { throw new Error('unreadable') } }], nextCursor: 'next',
    })
    const log = vi.fn()
    expect(await cursorHistory(read, 'agent', '/workspace', log)).toEqual([turn('old'), turn('new')])
    expect(read.mock.calls).toEqual([['agent', { runtime: 'local', cwd: '/workspace' }], ['agent', { runtime: 'local', cwd: '/workspace', cursor: 'next' }]])
    expect(log).toHaveBeenCalledWith('Could not read a Cursor run; skipping it.')
  })
  it('rejects repeated cursors rather than looping forever', async () => {
    await expect(cursorHistory(async () => ({ items: [], nextCursor: 'same' }), 'agent', '/w')).rejects.toThrow('repeated')
  })
})

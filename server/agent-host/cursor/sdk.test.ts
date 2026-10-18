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
  // Shapes as the SDK returns them: run conversations drop the opening prompt but keep a
  // steer's, while messages are protobuf turns ({ turn: { case, value } }), one per prompt.
  const reply = (text: string): ConversationTurn => ({ type: 'agentConversationTurn', turn: { steps: [{ type: 'assistantMessage', message: { text } }] } })
  const steered = (prompt: string, text: string): ConversationTurn => ({ type: 'agentConversationTurn', turn: { userMessage: { text: prompt }, steps: [{ type: 'assistantMessage', message: { text } }] } })
  const prompt = (index: number, text: string) => ({ type: 'user' as const, uuid: `agent:${index}`, message: { turn: { case: 'agentConversationTurn', value: { userMessage: { text }, steps: [] } } } })
  const runs = (...conversations: ConversationTurn[][]) => async () => ({ items: conversations.map((conversation, index) => ({ createdAt: index, conversation: async () => conversation })) })
  const users = (turns: ConversationTurn[]) => {
    const mapper = new CursorItemMapper()
    turns.forEach((entry) => mapper.replay(entry))
    return mapper.list().flatMap((entry) => entry.kind === 'user_message' ? [entry.text] : entry.kind === 'assistant_message' ? [`> ${entry.text}`] : [])
  }
  it("backfills each run's opening prompt when a steer adds its own turn", async () => {
    const result = await cursorHistory(runs([reply('first'), steered('Steer', 'steered')], [reply('second')]), 'agent', '/w', undefined,
      async () => [prompt(0, 'First'), prompt(1, 'Steer'), prompt(2, 'Second')])
    expect(users(result.turns)).toEqual(['First', '> first', 'Steer', '> steered', 'Second', '> second'])
  })
  it('restores the opening prompt when a steer folds the opening turn into the steered one', async () => {
    const result = await cursorHistory(runs([reply('before')], [steered('Steer', 'both')], [reply('after')]), 'agent', '/w', undefined,
      async () => [prompt(0, 'Before'), prompt(1, 'Opening'), prompt(2, 'Steer'), prompt(3, 'After')])
    expect(users(result.turns)).toEqual(['Before', '> before', 'Opening', 'Steer', '> both', 'After', '> after'])
  })
  it('keeps the prompt of a run cancelled before it produced a turn', async () => {
    const result = await cursorHistory(runs([reply('first')], []), 'agent', '/w', undefined, async () => [prompt(0, 'First'), prompt(1, 'Cancelled')])
    expect(users(result.turns)).toEqual(['First', '> first', 'Cancelled'])
  })
  it('stops backfilling when a steer does not match its message instead of mislabelling older turns', async () => {
    const result = await cursorHistory(runs([reply('old')], [steered('Steer', 'new')]), 'agent', '/w', undefined, async () => [prompt(0, 'Old'), prompt(1, 'Opening'), prompt(2, 'Other')])
    expect(users(result.turns)).toEqual(['> old', 'Steer', '> new'])
  })
  it('pages through messages, ignores other entries and accepts the JSON form', async () => {
    const json = (index: number, text: string) => ({ type: 'user' as const, uuid: `agent:${index}`, message: { agentConversationTurn: { userMessage: { text }, steps: [] } } })
    const messages = vi.fn(async (_id: string, options: { offset?: number }) => options.offset
      ? [json(100, 'Last prompt'), { type: 'assistant' as const, uuid: 'agent:101', message: {} }, { ...json(0, 'Another agent'), uuid: 'other:7' }]
      : Array.from({ length: 100 }, (_, index) => json(index, `Prompt ${index}`)))
    const result = await cursorHistory(runs(...Array.from({ length: 101 }, (_, index) => [reply(String(index))])), 'agent', '/w', undefined, messages)
    expect(messages.mock.calls).toEqual([['agent', { runtime: 'local', cwd: '/w', limit: 100, offset: 0 }], ['agent', { runtime: 'local', cwd: '/w', limit: 100, offset: 100 }]])
    expect(users(result.turns).slice(-4)).toEqual(['Prompt 99', '> 99', 'Last prompt', '> 100'])
  })
  it('stops backfilling past a run it could not read', async () => {
    const read = async () => ({ items: [
      { createdAt: 1, conversation: async () => [reply('old')] },
      { createdAt: 2, conversation: async (): Promise<ConversationTurn[]> => { throw new Error('unreadable') } },
      { createdAt: 3, conversation: async () => [reply('new')] },
    ] })
    const result = await cursorHistory(read, 'agent', '/w', undefined, async () => [prompt(0, 'Old'), prompt(1, 'Lost'), prompt(2, 'New')])
    expect(result.skipped).toBe(1)
    expect(users(result.turns)).toEqual(['> old', 'New', '> new'])
  })
  it('logs a messages failure and replays without partially loaded prompts', async () => {
    const log = vi.fn()
    const messages = vi.fn(async (_id: string, options: { offset?: number }) => {
      if (options.offset) throw new Error('messages unavailable')
      return Array.from({ length: 100 }, (_, index) => prompt(index, 'Partial'))
    })
    expect(await cursorHistory(runs([reply('Reply')]), 'agent', '/w', log, messages)).toEqual({ turns: [reply('Reply')], skipped: 0 })
    expect(log).toHaveBeenCalledWith("Couldn't load Cursor user messages: messages unavailable")
  })
})

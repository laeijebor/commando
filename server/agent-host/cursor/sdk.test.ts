import { describe, expect, it, vi } from 'vitest'
import type { ConversationTurn, SDKMessage } from '@cursor/sdk'
import { MAX_CHAT_ITEMS } from '../../../shared/agent-chat.js'
import { cloudStreamUpdates, cursorCloudHistory, cursorHistory, loadCursorSdk, type CursorCloudRun } from './sdk.js'
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
  const reply = (text: string, extra = 0): ConversationTurn => ({ type: 'agentConversationTurn', turn: { steps: [{ type: 'assistantMessage', message: { text } }, ...Array.from({ length: extra }, () => ({ type: 'thinkingMessage' as const, message: { text: '' } }))] } })
  const steered = (prompt: string, text: string): ConversationTurn => ({ type: 'agentConversationTurn', turn: { userMessage: { text: prompt }, steps: [{ type: 'assistantMessage', message: { text } }] } })
  const prompt = (index: number, text: string, steps = 1) => ({ type: 'user' as const, uuid: `agent:${index}`, message: { turn: { case: 'agentConversationTurn', value: { userMessage: { text }, steps: Array.from({ length: steps }, () => ({})) } } } })
  const runs = (...conversations: (ConversationTurn[] | { status: 'finished' | 'cancelled'; turns: ConversationTurn[] })[]) => async () => ({ items: conversations.map((entry, index) => {
    const { status, turns } = Array.isArray(entry) ? { status: 'finished' as const, turns: entry } : entry
    return { createdAt: index, status, conversation: async () => turns }
  }) })
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
      async () => [prompt(0, 'Before'), prompt(1, 'Opening', 0), prompt(2, 'Steer'), prompt(3, 'After')])
    expect(users(result.turns)).toEqual(['Before', '> before', 'Opening', 'Steer', '> both', 'After', '> after'])
  })
  it('accepts a cancelled run that saved fewer steps than its message, and one that saved no turn', async () => {
    const result = await cursorHistory(runs([reply('first')], { status: 'cancelled', turns: [reply('partial', 12)] }, { status: 'cancelled', turns: [] }), 'agent', '/w', undefined,
      async () => [prompt(0, 'First'), prompt(1, 'Partial', 15), prompt(2, 'Cancelled', 0)])
    expect(users(result.turns)).toEqual(['First', '> first', 'Partial', '> partial', 'Cancelled'])
  })
  it.each([
    { name: 'a steer does not match its message', read: runs([reply('old')], [steered('Steer', 'new')]), messages: [prompt(0, 'Old'), prompt(1, 'Opening', 0), prompt(2, 'Other')], expected: ['> old', 'Steer', '> new'] },
    { name: 'a finished run does not match its prompt', read: runs([reply('a')], [], [reply('c')]), messages: [prompt(0, 'A'), prompt(1, 'C')], expected: ['> a', 'C', '> c'] },
  ])('stops backfilling when $name instead of mislabelling older turns', async ({ read, messages, expected }) => {
    const log = vi.fn()
    expect(users((await cursorHistory(read, 'agent', '/w', log, async () => messages)).turns)).toEqual(expected)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Cursor history prompts stop here'))
  })
  it('reads messages in one call, ignoring other entries, and accepts their JSON form', async () => {
    const json = (index: number, text: string) => ({ type: 'user' as const, uuid: `agent:${index}`, message: { agentConversationTurn: { userMessage: { text }, steps: [{}] } } })
    const messages = vi.fn(async () => [json(0, 'First'), { type: 'assistant' as const, uuid: 'agent:1', message: {} }, { ...json(0, 'Another agent'), uuid: 'other:7' }, json(1, 'Second')])
    const result = await cursorHistory(runs([reply('1')], [reply('2')]), 'agent', '/w', undefined, messages)
    expect(messages.mock.calls).toEqual([['agent', { runtime: 'local', cwd: '/w' }]])
    expect(users(result.turns)).toEqual(['First', '> 1', 'Second', '> 2'])
  })
  it('stops backfilling past a run it could not read', async () => {
    const read = async () => ({ items: [
      { createdAt: 1, status: 'finished' as const, conversation: async () => [reply('old')] },
      { createdAt: 2, status: 'finished' as const, conversation: async (): Promise<ConversationTurn[]> => { throw new Error('unreadable') } },
      { createdAt: 3, status: 'finished' as const, conversation: async () => [reply('new')] },
    ] })
    const result = await cursorHistory(read, 'agent', '/w', undefined, async () => [prompt(0, 'Old'), prompt(1, 'Lost'), prompt(2, 'New')])
    expect(result.skipped).toBe(1)
    expect(users(result.turns)).toEqual(['> old', 'New', '> new'])
  })
  it('logs a messages failure and replays without prompts', async () => {
    const log = vi.fn()
    expect(await cursorHistory(runs([reply('Reply')]), 'agent', '/w', log, async () => { throw new Error('messages unavailable') })).toEqual({ turns: [reply('Reply')], skipped: 0 })
    expect(log).toHaveBeenCalledWith("Couldn't load Cursor user messages: messages unavailable")
  })
})

const cloudRun = (id: string, createdAt: number, turns: ConversationTurn[], extra: Partial<CursorCloudRun> = {}): CursorCloudRun => ({
  id, createdAt, status: 'finished', conversation: async () => turns, stream: async function* () {},
  wait: async () => ({ id, status: 'finished' }), cancel: async () => {}, ...extra,
})
describe('cursorCloudHistory', () => {
  it('reads four conversations concurrently while preserving chronology despite out-of-order completion', async () => {
    let active = 0; let peak = 0
    const completed: number[] = []
    const runs = Array.from({ length: 8 }, (_, index) => cloudRun(String(index), index, [], {
      conversation: async () => {
        active++; peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, (index % 4) * 5))
        active--; completed.push(index)
        return [turn(String(index))]
      },
    }))
    expect(await cursorCloudHistory(async () => ({ items: runs }), 'bc-agent')).toEqual({ turns: runs.map((_, index) => turn(String(index))), skipped: 0, runIds: runs.map((run) => run.id).reverse(), skippedRunning: [] })
    expect(peak).toBe(4)
    expect(completed[0]).not.toBe(7)
    expect(completed).toHaveLength(8)
  })
  it('pages cloud runs, orders by createdAt, keeps prompts, skips unreadable runs and selects the newest git info', async () => {
    const git = { repoUrl: 'https://github.com/acme/app', branch: 'cursor/new', prUrl: 'https://github.com/acme/app/pull/4' }
    const read = vi.fn(async (_id: string, options: { cursor?: string }) => options.cursor ? { items: [
      cloudRun('old', 1, [turn('Old prompt')], { git: { branches: [{ ...git, branch: 'cursor/old' }] } }),
      cloudRun('broken', 3, [], { conversation: async () => { throw new Error('unreadable') } }),
    ] } : { items: [cloudRun('new', 4, [turn('New prompt'), turn('Steer')]), cloudRun('middle', 2, [turn('Middle prompt')], { git: { branches: [git] } })], nextCursor: 'page2' })
    const log = vi.fn()
    expect(await cursorCloudHistory(read, 'bc-agent', log)).toEqual({ turns: [turn('Old prompt'), turn('Middle prompt'), turn('New prompt'), turn('Steer')], skipped: 1, runIds: ['new', 'broken', 'middle', 'old'], skippedRunning: [], git })
    expect(read.mock.calls).toEqual([['bc-agent', { runtime: 'cloud', limit: 100 }], ['bc-agent', { runtime: 'cloud', limit: 100, cursor: 'page2' }]])
    expect(log).toHaveBeenCalledWith("Couldn't load a Cursor run: unreadable")
  })
  it('keeps the newest mapped items and stops prefetching batches once the window is full', async () => {
    const old = vi.fn(async () => [turn('Old')])
    const newest = Array.from({ length: MAX_CHAT_ITEMS + 4 }, (_, i) => turn(String(i)))
    const log = vi.fn()
    expect(await cursorCloudHistory(async () => ({ items: [
      cloudRun('old', 1, [], { conversation: old }),
      cloudRun('prefetched', 2, [turn('Prefetched')]),
      cloudRun('unreadable', 3, [], { conversation: async () => { throw new Error('Outside the item window') } }),
      cloudRun('recent', 4, [turn('Recent')]), cloudRun('new', 5, newest),
    ] }), 'bc-agent', log)).toEqual({ turns: newest.slice(-MAX_CHAT_ITEMS), skipped: 0, runIds: ['new', 'recent', 'unreadable', 'prefetched', 'old'], skippedRunning: [] })
    expect(old).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    const full: ConversationTurn = { type: 'agentConversationTurn', turn: { steps: Array.from({ length: MAX_CHAT_ITEMS }, () => ({ type: 'assistantMessage', message: { text: 'Reply' } })) } }
    expect(await cursorCloudHistory(async () => ({ items: [cloudRun('new', 2, [turn('Older'), full])] }), 'bc-agent')).toEqual({ turns: [full], skipped: 0, runIds: ['new'], skippedRunning: [] })
  })
  it('reattaches the newest running run without reading its blocking conversation', async () => {
    const conversation = vi.fn(() => new Promise<ConversationTurn[]>(() => {}))
    const run = cloudRun('live', 2, [], { status: 'running', conversation })
    const read = async () => ({ items: [cloudRun('old', 1, [turn('Old')]), run] })
    expect(await cursorCloudHistory(read, 'bc-agent')).toEqual({ turns: [turn('Old')], skipped: 0, runIds: ['live', 'old'], skippedRunning: ['live'], running: { id: 'live' } })
    expect(conversation).not.toHaveBeenCalled()
  })
  it('does not read or reattach an older running run and rejects repeated cursors', async () => {
    const conversation = vi.fn(() => new Promise<ConversationTurn[]>(() => {}))
    expect(await cursorCloudHistory(async () => ({ items: [cloudRun('old', 1, [], { status: 'running', conversation }), cloudRun('new', 2, [turn('New')])] }), 'bc-agent')).toEqual({ turns: [turn('New')], skipped: 0, runIds: ['new', 'old'], skippedRunning: ['old'] })
    expect(conversation).not.toHaveBeenCalled()
    await expect(cursorCloudHistory(async () => ({ items: [], nextCursor: 'same' }), 'bc-agent')).rejects.toThrow('repeated')
  })
  it('reports every skipped running run oldest first across pages', async () => {
    const conversation = vi.fn(() => new Promise<ConversationTurn[]>(() => {}))
    const read = vi.fn(async (_id: string, options: { cursor?: string }) => options.cursor
      ? { items: [cloudRun('old-live', 1, [], { status: 'running', conversation })] }
      : { items: [cloudRun('new-live', 3, [], { status: 'running', conversation }), cloudRun('middle', 2, [turn('Middle')])], nextCursor: 'older' })
    expect(await cursorCloudHistory(read, 'bc-agent')).toEqual({
      turns: [turn('Middle')], skipped: 0, runIds: ['new-live', 'middle', 'old-live'],
      skippedRunning: ['old-live', 'new-live'], running: { id: 'new-live' },
    })
    expect(conversation).not.toHaveBeenCalled()
  })
})

describe('cloud SDK wiring', () => {
  it('routes history and reattachment to cloud APIs without loading the real SDK', async () => {
    const run = cloudRun('run-cloud', 1, [turn('Cloud prompt')])
    const listRuns = vi.fn(async () => ({ items: [run] }))
    const getRun = vi.fn(async () => run)
    const get = vi.fn(async () => ({ agentId: 'bc-agent', env: { type: 'cloud', name: 'App Dev' }, repos: ['https://github.com/actual/environment'] }))
    vi.doMock('@cursor/sdk', () => ({ Agent: { listRuns, getRun, get }, Cursor: {} }))
    try {
      const sdk = await loadCursorSdk()
      expect(await sdk.get('bc-agent')).toMatchObject({ env: { name: 'App Dev' }, repos: ['https://github.com/actual/environment'] })
      expect(get).toHaveBeenCalledExactlyOnceWith('bc-agent')
      expect(await sdk.cloudHistory('bc-agent')).toEqual({ turns: [turn('Cloud prompt')], skipped: 0, runIds: ['run-cloud'], skippedRunning: [] })
      expect(listRuns).toHaveBeenCalledWith('bc-agent', { runtime: 'cloud', limit: 100 })
      expect(await sdk.latestCloudRun('bc-agent')).toBe(run)
      expect(listRuns).toHaveBeenLastCalledWith('bc-agent', { runtime: 'cloud', limit: 1 })
      expect(await sdk.getRun('run-cloud', 'bc-agent')).toBe(run)
      expect(getRun).toHaveBeenCalledWith('run-cloud', { runtime: 'cloud', agentId: 'bc-agent' })
    } finally { vi.doUnmock('@cursor/sdk') }
  })
})

describe('independent newest cloud run lookup', () => {
  it.each(['page', 'conversation'] as const)('finds the newest run even when an older %s fails', async (failure) => {
    const conversation = vi.fn(async (): Promise<ConversationTurn[]> => { throw new Error('Must not read the active conversation') })
    const latest = cloudRun('run-latest', 2, [], { status: 'running', conversation })
    const olderConversation = vi.fn(async (): Promise<ConversationTurn[]> => { throw new Error('Older conversation unavailable') })
    const listRuns = vi.fn(async (_id: string, options: { limit?: number; cursor?: string }) => {
      if (options.limit === 1) return { items: [latest], nextCursor: 'older' }
      if (options.cursor) throw new Error('Older page unavailable')
      return failure === 'page' ? { items: [latest], nextCursor: 'older' }
        : { items: [latest, cloudRun('run-older', 1, [], { conversation: olderConversation })] }
    })
    vi.doMock('@cursor/sdk', () => ({ Agent: { listRuns }, Cursor: {} }))
    try {
      const sdk = await loadCursorSdk()
      if (failure === 'page') await expect(sdk.cloudHistory('bc-agent')).rejects.toThrow('Older page unavailable')
      else expect(await sdk.cloudHistory('bc-agent')).toMatchObject({ turns: [], skipped: 1 })
      listRuns.mockClear()
      expect(await sdk.latestCloudRun('bc-agent')).toBe(latest)
      expect(listRuns.mock.calls).toEqual([['bc-agent', { runtime: 'cloud', limit: 1 }]])
      expect(conversation).not.toHaveBeenCalled()
      expect(olderConversation).toHaveBeenCalledTimes(failure === 'conversation' ? 1 : 0)
    } finally { vi.doUnmock('@cursor/sdk') }
  })

  it('returns no run for an empty cloud chat', async () => {
    const listRuns = vi.fn(async () => ({ items: [] }))
    vi.doMock('@cursor/sdk', () => ({ Agent: { listRuns }, Cursor: {} }))
    try {
      const sdk = await loadCursorSdk()
      expect(await sdk.latestCloudRun('bc-agent')).toBeUndefined()
      expect(listRuns).toHaveBeenCalledExactlyOnceWith('bc-agent', { runtime: 'cloud', limit: 1 })
    } finally { vi.doUnmock('@cursor/sdk') }
  })
})

describe('cloudStreamUpdates', () => {
  const envelope = { agent_id: 'bc-agent', run_id: 'run-cloud' }
  it('maps thinking and assistant chunks in order, including assistant tool_use blocks', () => {
    expect(cloudStreamUpdates({ ...envelope, type: 'thinking', text: 'Think', thinking_duration_ms: 10 })).toEqual([{ type: 'thinking-delta', text: 'Think' }])
    const message: SDKMessage = { ...envelope, type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Before' }, { type: 'tool_use', id: 's', name: 'shell', input: { command: 'pwd' } }, { type: 'text', text: 'After' },
    ] } }
    expect(cloudStreamUpdates(message)).toEqual([
      { type: 'text-delta', text: 'Before' }, { type: 'tool-call-started', callId: 's', toolCall: { type: 'shell', args: { command: 'pwd' } } }, { type: 'text-delta', text: 'After' },
    ])
    expect(message.message.content[0]).toEqual({ type: 'text', text: 'Before' })
    expect(cloudStreamUpdates({ ...envelope, type: 'assistant', message: { role: 'assistant', content: [] } })).toEqual([])
  })
  it('maps running, completed and failed tools to the mapper tool-call shapes', () => {
    const base = { ...envelope, type: 'tool_call' as const, call_id: 's', name: 'shell', args: { command: 'pwd' } }
    expect(cloudStreamUpdates({ ...base, status: 'running' })).toEqual([{ type: 'tool-call-started', callId: 's', toolCall: { type: 'shell', args: base.args } }])
    const result = { status: 'success', value: { stdout: '/cloud', stderr: '' } }
    expect(cloudStreamUpdates({ ...base, status: 'completed', result })).toEqual([{ type: 'tool-call-completed', callId: 's', toolCall: { type: 'shell', args: base.args, result } }])
    expect(cloudStreamUpdates({ ...base, status: 'error', result: 'Denied' })).toEqual([{ type: 'tool-call-completed', callId: 's', toolCall: { type: 'shell', args: base.args, result: { status: 'error', error: 'Denied' } } }])
    expect(cloudStreamUpdates({ ...base, status: 'error', result: { status: 'error', error: 'Failed' } })).toEqual([{ type: 'tool-call-completed', callId: 's', toolCall: { type: 'shell', args: base.args, result: { status: 'error', error: 'Failed' } } }])
    expect(cloudStreamUpdates({ ...envelope, type: 'tool_call', call_id: 's', name: 'shell', status: 'completed', result: { stdout: 'Raw' } }))
      .toEqual([{ type: 'tool-call-completed', callId: 's', toolCall: { type: 'shell', result: { status: 'success', value: { stdout: 'Raw' } } } }])
    expect(cloudStreamUpdates({ ...envelope, type: 'tool_call', call_id: 's', name: 'shell', status: 'running' }))
      .toEqual([{ type: 'tool-call-started', callId: 's', toolCall: { type: 'shell' } }])
  })
  it('ignores status, usage, system, task, request and user messages', () => {
    const messages: SDKMessage[] = [
      { ...envelope, type: 'status', status: 'FINISHED' }, { ...envelope, type: 'system', subtype: 'init' },
      { ...envelope, type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 } }, { ...envelope, type: 'task', text: 'Task text' },
      { ...envelope, type: 'request', request_id: 'request-1' }, { ...envelope, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Ignored' }] } },
    ]
    expect(messages.flatMap(cloudStreamUpdates)).toEqual([])
  })
  it('feeds the existing mapper without duplicating text chunks or tool rows', () => {
    const mapper = new CursorItemMapper()
    mapper.begin('stream')
    const messages: SDKMessage[] = [
      { ...envelope, type: 'thinking', text: 'Think' }, { ...envelope, type: 'thinking', text: ' more' },
      { ...envelope, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
      { ...envelope, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ' world' }] } },
      { ...envelope, type: 'tool_call', call_id: 's', name: 'shell', status: 'running', args: { command: 'false' } },
      { ...envelope, type: 'tool_call', call_id: 's', name: 'shell', status: 'error', args: { command: 'false' }, result: { status: 'error', error: 'Denied' } },
    ]
    messages.flatMap(cloudStreamUpdates).forEach((update) => mapper.delta(update))
    expect(mapper.list()).toMatchObject([
      { kind: 'reasoning', text: 'Think more', status: 'completed' }, { kind: 'assistant_message', text: 'Hello world', status: 'completed' },
      { kind: 'command', command: 'false', status: 'failed', isError: true, output: '"Denied"' },
    ])
  })
})

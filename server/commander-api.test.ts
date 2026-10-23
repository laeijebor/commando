import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatSessionInfo } from '../shared/agent-chat.js'
import type { AgentStatus, CommandoSnapshot, SessionBrief } from '../shared/protocol.js'
import type { TurnBrief } from '../shared/commander.js'
import { boundedTurns, chatTurns, claudeTranscriptTurns, CommanderApi } from './commander-api.js'
const TOKEN = 'commander-agent-token-at-least-32-characters'
const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
function setup() {
  const commander = { targetId: 'commander', paneId: '%9' }
  const snapshot = { panes: [
    { id: '%9', targetId: 'commander', sessionId: '$9', path: '/commander' },
    { id: '%1', targetId: 'agent', sessionId: '$1', path: '/repo', title: 'Pane title', chatTitle: 'Chat title' },
    { id: '%2', targetId: 'shell', sessionId: '$1', path: '/shell' },
  ], sessions: [{ id: '$1', name: 'work' }] } as unknown as CommandoSnapshot
  const statuses = new Map<string, AgentStatus>([['%1', { paneId: '%1', provider: 'claude', status: 'done', source: 'hook', updatedAt: 100, settledAt: 100, agentSessionId: 'session-id' } as AgentStatus]])
  let chat = false, stalled = false, nudge = true, worklog: SessionBrief | undefined, brief: TurnBrief | undefined
  const enqueue = vi.fn(async (input) => ({ id: 'abc', ...input, status: 'queued' } as never)), cancel = vi.fn(async () => ({ id: 'abc' } as never))
  const screen = vi.fn(async () => '\x1b[31mRendered output\x1b[0m'), items: ChatItem[] = []
  const ensure = vi.fn(async () => commander), forget = vi.fn(async () => {}), switchProfile = vi.fn(async (configDir: string | null) => ({ ...commander, ...(configDir ? { configDir } : {}) })), configDir = vi.fn(async (): Promise<string | undefined> => undefined)
  const releaseNudge = vi.fn(), codexRollout = vi.fn(async (_id: string): Promise<string | undefined> => undefined)
  const api = new CommanderApi({
    agentToken: TOKEN, ownerAuthorized: async (r) => r.headers.authorization === 'Bearer owner', snapshot: () => snapshot,
    status: (id) => statuses.get(id), commander: { state: () => commander, ensure, forget, switchProfile },
    claudeProfiles: async () => [{ name: 'claudew', configDir: '/h/.claudew' }],
    relays: { enqueue, cancel, values: () => [] }, stalls: { stalled: () => stalled, check: async () => {}, takeNudge: () => nudge, releaseNudge },
    brief: () => brief, sessionBrief: () => worklog, chatSession: () => chat ? { title: 'Session title', provider: 'claude' } as ChatSessionInfo : undefined,
    owns: () => chat, items: () => items, seen: () => ({ '%1': 50 }), configDir, screen, codexRollout,
    now: () => 0,
  })
  async function call(method: string, path: string, value?: unknown, token = TOKEN, pane = '%9') {
    const request = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]) as IncomingMessage
    request.method = method; request.headers = { authorization: `Bearer ${token}`, 'x-commando-pane': pane, 'content-type': 'application/json' }
    let status = 0, result: any
    const response = new EventEmitter() as ServerResponse
    response.writeHead = ((code: number) => { status = code; return response }) as never
    response.end = ((raw: string) => { result = JSON.parse(raw); return response }) as never
    const handled = await api.handle(request, response, new URL(`http://localhost/api/commander${path}`))
    return { status, result, handled }
  }
  return { releaseNudge, codexRollout, api, call, snapshot, statuses, enqueue, cancel, screen, items, ensure, forget, switchProfile, configDir,
    chat: () => { chat = true }, stalled: (v: boolean) => { stalled = v }, nudge: (v: boolean) => { nudge = v },
    worklog: (v: SessionBrief) => { worklog = v }, brief: (v: TurnBrief) => { brief = v } }
}
describe('CommanderApi', () => {
  it('requires agent token, live caller pane and Commander target identity', async () => {
    const s = setup()
    expect((await s.call('GET', '/agent/list', undefined, 'bad')).status).toBe(401)
    expect((await s.call('GET', '/agent/list', undefined, TOKEN, 'bad')).status).toBe(400)
    expect((await s.call('GET', '/agent/list', undefined, TOKEN, '%99')).status).toBe(404)
    expect((await s.call('GET', '/agent/list', undefined, TOKEN, '%1')).status).toBe(403)
    expect((await s.call('POST', '', undefined, TOKEN)).status).toBe(401)
    expect((await s.call('POST', '', undefined, 'owner')).result).toMatchObject({ ok: true, state: { targetId: 'commander' } })
    expect((await s.call('DELETE', '', undefined, 'owner')).status).toBe(200)
    expect(s.forget).toHaveBeenCalledOnce()
  })
  it('switches the owner\'s Commander to a known Claude profile or the default login, and nothing else', async () => {
    const s = setup()
    expect((await s.call('PUT', '/profile', { configDir: '/h/.claudew' }, TOKEN)).status).toBe(401)
    expect(await s.call('PUT', '/profile', { configDir: '/etc' }, 'owner')).toMatchObject({ status: 400, result: { error: 'Unknown Claude profile' } })
    expect((await s.call('PUT', '/profile', { configDir: 7 }, 'owner')).status).toBe(400)
    expect(s.switchProfile).not.toHaveBeenCalled()
    expect((await s.call('PUT', '/profile', { configDir: '/h/.claudew' }, 'owner')).result).toEqual({ ok: true, state: { targetId: 'commander', paneId: '%9', configDir: '/h/.claudew' } })
    expect((await s.call('PUT', '/profile', { configDir: null }, 'owner')).status).toBe(200)
    expect(s.switchProfile.mock.calls).toEqual([['/h/.claudew'], [null]])
  })
  it('lists every agent excluding Commander, derives needs-you/unread and respects title precedence', async () => {
    const s = setup()
    let result = (await s.call('GET', '/agent/list')).result
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ title: 'Chat title', unread: true, needsYou: false, sessionName: 'work' })
    s.chat(); s.worklog({ title: 'Worklog title' } as SessionBrief); s.brief({ kind: 'needs_you', endedAt: 100 } as TurnBrief); s.stalled(true)
    result = (await s.call('GET', '/agent/list')).result
    expect(result.find((a: any) => a.paneId === '%1')).toMatchObject({ title: 'Worklog title', needsYou: true, stalled: true })
    expect(result.some((a: any) => a.paneId === '%9')).toBe(false)
  })
  it('ignores a needs-you brief from a superseded turn', async () => {
    const s = setup(); s.brief({ kind: 'needs_you', endedAt: 100 } as TurnBrief)
    const agent = async () => (await s.call('GET', '/agent/list')).result.find((a: any) => a.paneId === '%1')
    expect(await agent()).toMatchObject({ needsYou: true })
    s.statuses.set('%1', { ...s.statuses.get('%1')!, status: 'working', updatedAt: 200 })
    expect(await agent()).toMatchObject({ needsYou: false, status: 'working' })
    s.statuses.set('%1', { ...s.statuses.get('%1')!, status: 'done', updatedAt: 300, settledAt: 300 })
    expect(await agent()).toMatchObject({ needsYou: false, status: 'done' })
  })
  it('matches a chat pane brief to its done run by settledAt', async () => {
    const s = setup(); s.chat(); s.brief({ kind: 'needs_you', endedAt: 100 } as TurnBrief)
    const agent = async () => (await s.call('GET', '/agent/list')).result.find((a: any) => a.paneId === '%1')
    s.statuses.set('%1', { ...s.statuses.get('%1')!, details: { recentActivities: [], checks: [], recap: { completedAt: 90, summary: 'x', outcome: 'done' } } } as AgentStatus)
    expect(await agent()).toMatchObject({ needsYou: true })
    s.statuses.set('%1', { ...s.statuses.get('%1')!, settledAt: 300, updatedAt: 300 })
    expect(await agent()).toMatchObject({ needsYou: false })
  })
  it('keeps inbox words verbatim, tags agent relays/nudges and allows steering only via its explicit flag', async () => {
    const s = setup(), text = '  exact\nuser words\t'
    await s.call('POST', '/relays', { paneId: '%1', text }, 'owner')
    expect(s.enqueue).toHaveBeenLastCalledWith({ paneId: '%1', text, origin: 'inbox', kind: 'relay', delivery: 'queue' })
    await s.call('POST', '/agent/relay', { pane: '%1', text, steer: true })
    expect(s.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ text: '[relayed by Commander] ' + text, delivery: 'steer' }))
    expect((await s.call('POST', '/agent/nudge', { pane: '%1', text })).status).toBe(409)
    s.stalled(true)
    expect((await s.call('POST', '/agent/nudge', { pane: '%1', text })).status).toBe(200)
    expect(s.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'nudge', text: '[nudge from Commander] ' + text, delivery: 'queue' }))
    s.nudge(false)
    expect((await s.call('POST', '/agent/nudge', { pane: '%1', text })).status).toBe(429)
  })
  it('validates relay inputs, limits and cancellation paths', async () => {
    const s = setup()
    for (const text of ['', 'x'.repeat(4001), 'bad\x00']) expect((await s.call('POST', '/agent/relay', { pane: '%1', text })).status).toBe(400)
    expect((await s.call('POST', '/agent/relay', { pane: '%2', text: 'hello' })).status).toBe(404)
    expect((await s.call('POST', '/agent/relay', { pane: '%1', text: 'hello', steer: 'yes' })).status).toBe(400)
    for (let i = 0; i < 30; i++) expect((await s.call('POST', '/agent/relay', { pane: '%1', text: 'hello' })).status).toBe(200)
    expect((await s.call('POST', '/agent/relay', { pane: '%1', text: 'hello' })).status).toBe(429)
    expect((await s.call('GET', '/agent/relays?limit=201')).status).toBe(400)
    expect((await s.call('GET', '/agent/relays')).result).toEqual([])
    expect((await s.call('POST', '/agent/relays/abc/cancel')).status).toBe(200)
  })
  it('reads hosted turns or ANSI-free screen tails and validates turn count', async () => {
    const s = setup()
    expect((await s.call('GET', '/agent/read?pane=%251&turns=3')).result).toMatchObject({ source: 'screen', turns: [{ assistant: 'Rendered output' }] })
    expect((await s.call('GET', '/agent/read?pane=%251&turns=11')).status).toBe(400)
    s.chat(); s.items.push({ kind: 'user_message', turnId: 'one', text: 'User' } as ChatItem, { kind: 'assistant_message', turnId: 'one', text: 'Assistant' } as ChatItem)
    expect((await s.call('GET', '/agent/read?pane=%251')).result).toMatchObject({ source: 'chat', turns: [{ user: 'User', assistant: 'Assistant' }] })
  })
  it('reads a real temporary Claude project/session JSONL layout, filtering tool results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commander-transcript-')); dirs.push(dir)
    const project = join(dir, 'projects', '-repo'); await mkdir(project, { recursive: true })
    const rows = [
      { type: 'user', message: { content: 'Fix it' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Inspecting' }, { type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'not a new user turn' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } },
    ]
    await writeFile(join(project, 'session-id.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const s = setup(); s.configDir.mockResolvedValue(dir)
    expect((await s.call('GET', '/agent/read?pane=%251')).result).toMatchObject({ source: 'transcript', turns: [{ user: 'Fix it', assistant: 'Inspecting\nDone' }] })
    expect(s.screen).not.toHaveBeenCalled()
    const file = join(project, 'large.jsonl')
    await writeFile(file, 'x'.repeat(300_000) + '\n' + rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    expect(await claudeTranscriptTurns(file)).toEqual([{ user: 'Fix it', assistant: 'Inspecting\nDone' }])
  })
})
it('bounds combined turn text to 8000 characters, keeping the newest text', () => {
  const result = boundedTurns([{ user: 'old', assistant: 'older' }, { user: 'u'.repeat(6000), assistant: 'a'.repeat(6000) }], 10)
  expect(result).toHaveLength(1)
  expect(result.reduce((sum, turn) => sum + (turn.user?.length ?? 0) + turn.assistant.length, 0)).toBe(8000)
  expect(chatTurns([{ kind: 'assistant_message', parentToolUseId: 'subagent', text: 'private subagent', turnId: 'one' } as ChatItem])).toEqual([])
})

it('rejects the agent token on both owner relay routes', async () => {
  const s = setup()
  expect((await s.call('POST', '/relays', { paneId: '%1', text: 'hello' })).status).toBe(401)
  expect((await s.call('POST', '/relays/abc/cancel')).status).toBe(401)
  expect(s.enqueue).not.toHaveBeenCalled(); expect(s.cancel).not.toHaveBeenCalled()
})
it.each(['relay', 'nudge'])('rejects %s to Commander itself through the agent API', async (command) => {
  const s = setup(); s.stalled(true)
  expect((await s.call('POST', '/agent/' + command, { pane: '%9', text: 'self' })).status).toBe(404)
  expect(s.enqueue).not.toHaveBeenCalled()
})
it('logs unexpected failures before 502 and releases failed nudge reservations', async () => {
  const s = setup(); s.stalled(true)
  const error = new Error('Journal unavailable'), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  s.enqueue.mockRejectedValueOnce(error)
  expect((await s.call('POST', '/agent/nudge', { pane: '%1', text: 'Continue' }))).toMatchObject({ status: 502, result: { error: 'Journal unavailable' } })
  expect(s.releaseNudge).toHaveBeenCalledExactlyOnceWith('agent')
  expect(log).toHaveBeenCalledExactlyOnceWith('[commando] Commander request failed', error)
  log.mockClear()
  expect((await s.call('POST', '/agent/nudge', { pane: '%1', text: '' })).status).toBe(400)
  expect(log).not.toHaveBeenCalled()
})

describe('reading-pane transcripts', () => {
  const line = (uuid: string, parentUuid: string | null, type: string, content: unknown, extra = {}) =>
    JSON.stringify({ uuid, parentUuid, type, message: type === 'assistant' ? { id: `m-${uuid}`, content } : { content }, ...extra })
  it('is owner-only and returns a Claude terminal agent\'s turns as chat items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commander-reading-')); dirs.push(dir)
    const project = join(dir, 'projects', '-repo'); await mkdir(project, { recursive: true })
    await writeFile(join(project, 'session-id.jsonl'), [
      line('u1', null, 'user', 'Fix the login bug'),
      line('a1', 'u1', 'assistant', [{ type: 'text', text: 'Fixed it.' }]),
    ].join('\n') + '\n')
    const s = setup(); s.configDir.mockResolvedValue(dir)
    expect((await s.call('GET', '/transcript?pane=%251')).status).toBe(401)
    const { result } = await s.call('GET', '/transcript?pane=%251', undefined, 'owner')
    expect(result).toMatchObject({ ok: true, source: 'transcript' })
    expect(result.items.map((item: ChatItem) => [item.kind, 'text' in item ? item.text : ''])).toEqual([['user_message', 'Fix the login bug'], ['assistant_message', 'Fixed it.']])
    expect((await s.call('GET', '/transcript?pane=%252', undefined, 'owner')).status).toBe(404)
  })
  it('reads a Codex rollout by session id and falls back to the ANSI-free screen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'commander-reading-')); dirs.push(dir)
    const rollout = join(dir, 'rollout.jsonl')
    const event = (item: unknown) => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-20T10:00:00Z', payload: { type: 'item_completed', item } })
    await writeFile(rollout, [
      event({ type: 'UserMessage', content: [{ type: 'text', text: 'Add tests' }] }),
      event({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'npm test'] }),
      event({ type: 'AgentMessage', content: [{ type: 'text', text: 'Tests added.' }] }),
    ].join('\n') + '\n')
    const s = setup()
    s.statuses.set('%1', { ...s.statuses.get('%1')!, provider: 'codex', agentSessionId: 'thread-1' })
    s.codexRollout.mockResolvedValue(rollout)
    const { result } = await s.call('GET', '/transcript?pane=%251', undefined, 'owner')
    expect(s.codexRollout).toHaveBeenCalledWith('thread-1')
    expect(result.items.map((item: ChatItem) => item.kind)).toEqual(['user_message', 'command', 'assistant_message'])
    expect(result.items[1]).toMatchObject({ command: 'npm test' })
    s.codexRollout.mockResolvedValue(undefined)
    expect((await s.call('GET', '/transcript?pane=%251', undefined, 'owner')).result).toMatchObject({ source: 'screen', items: [], screen: 'Rendered output' })
  })
})

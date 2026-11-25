import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_HOST_PROTOCOL_VERSION, type ChatItem, type ChatProvider, type ChatSessionInfo } from '../../shared/agent-chat.js'
import { AsideStore, ChatAsides } from './asides.js'
import { asideBrief, asideEnv } from './aside-brief.js'
import type { ChatProviderSession, ChatProviderSessionEvents } from './provider.js'
import type { AgentSessionSpec } from './session.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const item = (kind: 'user_message' | 'assistant_message', text: string): ChatItem => ({ id: text, kind, text, turnId: 't', createdAt: 1, updatedAt: 1, status: 'completed' })
function fake(spec: AgentSessionSpec, provider: ChatProvider = 'claude') {
  let info: ChatSessionInfo = { paneId: spec.paneId, provider, cwd: '/work', status: 'idle', sessionId: spec.resume ?? (spec.aside ? `child-${spec.aside.id}` : 'main-session'), hostPid: 1, hostVersion: AGENT_HOST_PROTOCOL_VERSION, permissionMode: spec.permissionMode, ...(spec.aside ? { aside: spec.aside } : {}) }
  let items = [item('user_message', 'Main goal'), item('assistant_message', 'Main context')]
  const listeners: { [K in keyof ChatProviderSessionEvents]: ChatProviderSessionEvents[K][] } = { items: [], session: [], commands: [], closed: [], restart: [] }
  const session: ChatProviderSession = {
    paneId: spec.paneId, commands: [], busy: false, queued: [],
    on: (event, listener) => { listeners[event].push(listener) },
    forkPoint: () => info.sessionId ? { sessionId: info.sessionId, at: 'finished-turn' } : null,
    start: vi.fn(async () => {}), send: vi.fn(), updateQueue: vi.fn(), interrupt: vi.fn(async () => {}),
    close: vi.fn(), configure: vi.fn(async () => {}), answer: vi.fn(() => false),
    searchFiles: vi.fn(async () => ({ entries: [], truncated: false })),
    controlTask: vi.fn(async () => {}), subagentTranscript: vi.fn(async () => ({ items: [] })), setResumeCommand: vi.fn(),
    snapshot: () => ({ session: { ...info }, items }),
  }
  return { session, set: (change: Partial<ChatSessionInfo>) => { info = { ...info, ...change }; listeners.session.forEach((listener) => listener(info)) }, setItems: (value: ChatItem[]) => { items = value } }
}
async function setup(provider: ChatProvider = 'claude') {
  const directory = await mkdtemp(join(tmpdir(), 'commando-asides-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new AsideStore(directory)
  const spec: AgentSessionSpec = { paneId: '%4', cwd: '/work', permissionMode: 'bypassPermissions', env: { TMUX_PANE: '%4', COMMANDO_CHAT_RESUME: 'main resume', COMMANDO_CHAT_RESUME_B64: 'abc' }, initialPrompt: 'do not replay', fullAccess: true }
  const main = fake(spec, provider)
  const created: ReturnType<typeof fake>[] = []
  const factory = vi.fn(async (p: ChatProvider, s: AgentSessionSpec) => { const child = fake(s, p); created.push(child); return child.session })
  const host = { add: vi.fn(), remove: vi.fn(), changed: vi.fn(), log: vi.fn() }
  const manager = new ChatAsides(main.session, spec, host, store, factory)
  cleanups.push(async () => { manager.stop() })
  return { directory, store, spec, main, factory, created, host, manager }
}

describe('chat asides', () => {
  it('forks from the completed point, defaults to read-only and isolates child env', async () => {
    const { manager, factory, main, created, store } = await setup()
    const result = await manager.act({ action: 'open', text: 'Side question\nwith details' })
    expect(result.ok).toBe(true)
    const record = manager.list()[0]!
    expect(record).toMatchObject({ title: 'Side question', mode: 'read-only', method: 'fork', forkedFrom: { sessionId: 'main-session', at: 'finished-turn' }, sessionId: `child-${result.asideId}` })
    expect(factory.mock.calls[0]?.[1]).toMatchObject({ paneId: `%4~${record.id}`, fork: record.forkedFrom, readOnly: true, permissionMode: 'default', bypassAllowed: false, initialPrompt: undefined, resumeCommand: undefined, env: { COMMANDO_ASIDE: record.id } })
    expect(factory.mock.calls[0]?.[1].env).not.toHaveProperty('TMUX_PANE')
    expect(factory.mock.calls[0]?.[1].env).not.toHaveProperty('COMMANDO_CHAT_RESUME_B64')
    expect(created[0]?.session.send).toHaveBeenCalledWith('Side question\nwith details', undefined)
    expect(main.session.send).not.toHaveBeenCalled()
    expect(await store.load('main-session')).toEqual(manager.list())
  })
  it.each(['cursor', 'muse'] as const)('seeds %s with a brief and reports its read-only enforcement', async (provider) => {
    const { manager, factory, created } = await setup(provider)
    await manager.act({ action: 'open', text: 'Why?' })
    expect(manager.list()[0]).toMatchObject({ method: 'brief', readOnlyEnforced: provider === 'muse' })
    expect(factory.mock.calls[0]?.[1].fork).toBeUndefined()
    expect(created[0]?.session.send).toHaveBeenCalledWith(expect.stringContaining('Main context\n\n---\nWhy?'), undefined)
    expect(created[0]?.session.send).toHaveBeenCalledWith(expect.stringContaining('commando-pr-marker'), undefined)
  })
  it('caps open asides, closes separately, resumes, changes mode and reforks', async () => {
    const { manager, factory, created, main } = await setup()
    for (let i = 0; i < 5; i++) expect((await manager.act({ action: 'open', text: `Question ${i}` })).ok).toBe(true)
    expect(await manager.act({ action: 'open', text: 'Six' })).toMatchObject({ ok: false, error: expect.stringContaining('5 open') })
    const record = manager.list()[0]!
    await manager.act({ action: 'close', asideId: record.id })
    expect(created[0]?.session.interrupt).toHaveBeenCalled()
    expect(created[0]?.session.close).toHaveBeenCalled()
    expect(main.session.close).not.toHaveBeenCalled()
    expect(manager.list()[0]).toMatchObject({ status: 'closed', closedAt: expect.any(Number) })
    await manager.act({ action: 'mode', asideId: record.id, mode: 'inherit' })
    expect(factory).toHaveBeenCalledTimes(5)
    await manager.act({ action: 'reopen', asideId: record.id })
    expect(factory.mock.calls.at(-1)?.[1]).toMatchObject({ resume: record.sessionId, readOnly: false, permissionMode: 'bypassPermissions' })
    await manager.act({ action: 'mode', asideId: record.id, mode: 'read-only' })
    expect(factory.mock.calls.at(-1)?.[1]).toMatchObject({ resume: record.sessionId, readOnly: true })
    await manager.act({ action: 'refork', asideId: record.id })
    expect(factory.mock.calls.at(-1)?.[1]).toMatchObject({ resume: undefined, fork: { sessionId: 'main-session', at: 'finished-turn' } })
    expect(manager.list()[0]).toMatchObject({ id: record.id, title: record.title, status: 'open' })
  })
  it('restores open sessions and closed records, switches storage on clear, and ignores stale child updates', async () => {
    const { manager, store, main, created, host, spec, factory } = await setup()
    await manager.act({ action: 'open', text: 'First' })
    await manager.act({ action: 'open', text: 'Second' })
    const [open, closed] = manager.list()
    await manager.act({ action: 'close', asideId: closed!.id })
    manager.stop()
    const restored = new ChatAsides(main.session, spec, host, store, factory)
    cleanups.push(async () => restored.stop())
    await restored.sync()
    expect(restored.list()).toMatchObject([{ id: open!.id, status: 'open' }, { id: closed!.id, status: 'closed' }])
    expect(factory.mock.calls.at(-1)?.[1]).toMatchObject({ resume: open!.sessionId, fork: undefined })
    main.set({ sessionId: 'new-main' })
    await restored.sync()
    expect(restored.list()).toEqual([])
    created[0]?.set({ sessionId: 'stale-id' })
    expect((await store.load('main-session'))[0]?.sessionId).toBe(open!.sessionId)
    expect(await store.load('new-main')).toEqual([])
  })
  it('rejects unsaved main conversations and bad saved data without overwriting it', async () => {
    const { manager, main, directory, factory } = await setup()
    main.set({ sessionId: undefined })
    expect(await manager.act({ action: 'open', text: 'Why?' })).toEqual({ ok: false, error: 'This chat has no saved conversation yet' })
    main.set({ sessionId: 'broken' })
    await writeFile(join(directory, 'broken.json'), '{broken')
    expect((await manager.act({ action: 'open', text: 'Why?' })).ok).toBe(false)
    expect(factory).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual(['broken.json'])
  })
  it('serializes concurrent opens and preserves closed records without a TTL', async () => {
    const { manager, store } = await setup()
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => manager.act({ action: 'open', text: `Q${i}` })))
    expect(results.filter((result) => result.ok)).toHaveLength(5)
    for (const record of manager.list()) await manager.act({ action: 'close', asideId: record.id })
    expect((await store.load('main-session')).filter((record) => record.status === 'closed')).toHaveLength(5)
  })
})

describe('aside brief and env', () => {
  it('keeps the goal, recent dialogue in order and unique file paths within its budget', () => {
    const change: ChatItem = { id: 'file', turnId: 't', kind: 'file_change', path: 'file.ts', toolUseId: 'tool', toolName: 'Write', additions: 1, deletions: 0, createdAt: 1, updatedAt: 1, status: 'completed' }
    const text = asideBrief([item('user_message', 'Goal'), item('assistant_message', 'x'.repeat(10000)), item('user_message', 'Recent'), item('assistant_message', 'Latest'), change, change], 'read-only')
    expect(text.length).toBeLessThanOrEqual(8000)
    expect(text).toContain('Goal: Goal')
    expect(text.indexOf('User: Recent')).toBeLessThan(text.indexOf('Assistant: Latest'))
    expect(text.match(/file.ts/g)).toHaveLength(1)
    expect(text).toContain('Do not modify files')
    expect(text).toContain('Do not set pane titles or headlines')
    const env = asideEnv({ TMUX_PANE: '%4', COMMANDO_CHAT_RESUME: 'x', COMMANDO_CHAT_RESUME_B64: 'eA==', PATH: '/bin' }, 'abcd1234')
    expect(env).toMatchObject({ COMMANDO_ASIDE: 'abcd1234', PATH: '/bin' })
    expect(env).not.toHaveProperty('TMUX_PANE')
    expect(env).not.toHaveProperty('COMMANDO_CHAT_RESUME')
  })
})

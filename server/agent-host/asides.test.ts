import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_HOST_PROTOCOL_VERSION, type ChatItem, type ChatProvider, type ChatSessionInfo } from '../../shared/agent-chat.js'
import { AsideStore, ChatAsides } from './asides.js'
import { asideBrief, asideEnv, asideInstructions } from './aside-brief.js'
import type { ChatProviderSession, ChatProviderSessionEvents } from './provider.js'
import type { AgentSessionSpec } from './session.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const item = (kind: 'user_message' | 'assistant_message', text: string): ChatItem => ({ id: text, kind, text, turnId: 't', createdAt: 1, updatedAt: 1, status: 'completed' })
function fake(spec: AgentSessionSpec, provider: ChatProvider = 'claude') {
  let info: ChatSessionInfo = { paneId: spec.paneId, provider, cwd: '/work', status: 'idle', sessionId: spec.resume ?? (spec.aside ? `child-${spec.aside.id}` : 'main-session'), hostPid: 1, hostVersion: AGENT_HOST_PROTOCOL_VERSION, permissionMode: spec.permissionMode, ...(spec.aside ? { aside: spec.aside } : {}) }
  let items = [item('user_message', 'Main goal'), item('assistant_message', 'Main context')]
  let busy = false
  const listeners: { [K in keyof ChatProviderSessionEvents]: ChatProviderSessionEvents[K][] } = { items: [], session: [], commands: [], closed: [], restart: [] }
  const session: ChatProviderSession = {
    paneId: spec.paneId, commands: [], get busy() { return busy }, queued: [],
    on: (event, listener) => { listeners[event].push(listener) },
    forkPoint: () => info.sessionId ? { sessionId: info.sessionId, at: 'finished-turn' } : null,
    start: vi.fn(async () => {}), send: vi.fn(), updateQueue: vi.fn(), interrupt: vi.fn(async () => {}),
    close: vi.fn(), configure: vi.fn(async () => {}), answer: vi.fn(() => false),
    searchFiles: vi.fn(async () => ({ entries: [], truncated: false })),
    controlTask: vi.fn(async () => {}), subagentTranscript: vi.fn(async () => ({ items: [] })), setResumeCommand: vi.fn(),
    snapshot: () => ({ session: { ...info }, items }),
  }
  return { session, set: (change: Partial<ChatSessionInfo>) => { info = { ...info, ...change }; listeners.session.forEach((listener) => listener(info)) }, setItems: (value: ChatItem[]) => { items = value }, setBusy: (value: boolean) => { busy = value }, restart: () => { listeners.restart.forEach((listener) => listener()) }, crash: () => { listeners.closed.forEach((listener) => listener()) } }
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
  cleanups.push(async () => { manager.stop(); await manager.sync() })
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
  it('rejects unsaved main conversations', async () => {
    const { manager, main, factory } = await setup()
    main.set({ sessionId: undefined })
    expect(await manager.act({ action: 'open', text: 'Why?' })).toEqual({ ok: false, error: 'This chat has no saved conversation yet' })
    expect(factory).not.toHaveBeenCalled()
  })
  it('does not create empty history files during sync or conversation changes', async () => {
    const { manager, main, directory, store } = await setup()
    const save = vi.spyOn(store, 'save')
    await manager.sync()
    await manager.sync()
    main.set({ sessionId: 'another-main' })
    await manager.sync()
    expect(save).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
    const empty = '{ "version": 1, "asides": [] }'
    await writeFile(join(directory, 'empty.json'), empty)
    main.set({ sessionId: 'empty' })
    await manager.sync()
    expect(await readFile(join(directory, 'empty.json'), 'utf8')).toBe(empty)
    expect(manager.list()).toEqual([])
  })
  it.each(['{broken', '{"version":2,"asides":[]}'])('logs corrupt history once per conversation and preserves it before opening fresh: %s', async (bad) => {
    const { manager, main, directory, host, store } = await setup()
    main.set({ sessionId: 'broken' })
    await writeFile(join(directory, 'broken.json'), bad)
    await manager.sync()
    await manager.sync()
    main.set({ sessionId: 'other' })
    await writeFile(join(directory, 'other.json'), bad)
    await manager.sync()
    main.set({ sessionId: 'broken' })
    await manager.sync()
    expect(host.log).toHaveBeenCalledTimes(2)
    expect(await readFile(join(directory, 'broken.json'), 'utf8')).toBe(bad)
    expect((await manager.act({ action: 'open', text: 'Fresh question' })).ok).toBe(true)
    const backup = (await readdir(directory)).find((name) => /^broken\.json\.bad-\d+$/.test(name))
    expect(backup).toBeDefined()
    expect(await readFile(join(directory, backup!), 'utf8')).toBe(bad)
    expect(await store.load('broken')).toEqual(manager.list())
    expect(manager.list()).toHaveLength(1)
    await manager.sync()
    expect(host.log).toHaveBeenCalledTimes(2)
  })
  it('keeps corrupt history intact if quarantine fails and allows retry', async () => {
    const { manager, directory, store, factory, host } = await setup()
    const path = join(directory, 'main-session.json')
    await writeFile(path, '{broken')
    const quarantine = vi.spyOn(store, 'quarantine').mockRejectedValueOnce(new Error('rename denied'))
    expect(await manager.act({ action: 'open', text: 'Fresh' })).toEqual({ ok: false, error: 'rename denied' })
    expect(await readFile(path, 'utf8')).toBe('{broken')
    expect(factory).not.toHaveBeenCalled()
    expect((await manager.act({ action: 'open', text: 'Retry' })).ok).toBe(true)
    expect(quarantine).toHaveBeenCalledTimes(2)
    expect(host.log).toHaveBeenCalledTimes(1)
  })
  it('drops crashed sessions from the cap and restarts them on Reopen, ignoring stale closed events', async () => {
    const { manager, created, host, factory, store } = await setup()
    for (let i = 0; i < 5; i++) await manager.act({ action: 'open', text: `Q${i}` })
    const crashed = manager.list()[0]!
    created[0]!.crash()
    expect(host.remove).toHaveBeenCalledWith(created[0]!.session.paneId)
    expect(manager.list()[0]).toMatchObject({ status: 'open', sessionId: crashed.sessionId, lastError: 'The aside session closed unexpectedly' })
    expect(host.changed).toHaveBeenLastCalledWith(manager.list(), undefined)
    expect((await manager.act({ action: 'open', text: 'Replacement slot' })).ok).toBe(true)
    expect(await store.load('main-session')).toEqual(manager.list())
    expect(await manager.act({ action: 'reopen', asideId: crashed.id })).toMatchObject({ ok: false, error: expect.stringContaining('5 open') })
    await manager.act({ action: 'close', asideId: manager.list().at(-1)!.id })
    expect((await manager.act({ action: 'reopen', asideId: crashed.id })).ok).toBe(true)
    expect(factory.mock.calls.at(-1)?.[1]).toMatchObject({ resume: crashed.sessionId })
    host.remove.mockClear()
    created[0]!.crash()
    expect(host.remove).not.toHaveBeenCalled()
    expect((await manager.act({ action: 'reopen', asideId: crashed.id })).ok).toBe(true)
    expect(factory).toHaveBeenCalledTimes(7)
    expect(manager.list()[0]?.lastError).toBeUndefined()
  })
  it('reports pending lifecycle work and live busy sessions, and releases crashed sessions', async () => {
    const { manager, factory, created } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const create = factory.getMockImplementation()!
    factory.mockImplementationOnce(async (provider, spec) => { await gate; return create(provider, spec) })
    const opening = manager.act({ action: 'open', text: 'Question' })
    await vi.waitFor(() => expect(factory).toHaveBeenCalled())
    expect(manager.busy).toBe(true)
    release()
    await opening
    expect(manager.busy).toBe(false)
    created[0]!.setBusy(true)
    expect(manager.busy).toBe(true)
    created[0]!.setBusy(false)
    expect(manager.busy).toBe(false)
    created[0]!.setBusy(true)
    created[0]!.crash()
    await manager.sync()
    expect(manager.busy).toBe(false)
  })
  it('serializes concurrent opens and preserves closed records without a TTL', async () => {
    const { manager, store } = await setup()
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => manager.act({ action: 'open', text: `Q${i}` })))
    expect(results.filter((result) => result.ok)).toHaveLength(5)
    for (const record of manager.list()) await manager.act({ action: 'close', asideId: record.id })
    expect((await store.load('main-session')).filter((record) => record.status === 'closed')).toHaveLength(5)
  })
  it.each(['EACCES', 'EMFILE', 'EIO'])('retries %s reads without quarantining or overwriting saved records', async (code) => {
    const { manager, store, factory, host } = await setup()
    const load = vi.spyOn(store, 'load').mockRejectedValue(Object.assign(new Error(code), { code }))
    const quarantine = vi.spyOn(store, 'quarantine'), save = vi.spyOn(store, 'save')
    await manager.sync()
    expect(host.changed).toHaveBeenLastCalledWith([], code)
    expect(await manager.act({ action: 'open', text: 'Question' })).toEqual({ ok: false, error: `Saved asides couldn't be read: ${code}` })
    expect(load).toHaveBeenCalledTimes(2)
    expect(factory).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(quarantine).not.toHaveBeenCalled()
    load.mockRestore()
    expect((await manager.act({ action: 'open', text: 'Recovered' })).ok).toBe(true)
    expect(host.changed).toHaveBeenLastCalledWith(manager.list(), undefined)
    expect(await store.load('main-session')).toEqual(manager.list())
  })
  it('persists a crash reason and clears it after a successful reopen', async () => {
    const { manager, created, store } = await setup()
    await manager.act({ action: 'open', text: 'Question' })
    const id = manager.list()[0]!.id
    created[0]!.set({ error: 'Provider exited with code 9', status: 'error' })
    created[0]!.crash()
    await manager.sync()
    expect(manager.list()[0]).toMatchObject({ status: 'open', lastError: 'Provider exited with code 9' })
    expect((await store.load('main-session'))[0]?.lastError).toBe('Provider exited with code 9')
    expect((await manager.act({ action: 'reopen', asideId: id })).ok).toBe(true)
    expect(manager.list()[0]?.lastError).toBeUndefined()
    expect((await store.load('main-session'))[0]?.lastError).toBeUndefined()
  })
  it('rolls back an open whose provider starts in error', async () => {
    const { manager, factory, created, store, host } = await setup()
    const create = factory.getMockImplementation()!
    factory.mockImplementationOnce(async (provider, spec) => {
      const session = await create(provider, spec)
      created.at(-1)!.set({ status: 'error', error: 'Start rejected' })
      return session
    })
    expect(await manager.act({ action: 'open', text: 'Question' })).toEqual({ ok: false, error: 'Start rejected' })
    expect(manager.list()).toEqual([])
    expect(await store.load('main-session')).toEqual([])
    expect(host.remove).toHaveBeenCalledWith(created[0]!.session.paneId)
    expect(created[0]!.session.close).toHaveBeenCalled()
  })
  it.each([false, true])('keeps a failed refork closed with its original error (cleanup save fails: %s)', async (saveFails) => {
    const { manager, factory, created, store, host } = await setup()
    await manager.act({ action: 'open', text: 'Question' })
    const id = manager.list()[0]!.id, create = factory.getMockImplementation()!
    factory.mockImplementationOnce(async (provider, spec) => {
      const session = await create(provider, spec)
      created.at(-1)!.set({ status: 'error', error: 'Refork rejected' })
      return session
    })
    if (saveFails) vi.spyOn(store, 'save').mockRejectedValue(new Error('Disk full'))
    expect(await manager.act({ action: 'refork', asideId: id })).toEqual({ ok: false, error: 'Refork rejected' })
    expect(manager.list()[0]).toMatchObject({ status: 'closed', lastError: 'Refork rejected' })
    expect(created[1]!.session.close).toHaveBeenCalled()
    expect(host.remove).toHaveBeenCalledWith(created[1]!.session.paneId)
    expect(host.changed).toHaveBeenLastCalledWith(manager.list(), undefined)
    if (saveFails) expect(host.log).toHaveBeenCalledWith(expect.objectContaining({ message: 'Disk full' }))
    else expect((await store.load('main-session'))[0]).toMatchObject({ status: 'closed', lastError: 'Refork rejected' })
  })
  it('preserves the start failure when open rollback cannot save', async () => {
    const { manager, factory, store, host } = await setup()
    factory.mockRejectedValueOnce(new Error('Provider unavailable'))
    vi.spyOn(store, 'save').mockResolvedValueOnce().mockRejectedValue(new Error('Disk full'))
    expect(await manager.act({ action: 'open', text: 'Question' })).toEqual({ ok: false, error: 'Provider unavailable' })
    expect(manager.list()).toEqual([])
    expect(host.changed).toHaveBeenLastCalledWith([], undefined)
    expect(host.log).toHaveBeenCalledWith(expect.objectContaining({ message: 'Disk full' }))
  })
  it('reforks a closed Cursor aside with a fresh brief, separator and title', async () => {
    const { manager, created, factory, main } = await setup('cursor')
    await manager.act({ action: 'open', text: 'Why?\nOriginal details' })
    const record = manager.list()[0]!
    await manager.act({ action: 'close', asideId: record.id })
    expect((await manager.act({ action: 'refork', asideId: record.id })).ok).toBe(true)
    expect(factory.mock.calls.at(-1)?.[1]).toMatchObject({ resume: undefined, fork: undefined })
    expect(created.at(-1)!.session.send).toHaveBeenCalledWith(`${asideBrief(main.session.snapshot().items, record.mode)}\n---\n${record.title}`, undefined)
    expect(manager.list()[0]).toMatchObject({ status: 'open' })
  })
  it('records restore failures and publishes restored running tabs even if saving fails', async () => {
    const { manager, store, main, spec, host, factory, created } = await setup()
    await manager.act({ action: 'open', text: 'Works' })
    await manager.act({ action: 'open', text: 'Fails' })
    manager.stop()
    const create = factory.getMockImplementation()!
    factory.mockImplementationOnce(create).mockRejectedValueOnce(new Error('Resume rejected'))
    vi.spyOn(store, 'save').mockRejectedValue(new Error('Disk full'))
    const restored = new ChatAsides(main.session, spec, host, store, factory)
    cleanups.push(async () => restored.stop())
    await expect(restored.sync()).rejects.toThrow('Disk full')
    expect(restored.list()).toMatchObject([{ status: 'open' }, { status: 'closed', lastError: 'Resume rejected' }])
    expect(host.changed).toHaveBeenLastCalledWith(restored.list(), undefined)
    expect(created.at(-1)!.session.close).not.toHaveBeenCalled()
  })
  it('publishes a close even when saving fails', async () => {
    const { manager, store, created, host } = await setup()
    await manager.act({ action: 'open', text: 'Question' })
    vi.spyOn(store, 'save').mockRejectedValue(new Error('Disk full'))
    expect(await manager.act({ action: 'close', asideId: manager.list()[0]!.id })).toEqual({ ok: false, error: 'Disk full' })
    expect(host.changed).toHaveBeenLastCalledWith(manager.list(), undefined)
    expect(manager.list()[0]?.status).toBe('closed')
    expect(created[0]!.session.close).toHaveBeenCalled()
  })
  it('records session-id save failures without losing the live tab', async () => {
    const { manager, created, store, host } = await setup()
    await manager.act({ action: 'open', text: 'Question' })
    vi.spyOn(store, 'save').mockRejectedValue(new Error('Session id could not be saved'))
    created[0]!.set({ sessionId: 'updated-id' })
    await manager.sync()
    expect(manager.list()[0]).toMatchObject({ sessionId: 'updated-id', lastError: 'Session id could not be saved' })
    expect(host.changed).toHaveBeenLastCalledWith(manager.list(), undefined)
    expect(host.log).toHaveBeenCalledWith(expect.objectContaining({ message: 'Session id could not be saved' }))
  })
  it('defers and coalesces provider restarts until idle, then resumes', async () => {
    const { manager, created, factory } = await setup('cursor')
    await manager.act({ action: 'open', text: 'Question' })
    const record = manager.list()[0]!, child = created[0]!
    child.setBusy(true)
    child.restart(); child.restart()
    await manager.sync()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(child.session.interrupt).not.toHaveBeenCalled()
    child.setBusy(false); child.set({ status: 'idle' })
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    await manager.sync()
    expect(factory.mock.calls.at(-1)?.[1]).toMatchObject({ resume: record.sessionId })
    expect(created[1]!.session.send).not.toHaveBeenCalled()
    child.restart()
    await manager.sync()
    expect(factory).toHaveBeenCalledTimes(2)
  })
  it('records a provider restart failure on the closed record', async () => {
    const { manager, created, factory } = await setup('cursor')
    await manager.act({ action: 'open', text: 'Question' })
    factory.mockRejectedValueOnce(new Error('Credentials expired'))
    created[0]!.restart()
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('closed'))
    await manager.sync()
    expect(manager.list()[0]?.lastError).toBe('Credentials expired')
  })
  it('rechecks idle status after waiting behind another lifecycle action', async () => {
    const { manager, created, factory } = await setup('cursor')
    await manager.act({ action: 'open', text: 'First' })
    const child = created[0]!, create = factory.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    factory.mockImplementationOnce(async (provider, spec) => { await gate; return create(provider, spec) })
    const opening = manager.act({ action: 'open', text: 'Second' })
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    child.restart()
    await Promise.resolve()
    child.setBusy(true)
    release()
    await opening
    await manager.sync()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(child.session.interrupt).not.toHaveBeenCalled()
    child.setBusy(false); child.set({ status: 'idle' })
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(3))
    await manager.sync()
    expect(factory.mock.calls.at(-1)?.[1].resume).toBe(child.session.snapshot().session.sessionId)
  })
  it.each(['start', 'interrupt'] as const)('bounds a hung %s and releases the serial action chain', async (operation) => {
    const { manager, created, factory } = await setup()
    await manager.act({ action: 'open', text: 'Question' })
    const id = manager.list()[0]!.id
    if (operation === 'interrupt') vi.mocked(created[0]!.session.interrupt).mockReturnValueOnce(new Promise(() => {}))
    else {
      const create = factory.getMockImplementation()!
      factory.mockImplementationOnce(async (provider, spec) => {
        const session = await create(provider, spec)
        vi.mocked(session.start).mockReturnValueOnce(new Promise(() => {}))
        return session
      })
    }
    vi.useFakeTimers()
    const action = manager.act({ action: operation === 'start' ? 'refork' : 'close', asideId: id })
    // Real storage promises must settle before advancing the provider deadline.
    await vi.waitFor(() => {
      expect(vi.mocked(created.at(-1)!.session[operation])).toHaveBeenCalled()
      if (operation === 'start') expect(created).toHaveLength(2)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await action).toEqual({ ok: false, error: `Aside ${operation} timed out after 60 seconds` })
    expect(manager.list()[0]).toMatchObject({ status: 'closed', lastError: `Aside ${operation} timed out after 60 seconds` })
    expect(created.at(-1)!.session.close).toHaveBeenCalled()
    expect((await manager.act({ action: 'open', text: 'Next action' })).ok).toBe(true)
  })
})

describe('aside brief and env', () => {
  it.each(['read-only', 'inherit'] as const)('suppresses inherited status lines while retaining %s restrictions', (mode) => {
    const instructions = asideInstructions(mode)
    expect(instructions).toContain('Do not end replies with a 🟢 status line')
    expect(instructions).toContain('even if the main conversation’s instructions request one')
    expect(instructions).toContain('do not continue the main task')
    expect(instructions).toContain('Do not set pane titles or headlines')
    expect(instructions).toContain(mode === 'read-only' ? 'Do not modify files.' : 'The read-only restriction is off')
  })
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

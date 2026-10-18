import { mkdtemp, rm } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSessionInfo } from '../shared/agent-chat.js'
import type { ChatConversation } from '../shared/chat-conversations.js'
import type { AgentStatus, CommandoSnapshot, TmuxPane } from '../shared/protocol.js'
import { AgentStatusRegistry } from './agent-status-registry.js'
import { inferAgentProcessStatus } from './agent-status.js'
import { ChatConversationsApi } from './chat-conversations-api.js'
import { TmuxCreator, agentLaunchPaneCommand } from './tmux-create.js'

const ID = '11111111-2222-3333-4444-555555555555'
let folder: string
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'commando-resume-')) })
afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

function request(method: string, path: string, value?: unknown): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage & PassThrough
  Object.assign(stream, { method, url: path, headers: { 'content-type': 'application/json' } })
  stream.end(value === undefined ? undefined : JSON.stringify(value))
  return stream
}

function response() {
  const result = { status: 0, body: undefined as unknown, headers: {} as Record<string, unknown> }
  const fake = {
    setHeader: (name: string, value: unknown) => { result.headers[name] = value },
    writeHead: (status: number) => { result.status = status },
    end: (body: string) => { result.body = JSON.parse(body) },
  } as unknown as ServerResponse
  return { fake, result }
}

const chat = (overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo => ({ paneId: '%1', provider: 'claude', cwd: '/x', status: 'idle', hostPid: 1, hostVersion: 5, permissionMode: 'acceptEdits', sessionId: 'aaaaaaaa-0000', ...overrides })

function openAgentSessions(registry: AgentStatusRegistry, panes: Pick<TmuxPane, 'id' | 'command'>[]): AgentStatus[] {
  return panes.flatMap((pane) => registry.openConversationStatus(pane.id, pane.command, inferAgentProcessStatus({
    paneId: pane.id, command: pane.command, title: '✳ Claude', dead: false, capturedAt: 1,
  }).provider) ?? [])
}

function setup(options: { conversation?: Partial<ChatConversation>; chats?: ChatSessionInfo[]; agentSessions?: AgentStatus[] | (() => AgentStatus[]); panes?: Pick<TmuxPane, 'id' | 'command'>[]; creator?: Pick<TmuxCreator, 'createPane' | 'respawnChatPane'> } = {}) {
  const conversation: ChatConversation = { provider: 'codex', sessionId: ID, cwd: folder, title: 'Old', updatedAt: 1, ...options.conversation }
  const chats = options.chats ?? [chat()]
  const creator = {
    respawnChatPane: vi.fn(async () => {}),
    createPane: vi.fn(async () => ({ paneId: '%9' }) as never),
  }
  const api = new ChatConversationsApi({
    index: { list: vi.fn(async () => [conversation]), find: vi.fn(async (provider, sessionId) => provider === conversation.provider && sessionId === conversation.sessionId ? conversation : undefined) },
    snapshot: () => ({ panes: options.panes ?? [{ id: '%1' }, { id: '%2' }] }) as unknown as CommandoSnapshot,
    chatSession: (paneId) => chats.find((session) => session.paneId === paneId),
    chatSessions: () => chats,
    agentSessions: () => typeof options.agentSessions === 'function' ? options.agentSessions() : options.agentSessions ?? [],
    creator: options.creator ?? creator,
    beforePaneCreated: vi.fn(async () => {}),
    refreshSnapshot: vi.fn(async () => {}),
  })
  const resume = async (input: Record<string, unknown>) => {
    const { fake, result } = response()
    await api.handle(request('POST', '/api/chat-conversations/resume', { paneId: '%1', provider: 'codex', sessionId: ID, placement: 'replace', ...input }), fake, new URL('http://x/api/chat-conversations/resume'))
    return result
  }
  const list = async () => {
    const { fake, result } = response()
    await api.handle(request('GET', '/api/chat-conversations'), fake, new URL('http://x/api/chat-conversations'))
    return result
  }
  return { api, creator, resume, conversation, list }
}

describe('ChatConversationsApi', () => {
  it.each([
    ['live TUI after a completed turn', '2.1.295', false, 409],
    ['pane back at zsh before registry reconciliation', 'zsh', false, 200],
    ['pane running vim before registry reconciliation', 'vim', false, 200],
    ['exited TUI with a retained recap', 'zsh', true, 200],
    ['exited TUI now running vim', 'vim', true, 200],
    ['retained recap even if the command matches again', '2.1.295', true, 200],
  ] as const)('%s uses the same open hook conversations for listing and resume', async (_scenario, command, exited, expectedStatus) => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook('%2', { hook_event_name: 'UserPromptSubmit', session_id: ID, intent: 'Ship it' }, 1, '2.1.295')
    registry.applyClaudeHook('%2', { hook_event_name: 'Stop', session_id: ID, finalMessage: 'Shipped the fix.' }, 2, '2.1.295')
    if (exited) registry.removeIfProcessChanged('%2', 'zsh')
    // The recap remains in values() even after the TUI exits.
    expect(registry.values()).toMatchObject([{ paneId: '%2', source: 'hook', agentSessionId: ID, status: 'done' }])
    const panes = [{ id: '%1', command: 'node' }, { id: '%2', command }]
    const { creator, resume, list, conversation } = setup({
      conversation: { provider: 'claude' },
      panes,
      agentSessions: () => openAgentSessions(registry, panes),
    })
    expect((await list()).body).toEqual({ conversations: [{ ...conversation, ...(expectedStatus === 409 ? { openPaneId: '%2' } : {}) }] })
    expect(await resume({ provider: 'claude' })).toMatchObject({
      status: expectedStatus,
      body: expectedStatus === 409 ? { error: 'That conversation is already open in pane %2' } : { paneId: '%1' },
    })
    expect(creator.respawnChatPane).toHaveBeenCalledTimes(expectedStatus === 200 ? 1 : 0)
  })

  it.each([
    ['2.1.295', true],
    ['node', true],
    ['zsh', false],
    ['vim', false],
    ['codex', false],
  ] as const)('SessionStart-only with foreground %s is open: %s', async (command, isOpen) => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook('%2', { hook_event_name: 'SessionStart', session_id: ID }, 1, '2.1.295')
    const panes = [{ id: '%1', command: 'node' }, { id: '%2', command }]
    const { list, resume, conversation } = setup({
      conversation: { provider: 'claude' }, panes,
      agentSessions: () => openAgentSessions(registry, panes),
    })
    expect((await list()).body).toEqual({ conversations: [{ ...conversation, ...(isOpen ? { openPaneId: '%2' } : {}) }] })
    expect((await resume({ provider: 'claude' })).status).toBe(isOpen ? 409 : 200)
  })

  it('blocks a duplicate resume after the reservation expires when Claude has only reported SessionStart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const registry = new AgentStatusRegistry()
      const panes = [{ id: '%1', command: 'node' }, { id: '%2', command: '2.1.295' }]
      const { creator, resume } = setup({
        conversation: { provider: 'claude' },
        chats: [chat(), chat({ paneId: '%2' })],
        panes,
        agentSessions: () => openAgentSessions(registry, panes),
      })
      expect(await resume({ paneId: '%2', provider: 'claude' })).toMatchObject({ status: 200 })
      registry.applyClaudeHook('%2', { hook_event_name: 'SessionStart', session_id: ID }, 1, '2.1.295')
      vi.advanceTimersByTime(15_000)

      expect(await resume({ provider: 'claude' })).toMatchObject({
        status: 409, body: { error: 'That conversation is already open in pane %2' },
      })
      expect(creator.respawnChatPane).toHaveBeenCalledTimes(1)
      expect(creator.createPane).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['cursor', ID, ['agent', `--resume=${ID}`]],
    ['opencode', 'ses_ed3f6d576ffeGGkSAFgSk4Snvz', ['opencode', '-s', 'ses_ed3f6d576ffeGGkSAFgSk4Snvz']],
  ] as const)('resumes %s with the TUI argv and indexed cwd, in either placement', async (provider, sessionId, argv) => {
    for (const placement of ['split', 'replace'] as const) {
      const run = vi.fn(async (_args: readonly string[]) => ['$1', 'test', '@1', '0', 'test', '%9', '1', folder, folder].join('\u001f'))
      const resolve = vi.fn(async (name: string) => `/host/bin/${name}`)
      const creator = new TmuxCreator(run, ['-L', 'conversation-test'], undefined, resolve, {})
      const { resume } = setup({ creator, conversation: { provider, sessionId } })
      expect(await resume({ provider, sessionId, placement, cwd: '/untrusted/request' })).toMatchObject({ status: 200, body: { paneId: placement === 'split' ? '%9' : '%1' } })
      const args = run.mock.calls[0]![0]
      expect(args).toContain(placement === 'split' ? 'split-window' : 'respawn-pane')
      expect(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2)).toEqual(['-c', folder])
      expect(args.at(-1)).toBe(agentLaunchPaneCommand([`/host/bin/${argv[0]}`, ...argv.slice(1)], undefined, {}))
      expect(resolve).toHaveBeenCalledWith(argv[0], {})
    }
  })

  it('lists conversations', async () => {
    const { api, conversation } = setup()
    const { fake, result } = response()
    expect(await api.handle(request('GET', '/api/chat-conversations'), fake, new URL('http://x/api/chat-conversations'))).toBe(true)
    expect(result).toMatchObject({ status: 200, body: { conversations: [conversation] } })
  })

  it('lists hosted chats as open even when their pane command is not an agent', async () => {
    const { list, conversation } = setup({
      chats: [chat(), chat({ paneId: '%2', provider: 'codex', sessionId: ID })],
      panes: [{ id: '%1', command: 'node' }, { id: '%2', command: 'zsh' }],
    })
    expect((await list()).body).toEqual({ conversations: [{ ...conversation, openPaneId: '%2' }] })
  })

  it('switches the chat pane to the conversation in its own folder, never above the chat\'s permissions', async () => {
    const { creator, resume } = setup()
    expect(await resume({})).toMatchObject({ status: 200, body: { paneId: '%1' } })
    // Claude's acceptEdits ranks with Codex's default (workspace access).
    expect(creator.respawnChatPane).toHaveBeenCalledWith('%1', folder, { provider: 'codex-chat', permissionMode: 'default', resume: ID })
  })

  it('opens a Claude conversation beside the pane with its own profile, in plan mode from a plan chat', async () => {
    const { creator, resume } = setup({ conversation: { provider: 'claude', configDir: '/home/me/.claudew' }, chats: [chat({ provider: 'codex', permissionMode: 'plan' })] })
    expect(await resume({ provider: 'claude', placement: 'split' })).toMatchObject({ status: 200, body: { paneId: '%9' } })
    expect(creator.createPane).toHaveBeenCalledWith({ targetId: '%1', direction: 'horizontal', placement: 'after', cwd: folder, agent: { provider: 'claude-chat', permissionMode: 'plan', resume: ID, configDir: '/home/me/.claudew' } })
  })

  it('lets only one pane resume a conversation, until its new host has had time to report it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const { creator, resume } = setup({ chats: [chat(), chat({ paneId: '%2', sessionId: 'bbbbbbbb-0000' })] })
      const [first, second] = await Promise.all([resume({}), resume({ paneId: '%2' })])
      expect([first.status, second.status].sort()).toEqual([200, 409])
      expect(await resume({ paneId: '%2' })).toMatchObject({ status: 409, body: { error: 'That conversation is already being opened' } })
      vi.advanceTimersByTime(15_000)
      expect(await resume({ paneId: '%2' })).toMatchObject({ status: 200 })
      expect(creator.respawnChatPane).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses unknown conversations, non-chat panes, open conversations and missing folders', async () => {
    expect(await setup().resume({ sessionId: '22222222-0000' })).toMatchObject({ status: 404 })
    expect(await setup().resume({ paneId: '%2' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('from a chat pane') } })
    const open = setup({ chats: [chat(), chat({ paneId: '%2', provider: 'codex', sessionId: ID })] })
    expect(await open.resume({})).toMatchObject({ status: 409, body: { error: 'That conversation is already open in pane %2' } })
    const gone = setup({ conversation: { cwd: join(folder, 'deleted') } })
    expect(await gone.resume({})).toMatchObject({ status: 409, body: { error: expect.stringContaining('no longer exists') } })
    expect(await setup().resume({ placement: 'elsewhere' })).toMatchObject({ status: 400 })
    expect(open.creator.respawnChatPane).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex', 'cursor', 'opencode'] as const)('refuses a hook-reported %s conversation in another live pane after the reservation expires', async (provider) => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const sessionId = provider === 'opencode' ? 'ses_session123' : ID
      const agentSessions: AgentStatus[] = []
      const { creator, resume } = setup({ conversation: { provider, sessionId }, chats: [chat(), chat({ paneId: '%2' })], agentSessions })
      expect(await resume({ paneId: '%2', provider, sessionId })).toMatchObject({ status: 200 })
      agentSessions.push({ paneId: '%2', provider, agentSessionId: sessionId, source: 'hook', status: 'done', summary: '', confidence: 'high', reason: 'Hook report', updatedAt: Date.now() })
      vi.advanceTimersByTime(15_000)
      expect(await resume({ provider, sessionId })).toMatchObject({ status: 409, body: { error: 'That conversation is already open in pane %2' } })
      expect(creator.respawnChatPane).toHaveBeenCalledTimes(1)
      expect(creator.createPane).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat a hook status in a dead remain-on-exit pane as open', async () => {
    const status: AgentStatus = { paneId: '%2', provider: 'codex', agentSessionId: ID, source: 'hook', status: 'done', summary: '', confidence: 'high', reason: 'Hook report', updatedAt: Date.now() }
    const { resume } = setup({ agentSessions: [status], panes: [{ id: '%1', command: 'zsh' }, { id: '%2', command: 'codex', dead: true } as never] })
    expect(await resume({})).toMatchObject({ status: 200 })
  })

  it.each([
    { source: 'process' },
    { source: 'heuristic' },
    { paneId: '%99' },
    { provider: 'cursor' },
    { agentSessionId: 'bbbbbbbb-0000' },
  ] as const)('does not block resume for an unverified, closed or different agent session: %j', async (overrides) => {
    const status: AgentStatus = { paneId: '%2', provider: 'codex', agentSessionId: ID, source: 'hook', status: 'done', summary: '', confidence: 'high', reason: 'Hook report', updatedAt: Date.now(), ...overrides }
    const { resume, list, conversation } = setup({ agentSessions: [status] })
    expect((await list()).body).toEqual({ conversations: [conversation] })
    expect(await resume({})).toMatchObject({ status: 200 })
  })
})

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSessionInfo } from '../shared/agent-chat.js'
import type { ChatConversation } from '../shared/chat-conversations.js'
import type { AgentStatus, CommandoSnapshot, TmuxPane } from '../shared/protocol.js'
import type { AgentResumeRecord } from './agent-resume.js'
import { buildChatResumeCommand, buildChatReturnCommand } from './agent-resume-command.js'
import type { ConversationBriefRecord } from './session-briefs.js'
import { AgentStatusRegistry } from './agent-status-registry.js'
import { inferAgentProcessStatus } from './agent-status.js'
import { ChatConversationsApi } from './chat-conversations-api.js'
import { SessionPreferenceStore, type SessionGroupingMode } from './session-preferences.js'
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

function setup(options: { records?: ConversationBriefRecord[]; sessions?: { id: string; name: string; windowIds?: string[] }[]; panes?: (Pick<TmuxPane, 'id'> & Partial<Pick<TmuxPane, 'sessionId' | 'windowId' | 'index' | 'repo' | 'command'>>)[]; groups?: { id: string; name: string; sessionIds: string[] }[]; groupingMode?: SessionGroupingMode; sessionPreferences?: Pick<SessionPreferenceStore, 'loadReadOnly'>; conversation?: Partial<ChatConversation>; chats?: ChatSessionInfo[]; empty?: boolean; resumeRecord?: Partial<AgentResumeRecord>; agentSessions?: AgentStatus[] | (() => AgentStatus[]); creator?: Pick<TmuxCreator, 'createPane' | 'respawnChatPane' | 'createWindow' | 'createSession'> } = {}) {
  const conversation: ChatConversation = { provider: 'codex', sessionId: ID, cwd: folder, title: 'Old', updatedAt: 1, ...options.conversation }
  const chats = options.chats ?? [chat()]
  const creator = {
    respawnChatPane: vi.fn(async () => {}),
    createWindow: vi.fn(async () => ({ paneId: '%10' }) as never),
    createSession: vi.fn(async () => ({ created: { paneId: '%11' } }) as never),
    createPane: vi.fn(async () => ({ paneId: '%9' }) as never),
  }
  const api = new ChatConversationsApi({
    index: { list: vi.fn(async () => [conversation]), find: vi.fn(async (provider, sessionId) => provider === conversation.provider && sessionId === conversation.sessionId ? conversation : undefined) },
    resumes: { findConversation: (provider, sessionId) => options.resumeRecord ? { targetId: 'target', provider, sessionId, path: folder, command: 'env codex resume ' + ID, serverId: 'test', updatedAt: 1, ...options.resumeRecord } : undefined },
    briefs: { conversationRecords: () => options.records ?? [] },
    sessionPreferences: options.sessionPreferences ?? { loadReadOnly: async () => ({ version: 1, groups: options.groups ?? [], ungroupedSessionIds: [], groupingMode: options.groupingMode }) },
    snapshot: () => ({ sessions: options.sessions?.map((session) => ({ windowIds: ['@1'], ...session })) ?? [], panes: options.panes ?? [{ id: '%1', empty: options.empty }, { id: '%2' }] }) as unknown as CommandoSnapshot,
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

  it('enriches only indexed conversations with their live session, group, headline, links and Claude profile', async () => {
    const record: ConversationBriefRecord = { provider: 'claude', id: ID, sessionId: '$1', sessionName: 'vivi', paneOpen: false,
      title: 'Stable picker title', headline: 'Session picker ready', updatedAt: 10, references: [
        { kind: 'url', value: 'https://example.com/preview' },
        { kind: 'issue', value: 'https://example.com/540', label: 'PR #540' },
        { kind: 'deployment', value: 'https://example.com/deploy', label: 'Preview', url: 'https://example.com/custom' },
        { kind: 'feature_flag', value: 'hidden' }, { kind: 'session', value: 'codex resume abcdefgh' },
        { kind: 'build', value: 'build-1' }, { kind: 'release', value: 'v1' },
      ] }
    const { api, conversation } = setup({ conversation: { provider: 'claude', configDir: '/home/me/.claudep' },
      records: [record, { ...record, provider: 'codex', id: 'delegate-not-indexed' }],
      sessions: [{ id: '$1', name: 'vivi' }], groupingMode: 'manual', groups: [{ id: 'g1', name: 'Subscriptions', sessionIds: ['$1'] }] })
    const { fake, result } = response()
    await api.handle(request('GET', '/api/chat-conversations'), fake, new URL('http://x/api/chat-conversations'))
    expect(result).toMatchObject({ status: 200, body: { conversations: [{ ...conversation,
      session: { id: '$1', name: 'vivi', group: 'Subscriptions' }, agentTitle: 'Stable picker title', headline: 'Session picker ready', paneOpen: false, closedAt: 10, profile: 'claudep', refs: [
        { label: 'https://example.com/preview', url: 'https://example.com/preview' },
        { label: 'PR #540', url: 'https://example.com/540' }, { label: 'Preview', url: 'https://example.com/custom' },
      ],
    }] } })
  })

  it.each([undefined, 'repository'] as const)('uses the sidebar repository container label instead of stale manual membership (mode: %s)', async (groupingMode) => {
    const repo = { root: '/repos/commando', name: 'commando', branch: 'feature', isWorktree: true }
    const otherRepo = { root: '/repos/other', name: 'other', branch: 'main', isWorktree: false }
    const { api, conversation } = setup({
      records: [{ provider: 'codex', id: ID, sessionId: '$1', sessionName: 'work', paneOpen: false, references: [], updatedAt: 10 }],
      sessions: [{ id: '$1', name: 'work', windowIds: ['@2', '@1'] }], groupingMode,
      groups: [{ id: 'g1', name: 'Old manual group', sessionIds: ['$1'] }],
      panes: [
        { id: '%1', sessionId: '$1', windowId: '@1', index: 0, repo: otherRepo },
        { id: '%3', sessionId: '$1', windowId: '@2', index: 1, repo: otherRepo },
        { id: '%2', sessionId: '$1', windowId: '@2', index: 0, repo },
      ],
    })
    const { fake, result } = response()
    await api.handle(request('GET', '/api/chat-conversations'), fake, new URL('http://x/api/chat-conversations'))
    expect(result).toMatchObject({ status: 200, body: { conversations: [{ ...conversation, session: { id: '$1', name: 'work', group: 'commando' } }] } })
  })

  it.each([true, false])('uses the sidebar fallback container when the first pane has no repository (other repo panes: %s)', async (hasRepo) => {
    const repo = { root: '/repos/commando', name: 'commando', branch: 'main', isWorktree: false }
    const otherRepo = { root: '/repos/other', name: 'other', branch: 'main', isWorktree: false }
    const { api } = setup({
      records: [{ provider: 'codex', id: ID, sessionId: '$1', sessionName: 'work', paneOpen: false, references: [], updatedAt: 10 }],
      sessions: [{ id: '$1', name: 'work' }],
      groups: [{ id: 'g1', name: 'Old manual group', sessionIds: ['$1'] }],
      panes: [
        { id: '%1', sessionId: '$1', windowId: '@1', index: 0 },
        ...hasRepo ? [
          { id: '%2', sessionId: '$1', windowId: '@1', index: 1, repo: otherRepo },
          { id: '%3', sessionId: '$1', windowId: '@1', index: 2, repo },
          { id: '%4', sessionId: '$1', windowId: '@1', index: 3, repo },
        ] : [],
      ],
    })
    const { fake, result } = response()
    await api.handle(request('GET', '/api/chat-conversations'), fake, new URL('http://x/api/chat-conversations'))
    expect(result).toMatchObject({ status: 200, body: { conversations: [{ session: { id: '$1', name: 'work', group: hasRepo ? 'commando' : 'No repository' } }] } })
  })

  it.each([undefined, 'manual', 'repository'] as const)('resolves labels after tmux renumbers session ids without writing preferences (mode: %s)', async (groupingMode) => {
    const path = join(folder, 'session-tree.json')
    await new SessionPreferenceStore(path).replace({
      version: 1, groupingMode,
      groups: [{ id: 'g1', name: 'Subscriptions', sessionIds: ['$1'] }], ungroupedSessionIds: [],
    }, [{ id: '$1', name: 'vivi' }])
    const preferences = new SessionPreferenceStore(path)
    const stored = await readFile(path, 'utf8')
    const before = await stat(path)
    const replace = vi.spyOn(preferences, 'replace')
    const load = vi.spyOn(preferences, 'loadReadOnly')
    const { api } = setup({
      records: [{ provider: 'codex', id: ID, sessionId: '$8', sessionName: 'vivi', paneOpen: false, references: [], updatedAt: 10 }],
      sessions: [{ id: '$8', name: 'vivi' }, { id: '$1', name: 'scratch' }], sessionPreferences: preferences,
      panes: [{ id: '%1', sessionId: '$8', windowId: '@1', index: 0,
        repo: { root: '/repos/commando', name: 'commando', branch: 'main', isWorktree: false } }],
    })
    const { fake, result } = response()
    await api.handle(request('GET', '/api/chat-conversations'), fake, new URL('http://x/api/chat-conversations'))
    expect(result).toMatchObject({ status: 200, body: { conversations: [{ session: { id: '$8', name: 'vivi', group: groupingMode === 'manual' ? 'Subscriptions' : 'commando' } }] } })
    expect(load).toHaveBeenCalledWith([
      { id: '$8', name: 'vivi', windowIds: ['@1'] }, { id: '$1', name: 'scratch', windowIds: ['@1'] },
    ], undefined)
    expect(replace).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe(stored)
    expect(await stat(path)).toMatchObject({ mtimeMs: before.mtimeMs, ino: before.ino })
  })

  it.each(['manual', 'repository'] as const)('preserves the brief name and omits a group when a live session reused its id in %s mode', async (groupingMode) => {
    const { api, conversation } = setup({
      records: [{ provider: 'codex', id: ID, sessionId: '$1', sessionName: 'old-work', paneOpen: false, references: [], updatedAt: 10 }],
      sessions: [{ id: '$1', name: 'Chat' }], groupingMode, groups: [{ id: 'g1', name: 'Subscriptions', sessionIds: ['$1'] }],
    })
    const { fake, result } = response()
    await api.handle(request('GET', '/api/chat-conversations'), fake, new URL('http://x/api/chat-conversations'))
    expect(result.body).toEqual({ conversations: [{ ...conversation, session: { id: '$1', name: 'old-work' }, paneOpen: false, closedAt: 10, refs: [] }] })
  })

  it.each([undefined, join(homedir(), '.claude')])('omits the default Claude profile (%s) and stale session groups', async (configDir) => {
    const { api, conversation } = setup({ conversation: { provider: 'claude', ...(configDir ? { configDir } : {}) },
      records: [{ provider: 'claude', id: ID, sessionId: '$9', sessionName: 'closed session', paneOpen: false, references: [], updatedAt: 10 }],
      groups: [{ id: 'g1', name: 'Old group', sessionIds: ['$9'] }] })
    const { fake, result } = response()
    await api.handle(request('GET', '/api/chat-conversations'), fake, new URL('http://x/api/chat-conversations'))
    expect(result.body).toEqual({ conversations: [{ ...conversation, session: { id: '$9', name: 'closed session' }, paneOpen: false, closedAt: 10, refs: [] }] })
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

  it('switches a chat pane to a Muse conversation as a Muse chat', async () => {
    const { creator, resume } = setup({ conversation: { provider: 'muse' } })
    expect(await resume({ provider: 'muse' })).toMatchObject({ status: 200, body: { paneId: '%1' } })
    expect(creator.respawnChatPane).toHaveBeenCalledWith('%1', folder, { provider: 'muse-chat', permissionMode: expect.any(String), resume: ID })
  })

  it('resumes a saved Muse chat through the chat host, never above the calling chat', async () => {
    const resumeRecord = { provider: 'muse' as const, command: `env COMMANDO_PORT=4410 /c/scripts/commando-agent muse --permission-mode bypassPermissions --resume ${ID}` }
    const workspace = setup({ conversation: { provider: 'muse' }, chats: [chat({ provider: 'codex', permissionMode: 'default' })], resumeRecord })
    expect(await workspace.resume({ provider: 'muse' })).toMatchObject({ status: 200 })
    expect(workspace.creator.respawnChatPane).toHaveBeenCalledWith('%1', folder, { provider: 'muse-chat', permissionMode: 'default', resume: ID })
    // Muse has no plan mode, so a plan chat can't hand it the saved full access either.
    const plan = setup({ conversation: { provider: 'muse' }, chats: [chat({ provider: 'codex', permissionMode: 'plan' })], resumeRecord })
    expect(await plan.resume({ provider: 'muse' })).toMatchObject({ status: 403 })
    expect(plan.creator.respawnChatPane).not.toHaveBeenCalled()
  })

  it('resumes a Muse conversation from a terminal in the Muse TUI', async () => {
    const { creator, resume } = setup({ conversation: { provider: 'muse' }, chats: [] })
    expect(await resume({ provider: 'muse', placement: 'split' })).toMatchObject({ status: 200 })
    expect(creator.createPane).toHaveBeenCalledWith(expect.objectContaining({ targetId: '%1', cwd: folder }), undefined, `env muse resume ${ID}`)
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

  it('refuses unknown conversations, open conversations and missing folders', async () => {
    expect(await setup().resume({ sessionId: '22222222-0000' })).toMatchObject({ status: 404 })
    const open = setup({ chats: [chat(), chat({ paneId: '%2', provider: 'codex', sessionId: ID })] })
    expect(await open.resume({})).toMatchObject({ status: 409, body: { error: 'That conversation is already open in pane %2' } })
    const gone = setup({ conversation: { cwd: join(folder, 'deleted') } })
    expect(await gone.resume({})).toMatchObject({ status: 409, body: { error: expect.stringContaining('no longer exists') } })
    expect(await setup().resume({ placement: 'elsewhere' })).toMatchObject({ status: 400 })
    expect(open.creator.respawnChatPane).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex', 'muse', 'cursor', 'opencode'] as const)('refuses a hook-reported %s conversation in another live pane after the reservation expires', async (provider) => {
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

  it.each(['claude', 'codex', 'muse', 'cursor', 'opencode'] as const)('refuses a hook-reported %s conversation for every placement, including without a requester', async (provider) => {
    const sessionId = provider === 'opencode' ? 'ses_session123' : ID
    for (const input of [{ placement: 'replace' }, { placement: 'split' }, { placement: 'session' }, { placement: 'session', paneId: undefined }]) {
      const status: AgentStatus = { paneId: '%2', provider, agentSessionId: sessionId, source: 'hook', status: 'done', summary: '', confidence: 'high', reason: 'Hook report', updatedAt: Date.now() }
      const { creator, resume } = setup({ conversation: { provider, sessionId, session: { id: '$7', name: 'original' } }, agentSessions: [status] })
      expect(await resume({ provider, sessionId, ...input })).toMatchObject({ status: 409, body: { error: 'That conversation is already open in pane %2' } })
      expect(creator.respawnChatPane).not.toHaveBeenCalled()
      expect(creator.createPane).not.toHaveBeenCalled()
      expect(creator.createWindow).not.toHaveBeenCalled()
      expect(creator.createSession).not.toHaveBeenCalled()
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

describe('resume placement and launch selection', () => {
  it.each([
    ['chat', false, true, 'replace', 'respawnChatPane'],
    ['chat split', false, true, 'split', 'createPane'],
    ['empty', true, false, 'replace', 'respawnChatPane'],
    ['empty split', true, false, 'split', 'createPane'],
    ['terminal', false, false, 'replace', 'createPane'],
    ['terminal split', false, false, 'split', 'createPane'],
  ] as const)('%s follows safe placement', async (_name, empty, isChat, placement, method) => {
    const { resume, creator } = setup({ empty, chats: isChat ? [chat()] : [] })
    expect(await resume({ placement })).toMatchObject({ status: 200 })
    expect(creator[method]).toHaveBeenCalledOnce()
    if (method === 'createPane') expect(creator.respawnChatPane).not.toHaveBeenCalled()
  })

  it.each([true, false])('opens in its original session (exists: %s), without a requester', async (exists) => {
    const { resume, creator } = setup({
      records: [{ provider: 'codex', id: ID, sessionId: '$7', sessionName: 'original', paneOpen: false, references: [], updatedAt: 1 }],
      sessions: exists ? [{ id: '$7', name: 'original' }] : [],
    })
    expect(await resume({ paneId: undefined, placement: 'session', session: { id: '$9', name: 'untrusted' } })).toMatchObject({ status: 200, body: { paneId: exists ? '%10' : '%11' } })
    if (exists) expect(creator.createWindow).toHaveBeenCalledWith({ sessionId: '$7', cwd: folder }, `env codex resume ${ID}`)
    else expect(creator.createSession).toHaveBeenCalledWith({ name: 'original', cwd: folder }, `env codex resume ${ID}`)
    expect(creator.createPane).not.toHaveBeenCalled()
    expect(creator.respawnChatPane).not.toHaveBeenCalled()
  })

  it.each([false, true])('opens a window in the session with the recorded name after tmux renumbers it (old id reused: %s)', async (reused) => {
    for (const paneId of ['%1', undefined]) {
      const { resume, creator } = setup({
        records: [{ provider: 'codex', id: ID, sessionId: '$7', sessionName: 'original', paneOpen: false, references: [], updatedAt: 1 }],
        sessions: [{ id: '$8', name: 'original-copy' }, { id: '$9', name: 'original' }, ...reused ? [{ id: '$7', name: 'unrelated' }] : []],
        chats: [],
      })
      expect(await resume({ paneId, placement: 'session' })).toMatchObject({ status: 200, body: { paneId: '%10' } })
      expect(creator.createWindow).toHaveBeenCalledWith({ sessionId: '$9', cwd: folder }, `env codex resume ${ID}`)
      expect(creator.createSession).not.toHaveBeenCalled()
      expect(creator.createPane).not.toHaveBeenCalled()
      expect(creator.respawnChatPane).not.toHaveBeenCalled()
    }
  })

  it.each(['brief', 'index'] as const)('creates the recorded session when its id was reused by an unrelated session (source: %s)', async (source) => {
    const { resume, creator } = setup({
      ...(source === 'brief'
        ? { records: [{ provider: 'codex' as const, id: ID, sessionId: '$3', sessionName: 'api', paneOpen: false, references: [], updatedAt: 1 }] }
        : { conversation: { session: { id: '$3', name: 'api' } } }),
      sessions: [{ id: '$3', name: 'web' }],
    })
    expect(await resume({ paneId: undefined, placement: 'session' })).toMatchObject({ status: 200, body: { paneId: '%11' } })
    expect(creator.createSession).toHaveBeenCalledWith({ name: 'api', cwd: folder }, `env codex resume ${ID}`)
    expect(creator.createWindow).not.toHaveBeenCalled()
    expect(creator.createPane).not.toHaveBeenCalled()
    expect(creator.respawnChatPane).not.toHaveBeenCalled()
  })

  it('uses the recorded id when no session name was recorded', async () => {
    const { resume, creator } = setup({
      conversation: { session: { id: '$3', name: '' } },
      sessions: [{ id: '$3', name: 'web' }],
    })
    expect(await resume({ paneId: undefined, placement: 'session' })).toMatchObject({ status: 200, body: { paneId: '%10' } })
    expect(creator.createWindow).toHaveBeenCalledWith({ sessionId: '$3', cwd: folder }, `env codex resume ${ID}`)
    expect(creator.createSession).not.toHaveBeenCalled()
  })

  it('creates a session when no exact live name matches', async () => {
    const { resume, creator } = setup({
      conversation: { session: { id: '$7', name: 'original' } },
      sessions: [{ id: '$8', name: 'original-copy' }, { id: '$9', name: 'Original' }],
    })
    expect(await resume({ paneId: undefined, placement: 'session' })).toMatchObject({ status: 200, body: { paneId: '%11' } })
    expect(creator.createSession).toHaveBeenCalledWith({ name: 'original', cwd: folder }, `env codex resume ${ID}`)
    expect(creator.createWindow).not.toHaveBeenCalled()
  })

  it('falls back to a split when the conversation has no session, including without a requester', async () => {
    for (const paneId of ['%1', undefined]) {
      const { resume, creator } = setup()
      expect(await resume({ paneId, placement: 'session' })).toMatchObject({ status: 200, body: { paneId: '%9' } })
      expect(creator.createPane).toHaveBeenCalledWith(expect.objectContaining({ targetId: '%1', cwd: folder }), ...(paneId ? [] : [undefined, `env codex resume ${ID}`]))
    }
  })

  it('reuses the recorded TUI command verbatim from a chat or terminal, ignoring request commands', async () => {
    const command = `env CLAUDE_CONFIG_DIR='/home/me/.claudep' claude --dangerously-skip-permissions --resume ${ID}`
    for (const chats of [[chat()], []]) {
      const { resume, creator } = setup({ chats, resumeRecord: { command }, conversation: { provider: 'claude' } })
      expect(await resume({ provider: 'claude', placement: 'split', command: 'echo untrusted' })).toMatchObject({ status: 200 })
      expect(creator.createPane).toHaveBeenCalledWith({ targetId: '%1', direction: 'horizontal', placement: 'after', cwd: folder }, undefined, command)
    }
  })

  it.each([
    `/checkout/scripts/commando-agent claude --resume ${ID}`,
    `env COMMANDO_PORT=4410 '/checkout with spaces/scripts/commando-agent' codex --resume ${ID}`,
    '$COMMANDO_CHAT_RESUME',
    '${COMMANDO_CHAT_RESUME}',
  ])('recognises saved chat command %s, and uses indexed profile and inherited permissions', async (command) => {
    const { resume, creator } = setup({ conversation: { provider: 'claude', configDir: join(homedir(), '.claudep') }, resumeRecord: { command }, chats: [chat({ permissionMode: 'plan' })] })
    expect(await resume({ provider: 'claude', command: 'echo untrusted' })).toMatchObject({ status: 200 })
    expect(creator.respawnChatPane).toHaveBeenCalledWith('%1', folder, { provider: 'claude-chat', resume: ID, configDir: join(homedir(), '.claudep'), permissionMode: 'plan' })
  })

  it.each(['claude', 'codex', 'muse'] as const)('resumes builder-generated %s chats with server-owned settings in a renumbered session', async (provider) => {
    const launcher = "/checkout with spaces/O'Brien/scripts/commando-agent"
    const flags = ['--permission-mode', 'bypassPermissions']
    const daemonEnv = { COMMANDO_PORT: '4410' }
    const commands = [
      buildChatResumeCommand(ID, launcher, { args: ['node', '/c/server/agent-host/main.ts', provider, ...flags], env: {} }, daemonEnv),
      buildChatReturnCommand(ID, launcher, flags, daemonEnv, provider),
    ]
    for (const command of commands) {
      expect(command).not.toBeNull()
      const { resume, creator } = setup({
        conversation: { provider, session: { id: '$7', name: 'original' } },
        sessions: [{ id: '$9', name: 'original' }],
        resumeRecord: { command: command! }, chats: [],
      })
      expect(await resume({ provider, paneId: undefined, placement: 'session' })).toMatchObject({ status: 200, body: { paneId: '%10' } })
      expect(creator.createWindow).toHaveBeenCalledWith({ sessionId: '$9', cwd: folder, agent: { provider: `${provider}-chat`, resume: ID, permissionMode: 'default' } })
      expect(creator.createSession).not.toHaveBeenCalled()
    }
  })

  it.each(['replace', 'split', 'session'] as const)('resumes Muse as a chat with capped permissions for %s', async (placement) => {
    const { resume, creator } = setup({ conversation: { provider: 'muse' }, chats: [chat({ permissionMode: 'acceptEdits' })] })
    expect(await resume({ provider: 'muse', placement })).toMatchObject({ status: 200 })
    const agent = { provider: 'muse-chat', resume: ID, permissionMode: 'default' }
    if (placement === 'replace') expect(creator.respawnChatPane).toHaveBeenCalledWith('%1', folder, agent)
    else expect(creator.createPane).toHaveBeenCalledWith(expect.objectContaining({ agent }))
  })

  it.each(['plan', 'default'] as const)('refuses to raise a Claude %s chat to Muse sandbox access', async (permissionMode) => {
    const { resume, creator } = setup({ conversation: { provider: 'muse' }, chats: [chat({ permissionMode })] })
    expect(await resume({ provider: 'muse' })).toMatchObject({ status: 403 })
    expect(creator.respawnChatPane).not.toHaveBeenCalled()
    expect(creator.createPane).not.toHaveBeenCalled()
  })

  it('resumes a Muse TUI from a terminal without a saved command', async () => {
    const { resume, creator } = setup({ conversation: { provider: 'muse' }, chats: [], empty: true })
    expect(await resume({ provider: 'muse' })).toMatchObject({ status: 200 })
    expect(creator.respawnChatPane).toHaveBeenCalledWith('%1', folder, undefined, `env muse resume ${ID}`)
  })

  it('resumes a saved chat from outside a chat with default permissions', async () => {
    const { resume, creator } = setup({ chats: [], resumeRecord: { command: `commando-agent codex --resume ${ID}` } })
    expect(await resume({})).toMatchObject({ status: 200 })
    expect(creator.createPane).toHaveBeenCalledWith(expect.objectContaining({ agent: { provider: 'codex-chat', resume: ID, permissionMode: 'default' } }))
  })

  it.each(['claude', 'codex'] as const)('builds a profiled %s TUI without a record from a terminal or empty pane', async (provider) => {
    for (const empty of [false, true]) {
      const { resume, creator } = setup({ chats: [], empty, conversation: { provider, configDir: '/home/me/profile with spaces' } })
      expect(await resume({ provider })).toMatchObject({ status: 200 })
      const command = provider === 'claude'
        ? `env 'CLAUDE_CONFIG_DIR=/home/me/profile with spaces' claude --resume ${ID}`
        : `env 'CODEX_HOME=/home/me/profile with spaces' codex resume ${ID}`
      if (empty) expect(creator.respawnChatPane).toHaveBeenCalledWith('%1', folder, undefined, command)
      else expect(creator.createPane).toHaveBeenCalledWith(expect.objectContaining({ cwd: folder }), undefined, command)
    }
  })

  it('requires a valid requester outside session placement and still reserves session launches', async () => {
    const { resume, creator } = setup({ conversation: { session: { id: '$7', name: 'original' } }, sessions: [{ id: '$7', name: 'original' }] })
    expect(await resume({ paneId: undefined })).toMatchObject({ status: 400 })
    expect(await resume({ paneId: 'bad', placement: 'session' })).toMatchObject({ status: 400 })
    const results = await Promise.all([resume({ paneId: undefined, placement: 'session' }), resume({ paneId: undefined, placement: 'session' })])
    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
    expect(creator.createWindow).toHaveBeenCalledOnce()
  })
})


it.each(['replace', 'split'] as const)('reopens a Cursor agent via %s with inherited sandbox access and no Claude profile', async (placement) => {
  const sessionId = 'agent-11111111-2222-3333-4444-555555555555'
  const { creator, resume } = setup({ conversation: { provider: 'cursor', sessionId, configDir: '/ignored' } })
  expect(await resume({ provider: 'cursor', sessionId, placement })).toMatchObject({ status: 200 })
  const agent = { provider: 'cursor-chat', permissionMode: 'default', resume: sessionId }
  if (placement === 'replace') expect(creator.respawnChatPane).toHaveBeenCalledWith('%1', folder, agent)
  else expect(creator.createPane).toHaveBeenCalledWith(expect.objectContaining({ agent }))
})

it('rejects a Cursor conversation already open in another pane', async () => {
  const sessionId = 'agent-11111111-2222-3333-4444-555555555555'
  const { resume } = setup({ conversation: { provider: 'cursor', sessionId }, chats: [chat(), chat({ paneId: '%2', provider: 'cursor', sessionId })] })
  expect(await resume({ provider: 'cursor', sessionId })).toMatchObject({ status: 409, body: { error: 'That conversation is already open in pane %2' } })
})

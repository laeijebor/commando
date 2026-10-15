import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSessionInfo } from '../shared/agent-chat.js'
import type { AgentStatus, CommandoSnapshot, TmuxPane } from '../shared/protocol.js'
import { TmuxAgentLaunchCompatibilityError, type CreateTmuxSessionRequest, type TmuxCreateResponse } from '../shared/tmux-create.js'
import { AgentChatRequests } from './agent-chat-requests.js'
import { AgentChatsApi, terminalLaunchRank } from './agent-chats-api.js'
import type { AgentLaunch } from './agent-resume-command.js'
import { ChatPlanStore } from './chat-plans.js'
import { GitWorktreeError } from './git-worktree.js'
import { RepoPrepareCommands } from './repo-prepare-commands.js'

const TOKEN = 'agent-hook-token-with-at-least-32-characters'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'commando-agent-chats-'))
  directories.push(dir)
  let now = 0
  const parent = { id: '%1', targetId: 'parent-target', processId: 100, path: '/repo/linked/src', sessionId: '$1', windowId: '@1', title: 'parent', repo: { root: '/repo', name: 'repo', branch: 'parent-branch', isWorktree: true } } as TmuxPane
  const snapshot = { panes: [parent], sessions: [{ id: '$1', name: 'parent' }, { id: '$2', name: 'fix-bug' }], windows: [] } as unknown as CommandoSnapshot
  const statuses = new Map<string, AgentStatus>([['%1', { provider: 'codex', status: 'working' } as AgentStatus]])
  const chats = new Map<string, ChatSessionInfo>()
  // What `ps` shows for each terminal pane's agent; a terminal Codex with no flags by default.
  const launches = new Map<number, AgentLaunch | undefined>([[100, { args: ['codex'], env: {} }]])
  const agentLaunch = vi.fn(async (pid: number) => launches.get(pid))
  const changed = vi.fn()
  const requests = new AgentChatRequests(changed, () => now)
  const prepareCommands = new RepoPrepareCommands(join(dir, 'prepare.json'))
  const plans = new ChatPlanStore({} as never, join(dir, 'plans'))
  const stash = vi.spyOn(plans, 'stash')
  let nextId = 10
  const made = (input: CreateTmuxSessionRequest, kind: 'session' | 'pane' = 'session'): TmuxCreateResponse => {
    const paneId = `%${nextId++}`, cwd = input.worktree ? `/repo/worktrees/${input.worktree.branch}` : input.cwd!
    const created = { paneId, sessionId: kind === 'pane' ? '$1' : `$${nextId}`, sessionName: kind === 'pane' ? 'parent' : input.name, windowId: kind === 'pane' ? '@1' : `@${nextId}`, panePath: cwd, kind, windowIndex: 0, windowName: 'shell', paneIndex: 0 }
    snapshot.panes.push({ ...parent, id: paneId, targetId: `target-${paneId}`, sessionId: created.sessionId, windowId: created.windowId, path: cwd } as TmuxPane)
    if (kind === 'session') snapshot.sessions.push({ id: created.sessionId, name: created.sessionName, attached: false, activeWindowId: created.windowId, windowIds: [created.windowId] })
    return { created, ...(input.worktree ? { worktree: { path: cwd, branch: input.worktree.branch, base: 'main', reusedBranch: false } } : {}),
      agentLaunch: { version: 1, provider: input.agent!.provider, paneId, mode: 'interactive-pty', state: 'initiated' } }
  }
  const createSession = vi.fn(async (input: CreateTmuxSessionRequest) => made(input))
  const createPane = vi.fn(async (input: Parameters<ConstructorParameters<typeof AgentChatsApi>[0]['creator']['createPane']>[0], before?: () => void | Promise<void>) => {
    await before?.()
    const result = made({ name: 'parent', cwd: input.cwd, agent: input.agent, worktree: input.worktree }, 'pane')
    return { ...result.created, worktree: result.worktree, agentLaunch: result.agentLaunch }
  })
  const setChatLineage = vi.fn(async (paneId: string, openedBy: string, chatTitle: string) => {
    Object.assign(snapshot.panes.find((pane) => pane.id === paneId)!, { openedBy, chatTitle })
  })
  const sendChat = vi.fn(() => true), sendTerminal = vi.fn(async () => {}), beforePaneCreated = vi.fn(async () => {}), refreshSnapshot = vi.fn(async () => {})
  const api = new AgentChatsApi({
    agentToken: TOKEN, ownerAuthorized: async (request) => request.headers.authorization === 'Bearer owner', snapshot: () => snapshot,
    status: (id) => statuses.get(id), chatSession: (id) => chats.get(id), chatOwns: (id) => chats.has(id),
    sendChat, sendTerminal, agentLabel: () => 'codex · parent', creator: { createSession, createPane, setChatLineage },
    prepareCommands, plans, requests, agentLaunch, beforePaneCreated, refreshSnapshot, chatCliPath: '/test/hooks/commando-chat.mjs', now: () => now,
  })
  const call = async (method: string, path = '', value?: unknown, token = TOKEN, paneId = '%1') => {
    const request = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]) as IncomingMessage
    request.method = method
    request.headers = { authorization: `Bearer ${token}`, 'x-commando-pane': paneId, 'content-type': 'application/json' }
    let status = 0, result: any
    const response = new EventEmitter() as ServerResponse
    response.setHeader = vi.fn() as never
    response.writeHead = ((code: number) => { status = code; return response }) as never
    response.end = ((raw: string) => { result = JSON.parse(raw); return response }) as never
    await api.handle(request, response, new URL(`http://localhost/api/agent-chats${path}`))
    return { status, result }
  }
  const input = { title: 'Fix bug', prompt: 'Fix it\nTest it\tcarefully' }
  return { api, call, input, snapshot, parent, statuses, chats, launches, agentLaunch, requests, changed, prepareCommands, plans, stash, createSession, createPane, setChatLineage, sendChat, sendTerminal, beforePaneCreated, refreshSnapshot, clock: (value: number) => { now = value } }
}

describe('AgentChatsApi', () => {
  it('rejects bad tokens, malformed pane headers and unknown panes', async () => {
    const s = await setup()
    expect(await s.call('POST', '', s.input, 'bad')).toMatchObject({ status: 401, result: { ok: false } })
    expect(await s.call('POST', '', s.input, TOKEN, 'not-a-pane')).toMatchObject({ status: 400 })
    expect(await s.call('POST', '', s.input, TOKEN, '%99')).toMatchObject({ status: 404 })
    expect(s.createSession).not.toHaveBeenCalled()
  })

  it('creates a default session on a worktree, dedupes names and prepends the literal brief', async () => {
    const s = await setup()
    await s.prepareCommands.set('/repo', 'npm ci\nnpm run build')
    const { status, result } = await s.call('POST', '', s.input)
    expect(status).toBe(200)
    expect(result).toMatchObject({ ok: true, location: 'session', sessionName: 'fix-bug-2', cwd: '/repo/worktrees/fix-bug', targetId: 'target-%10', worktree: { branch: 'fix-bug' }, agent: { provider: 'codex-chat', permissionMode: 'default' } })
    expect(s.createSession).toHaveBeenCalledWith(expect.objectContaining({ name: 'fix-bug-2', cwd: '/repo', worktree: { branch: 'fix-bug', prepareCommand: 'npm ci\nnpm run build' } }))
    const prompt = s.createSession.mock.calls[0][0].agent!.prompt!
    expect(prompt).toContain('codex · parent, pane %1, session parent, branch parent-branch')
    expect(prompt).toContain('node "/test/hooks/commando-chat.mjs" report "<message>"')
    expect(prompt.endsWith(`\n---\n${s.input.prompt}`)).toBe(true)
    expect(s.setChatLineage).toHaveBeenCalledWith('%10', 'parent-target', 'Fix bug')
    expect(s.refreshSnapshot).toHaveBeenCalledTimes(2)
  })

  it('uses the main checkout for no-worktree and the caller cwd for non-repositories', async () => {
    const s = await setup()
    expect((await s.call('POST', '', { ...s.input, worktree: false })).result.cwd).toBe('/repo')
    expect(s.createSession.mock.calls[0][0].worktree).toBeUndefined()
    delete s.parent.repo
    const response = await s.call('POST', '', s.input)
    expect(response.result).toMatchObject({ cwd: s.parent.path, warning: expect.stringContaining('not in a git repository') })
    expect(s.createSession.mock.calls[1][0].worktree).toBeUndefined()
    expect(s.createSession.mock.calls[1][0].agent!.prompt).not.toContain('branch parent-branch')
  })

  it('uses a tmux-safe session name for dotted titles while keeping dots in the branch', async () => {
    const s = await setup()
    const response = await s.call('POST', '', { ...s.input, title: 'Fix README.md' })
    expect(response).toMatchObject({ status: 200, result: { sessionName: 'fix-readme-md', worktree: { branch: 'fix-readme.md' } } })
    expect(s.createSession).toHaveBeenCalledWith(expect.objectContaining({ name: 'fix-readme-md', worktree: expect.objectContaining({ branch: 'fix-readme.md' }) }))
    expect((await s.call('POST', '', { ...s.input, title: 'Fix README.md' })).result.sessionName).toBe('fix-readme-md-2')
  })

  it('rejects invalid input before charging rate tokens', async () => {
    const s = await setup()
    for (const value of [{ title: '' }, { prompt: '' }, { branch: 'bad..branch' }, { branch: ' spaced ' }, { branch: 'bad.lock' }, { location: 'elsewhere' }, { agent: 'bad' }, { permissionMode: 'bad' }, { split: 'down' }]) {
      expect((await s.call('POST', '', { ...s.input, ...value })).status).toBe(400)
    }
    expect((await s.call('POST', '?wait=61', s.input)).status).toBe(400)
    expect(s.createSession).not.toHaveBeenCalled()
    for (let index = 0; index < 3; index++) expect((await s.call('POST', '', s.input)).status).toBe(200)
    expect((await s.call('POST', '', s.input)).status).toBe(202)
  })

  it.each(['right', 'down'] as const)('splits %s after the caller at its cwd, without a worktree', async (split) => {
    const s = await setup()
    expect((await s.call('POST', '', { ...s.input, location: 'pane', split })).status).toBe(200)
    expect(s.createPane).toHaveBeenCalledWith(expect.objectContaining({ targetId: '%1', cwd: s.parent.path, direction: split === 'right' ? 'horizontal' : 'vertical', placement: 'after' }), expect.any(Function))
    expect(s.createPane.mock.calls[0][0].worktree).toBeUndefined()
    expect(s.beforePaneCreated).toHaveBeenCalledWith('@1')
  })

  it('creates a pane worktree only for an explicit branch and uses its prepare command', async () => {
    const s = await setup()
    await s.prepareCommands.set('/repo', 'npm ci')
    const response = await s.call('POST', '', { ...s.input, location: 'pane', branch: 'fix/bug' })
    expect(response.result.worktree).toMatchObject({ branch: 'fix/bug' })
    expect(s.createPane.mock.calls[0][0].worktree).toEqual({ branch: 'fix/bug', prepareCommand: 'npm ci' })
  })

  it('inherits chat config and permissions; allows lowering and rejects raises', async () => {
    const s = await setup()
    s.chats.set('%1', { permissionMode: 'acceptEdits', configDir: '/home/.claudew' } as ChatSessionInfo)
    expect((await s.call('POST', '', s.input)).result.agent).toEqual({ provider: 'claude-chat', permissionMode: 'acceptEdits', configDir: '/home/.claudew' })
    expect((await s.call('POST', '', { ...s.input, permissionMode: 'plan' })).result.agent.permissionMode).toBe('plan')
    expect(await s.call('POST', '', { ...s.input, permissionMode: 'bypassPermissions' })).toMatchObject({ status: 403, result: { ok: false, error: 'Cannot raise permission mode from acceptEdits to bypassPermissions' } })
    expect(s.createSession).toHaveBeenCalledTimes(2)
  })

  it('gives a terminal Codex caller requesting claude-chat unprompted edits; can lower, never bypass', async () => {
    const s = await setup()
    expect((await s.call('POST', '', { ...s.input, agent: 'claude-chat' })).result.agent).toEqual({ provider: 'claude-chat', permissionMode: 'acceptEdits' })
    expect((await s.call('POST', '', { ...s.input, agent: 'claude-chat', permissionMode: 'plan' })).result.agent.permissionMode).toBe('plan')
    expect((await s.call('POST', '', { ...s.input, agent: 'claude-chat', permissionMode: 'bypassPermissions' })).status).toBe(403)
  })

  it.each(['claude', 'codex', 'opencode', 'cursor'] as const)('refuses a plan-mode chat opening %s without charging a rate token', async (agent) => {
    const s = await setup()
    s.chats.set('%1', { permissionMode: 'plan' } as ChatSessionInfo)
    for (const extra of [{ agent }, { agent, permissionMode: 'plan' }]) {
      expect(await s.call('POST', '', { ...s.input, ...extra })).toMatchObject({ status: 403, result: { ok: false, error: 'A plan-mode chat can only open hosted chats (claude-chat, codex-chat, muse-chat or cursor-chat)' } })
    }
    expect(s.createSession).not.toHaveBeenCalled()
    for (let index = 0; index < 3; index++) {
      expect(await s.call('POST', '', s.input)).toMatchObject({ status: 200, result: { agent: { provider: 'claude-chat', permissionMode: 'plan' } } })
    }
  })

  it('opens a hosted chat on a terminal Claude caller\'s profile, as permissive as its launch flags', async () => {
    const s = await setup()
    s.statuses.set('%1', { provider: 'claude', status: 'working' } as AgentStatus)
    s.launches.set(100, { args: ['/Users/leo/.local/bin/claude', '--dangerously-skip-permissions'], env: { CLAUDE_CONFIG_DIR: join(homedir(), '.claudew') } })
    const opened = await s.call('POST', '', s.input)
    expect(opened.result).toMatchObject({ agent: { provider: 'claude-chat', permissionMode: 'bypassPermissions', configDir: join(homedir(), '.claudew') } })
    expect(opened.result.warning).toBeUndefined()
    expect(s.agentLaunch).toHaveBeenCalledWith(100, 'claude')
    expect(s.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ agent: expect.objectContaining({ provider: 'claude-chat', configDir: join(homedir(), '.claudew') }) }))
    // The profile also follows an explicit claude-chat, but never a Codex chat.
    expect((await s.call('POST', '', { ...s.input, agent: 'claude-chat', permissionMode: 'plan' })).result.agent).toEqual({ provider: 'claude-chat', permissionMode: 'plan', configDir: join(homedir(), '.claudew') })
    expect((await s.call('POST', '', { ...s.input, agent: 'codex-chat' })).result.agent).toEqual({ provider: 'codex-chat', permissionMode: 'bypassPermissions' })
  })

  it('caps a terminal caller\'s chat at its launch mode and ignores a profile outside the home folder', async () => {
    const s = await setup()
    s.statuses.set('%1', { provider: 'claude', status: 'working' } as AgentStatus)
    s.launches.set(100, { args: ['claude', '--permission-mode', 'acceptEdits'], env: { CLAUDE_CONFIG_DIR: '/tmp/.claudew' } })
    const opened = await s.call('POST', '', s.input)
    expect(opened.result.agent).toEqual({ provider: 'claude-chat', permissionMode: 'acceptEdits' })
    expect(opened.result.warning).toContain('"/tmp/.claudew" is not a ~/.claude… folder')
    expect(await s.call('POST', '', { ...s.input, permissionMode: 'bypassPermissions' })).toMatchObject({ status: 403, result: { error: 'Cannot raise permission mode from acceptEdits to bypassPermissions' } })
  })

  it('falls back to the default profile, asking first, with a warning when the caller process is unreadable', async () => {
    const s = await setup()
    s.statuses.set('%1', { provider: 'claude', status: 'working' } as AgentStatus)
    for (const unreadable of [async () => undefined, async () => { throw new Error('ps failed') }]) {
      s.agentLaunch.mockImplementationOnce(unreadable).mockImplementationOnce(unreadable)
      const opened = await s.call('POST', '', s.input)
      expect(opened.result).toMatchObject({ agent: { provider: 'claude-chat', permissionMode: 'default' }, warning: expect.stringContaining('default profile') })
      expect(opened.result.agent.configDir).toBeUndefined()
    }
  })

  it('opens codex-chat from a terminal Codex caller, as permissive as its sandbox', async () => {
    const s = await setup()
    s.launches.set(100, { args: ['codex', '--dangerously-bypass-approvals-and-sandbox'], env: {} })
    expect((await s.call('POST', '', s.input)).result.agent).toEqual({ provider: 'codex-chat', permissionMode: 'bypassPermissions' })
    s.launches.set(100, { args: ['codex', '--sandbox=read-only'], env: {} })
    expect((await s.call('POST', '', s.input)).result.agent).toEqual({ provider: 'codex-chat', permissionMode: 'plan' })
  })

  it('ranks terminal launch flags', () => {
    expect(terminalLaunchRank('claude', ['claude'])).toBe(terminalLaunchRank('claude', ['claude', '--permission-mode=default']))
    expect(terminalLaunchRank('claude', ['claude', '--permission-mode', 'auto'])).toBe(terminalLaunchRank('claude', ['claude']))
    expect(terminalLaunchRank('claude', ['claude', '--permission-mode', 'plan'])).toBeLessThan(terminalLaunchRank('claude', ['claude']))
    expect(terminalLaunchRank('codex', ['codex'])).toBe(terminalLaunchRank('claude', ['claude', '--permission-mode', 'acceptEdits']))
    const plan = terminalLaunchRank('claude', ['claude', '--permission-mode', 'plan'])
    expect(terminalLaunchRank('codex', ['codex', '-s', 'read-only'])).toBe(plan)
    expect(terminalLaunchRank('codex', ['codex', '-c', 'sandbox_mode="read-only"'])).toBe(plan)
    // ps splits argv on spaces: a prompt's words are not launch flags.
    const asks = terminalLaunchRank('claude', ['claude'])
    expect(terminalLaunchRank('claude', ['claude', 'what', 'does', '--dangerously-skip-permissions', 'do'])).toBe(asks)
    expect(terminalLaunchRank('claude', ['claude', 'use', '--permission-mode', 'acceptEdits'])).toBe(asks)
    expect(terminalLaunchRank('codex', ['codex', 'explain', '--dangerously-bypass-approvals-and-sandbox'])).toBe(terminalLaunchRank('codex', ['codex']))
    expect(terminalLaunchRank('claude', ['vim', '--dangerously-skip-permissions'])).toBe(asks)
  })

  it('inherits codex-chat and its permission mode from a hosted Codex caller', async () => {
    const s = await setup()
    s.chats.set('%1', { provider: 'codex', permissionMode: 'bypassPermissions', configDir: '/Users/leo/.claudep' } as ChatSessionInfo)
    expect((await s.call('POST', '', s.input)).result.agent).toEqual({ provider: 'codex-chat', permissionMode: 'bypassPermissions' })
    expect(s.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ agent: expect.objectContaining({ provider: 'codex-chat', permissionMode: 'bypassPermissions' }) }))
    expect((await s.call('POST', '', { ...s.input, permissionMode: 'plan' })).result.agent).toEqual({ provider: 'codex-chat', permissionMode: 'plan' })
    expect(await s.call('POST', '', { ...s.input, permissionMode: 'acceptEdits' })).toMatchObject({ status: 400, result: { error: 'codex-chat does not support permission mode acceptEdits' } })
  })

  it('inherits muse-chat from a hosted Muse caller, which ranks with acceptEdits', async () => {
    const s = await setup()
    s.chats.set('%1', { provider: 'muse', permissionMode: 'default' } as ChatSessionInfo)
    expect((await s.call('POST', '', s.input)).result.agent).toEqual({ provider: 'muse-chat', permissionMode: 'default' })
    expect(await s.call('POST', '', { ...s.input, permissionMode: 'plan' })).toMatchObject({ status: 400, result: { error: 'muse-chat does not support permission mode plan' } })
    expect((await s.call('POST', '', { ...s.input, agent: 'claude-chat' })).result.agent).toEqual({ provider: 'claude-chat', permissionMode: 'acceptEdits' })
    expect(await s.call('POST', '', { ...s.input, permissionMode: 'bypassPermissions' })).toMatchObject({ status: 403 })
  })

  it('opens muse-chat from a terminal Muse caller, as permissive as its approval flags', async () => {
    const s = await setup()
    s.statuses.set('%1', { provider: 'muse', status: 'working' } as AgentStatus)
    s.launches.set(100, { args: ['/Users/me/.local/bin/muse-bin-1.4.10-R6427.1', '--yolo'], env: {} })
    expect((await s.call('POST', '', s.input)).result.agent).toEqual({ provider: 'muse-chat', permissionMode: 'bypassPermissions' })
    s.launches.set(100, { args: ['/Users/me/.local/bin/muse-bin-1.4.10-R6427.1', 'fix', '--yolo'], env: {} })
    expect((await s.call('POST', '', s.input)).result.agent).toEqual({ provider: 'muse-chat', permissionMode: 'default' })
    expect(terminalLaunchRank('muse', ['muse', '--yolo'])).toBe(terminalLaunchRank('claude', ['claude', '--dangerously-skip-permissions']))
    expect(terminalLaunchRank('muse', ['muse', '--approval-mode', 'untrusted'])).toBe(terminalLaunchRank('claude', ['claude']))
    expect(terminalLaunchRank('muse', ['muse', '--disable-write'])).toBe(terminalLaunchRank('claude', ['claude', '--permission-mode', 'plan']))
  })

  it('lets a sandboxed approve-everything Muse caller grant no more than acceptEdits', async () => {
    const s = await setup()
    s.chats.set('%1', { provider: 'muse', permissionMode: 'bypassPermissions', bypassAllowed: true } as ChatSessionInfo)
    expect(await s.call('POST', '', { ...s.input, agent: 'claude-chat', permissionMode: 'bypassPermissions' })).toMatchObject({ status: 403, result: { error: 'Cannot raise permission mode from acceptEdits to bypassPermissions' } })
    expect((await s.call('POST', '', { ...s.input, agent: 'claude-chat' })).result.agent).toEqual({ provider: 'claude-chat', permissionMode: 'acceptEdits' })
    // Opening a Muse approve-everything chat still takes a bypass caller.
    expect((await s.call('POST', '', s.input)).result.agent).toEqual({ provider: 'muse-chat', permissionMode: 'default' })
    expect(await s.call('POST', '', { ...s.input, permissionMode: 'bypassPermissions' })).toMatchObject({ status: 403 })
    const bypass = terminalLaunchRank('claude', ['claude', '--dangerously-skip-permissions'])
    const acceptEdits = terminalLaunchRank('claude', ['claude', '--permission-mode', 'acceptEdits'])
    expect(terminalLaunchRank('muse', ['muse', '--disable-approval'])).toBe(acceptEdits)
    expect(terminalLaunchRank('muse', ['muse', '--approval-mode', 'never', '--disable-sandbox'])).toBe(bypass)
  })

  it('refuses a muse-chat for a caller that asks before edits, since Muse has no mode that careful', async () => {
    const s = await setup()
    s.chats.set('%1', { provider: 'claude', permissionMode: 'default' } as ChatSessionInfo)
    expect(await s.call('POST', '', { ...s.input, agent: 'muse-chat' })).toMatchObject({ status: 403, result: { error: expect.stringContaining('muse-chat has no permission mode as restricted as default') } })
    expect(s.createSession).not.toHaveBeenCalled()
  })

  it('applies chat permission rules to an explicit codex-chat child', async () => {
    const s = await setup()
    s.chats.set('%1', { provider: 'claude', permissionMode: 'acceptEdits', configDir: '/Users/leo/.claudep' } as ChatSessionInfo)
    // Codex has no acceptEdits: the inherited mode steps down rather than up, and no Claude profile carries over.
    expect((await s.call('POST', '', { ...s.input, agent: 'codex-chat' })).result.agent).toEqual({ provider: 'codex-chat', permissionMode: 'default' })
    expect(await s.call('POST', '', { ...s.input, agent: 'codex-chat', permissionMode: 'bypassPermissions' })).toMatchObject({ status: 403 })
    s.chats.set('%1', { provider: 'claude', permissionMode: 'plan' } as ChatSessionInfo)
    expect((await s.call('POST', '', { ...s.input, agent: 'codex-chat' })).result.agent).toEqual({ provider: 'codex-chat', permissionMode: 'plan' })
  })

  it('treats Codex workspace access as unprompted edits when comparing with a Claude caller', async () => {
    const s = await setup()
    // A Claude chat that asks before edits cannot open a Codex chat that edits without asking.
    s.chats.set('%1', { provider: 'claude', permissionMode: 'default' } as ChatSessionInfo)
    expect((await s.call('POST', '', { ...s.input, agent: 'codex-chat' })).result.agent).toEqual({ provider: 'codex-chat', permissionMode: 'plan' })
    expect(await s.call('POST', '', { ...s.input, agent: 'codex-chat', permissionMode: 'default' })).toMatchObject({ status: 403 })
    // A Codex workspace-access chat may open a Claude chat that accepts edits, but not one that bypasses.
    s.chats.set('%1', { provider: 'codex', permissionMode: 'default' } as ChatSessionInfo)
    expect((await s.call('POST', '', { ...s.input, agent: 'claude-chat' })).result.agent).toEqual({ provider: 'claude-chat', permissionMode: 'acceptEdits' })
    expect((await s.call('POST', '', s.input)).result.agent).toEqual({ provider: 'codex-chat', permissionMode: 'default' })
    expect(await s.call('POST', '', { ...s.input, agent: 'claude-chat', permissionMode: 'bypassPermissions' })).toMatchObject({ status: 403 })
  })

  it('rejects an unknown inherited provider and permission mode, unsafe input and arbitrary targets', async () => {
    const s = await setup()
    s.statuses.set('%1', { provider: 'unknown' } as AgentStatus)
    expect((await s.call('POST', '', s.input)).status).toBe(400)
    for (const value of [{ agent: 'bad' }, { agent: 'toString' }, { permissionMode: 'bad' }, { title: '' }, { title: 'x'.repeat(81) }, { prompt: 'a\0b' }, { targetId: '%3' }, { repo: '/other' }, { worktree: 'yes' }, { split: 'down' }]) {
      expect((await s.call('POST', '', { ...s.input, ...value })).status).toBe(400)
    }
    expect(s.createSession).not.toHaveBeenCalled()
  })

  it('hard caps incoming prompts at 256 KB', async () => {
    const s = await setup()
    expect((await s.call('POST', '', { ...s.input, prompt: 'é'.repeat(131073) })).status).toBe(413)
    expect(s.createSession).not.toHaveBeenCalled()
  })

  it('exceeds the burst limit, requests owner approval and creates once on accept', async () => {
    const s = await setup()
    for (let index = 0; index < 3; index++) expect((await s.call('POST', '', s.input)).status).toBe(200)
    const pending = await s.call('POST', '', s.input)
    expect(pending).toMatchObject({ status: 202, result: { ok: true, decision: 'pending', requestId: expect.stringMatching(/^cr-/) } })
    const id = pending.result.requestId
    expect(s.requests.pending()[id]).toMatchObject({ callerPaneId: '%1', callerTargetId: 'parent-target', reason: 'rate', requestedBy: 'codex · parent', summary: { provider: 'codex-chat', permissionMode: 'default', branch: 'fix-bug', promptPreview: s.input.prompt } })
    expect(s.createSession).toHaveBeenCalledTimes(3)
    expect((await s.call('POST', `/requests/${id}`, { decision: 'accepted' })).status).toBe(401)
    expect((await s.call('POST', `/requests/${id}`, { decision: 'accepted' }, 'owner')).result).toMatchObject({ decision: 'accepted', paneId: '%13', location: 'session' })
    expect((await s.call('GET', `/requests/${id}`)).result).toMatchObject({ decision: 'accepted', paneId: '%13' })
    expect((await s.call('POST', `/requests/${id}`, { decision: 'accepted' }, 'owner')).status).toBe(409)
    expect(s.createSession).toHaveBeenCalledTimes(4)
    expect((await s.call('POST', '', s.input)).status).toBe(202)
    s.clock(120_000)
    expect((await s.call('POST', '', s.input)).status).toBe(200)
  })

  it('requests depth approval, supersedes an earlier request and allows dismissal', async () => {
    const s = await setup()
    s.parent.openedBy = 'grandparent'
    const first = (await s.call('POST', '', s.input)).result.requestId
    const second = (await s.call('POST', '', { ...s.input, prompt: 'x'.repeat(300) })).result.requestId
    expect((await s.call('GET', `/requests/${first}`)).result.decision).toBe('superseded')
    expect(s.requests.pending()[second]).toMatchObject({ reason: 'depth', summary: { promptPreview: 'x'.repeat(200) } })
    expect((await s.call('POST', `/requests/${second}`, { decision: 'dismissed' }, 'owner')).result.decision).toBe('dismissed')
    expect((await s.call('GET', `/requests/${second}`)).result.decision).toBe('dismissed')
    expect(s.createSession).not.toHaveBeenCalled()
    const third = (await s.call('POST', '', s.input)).result.requestId
    expect((await s.call('POST', `/requests/${third}`, { decision: 'accepted' }, 'owner')).status).toBe(200)
  })

  it.each([
    { location: 'session', expected: 'fix-bug' },
    { location: 'session', title: '!!!', expected: 'chat' },
    { location: 'session', branch: 'custom/branch', expected: 'custom/branch' },
    { location: 'session', worktree: false, expected: undefined },
    { location: 'session', worktree: false, branch: 'explicit', expected: 'explicit' },
    { location: 'pane', expected: undefined },
    { location: 'pane', branch: 'pane-branch', expected: 'pane-branch' },
  ] as const)('uses the same effective branch in approval and creation for %j', async ({ expected, ...overrides }) => {
    const s = await setup()
    s.parent.openedBy = 'grandparent'
    const pending = await s.call('POST', '', { ...s.input, ...overrides })
    expect(pending.status).toBe(202)
    const id = pending.result.requestId
    expect(s.requests.pending()[id].summary.branch).toBe(expected)
    const accepted = await s.call('POST', `/requests/${id}`, { decision: 'accepted' }, 'owner')
    expect(accepted.status).toBe(200)
    expect(accepted.result.worktree?.branch).toBe(expected)
    const created = overrides.location === 'pane' ? s.createPane.mock.calls[0][0] : s.createSession.mock.calls[0][0]
    expect(created.worktree?.branch).toBe(expected)
  })

  it('expires pending requests after ten minutes and validates waits and poll ownership', async () => {
    const s = await setup()
    s.parent.openedBy = 'grandparent'
    const id = (await s.call('POST', '', s.input)).result.requestId
    expect((await s.call('GET', `/requests/${id}?wait=61`)).status).toBe(400)
    s.snapshot.panes.push({ ...s.parent, id: '%2', targetId: 'other-parent' })
    expect((await s.call('GET', `/requests/${id}`, undefined, TOKEN, '%2')).status).toBe(404)
    s.clock(600_000)
    expect((await s.call('GET', `/requests/${id}`)).result.decision).toBe('expired')
    expect(s.requests.pending()).toEqual({})
    expect(s.changed).toHaveBeenCalledTimes(2)
    expect((await s.call('POST', `/requests/${id}`, { decision: 'accepted' }, 'owner')).status).toBe(409)
  })

  it('pins approved launch settings and refuses permission escalation if the caller lowers its mode while waiting', async () => {
    const s = await setup()
    s.parent.openedBy = 'grandparent'
    s.chats.set('%1', { permissionMode: 'acceptEdits' } as ChatSessionInfo)
    const id = (await s.call('POST', '', s.input)).result.requestId
    s.chats.set('%1', { permissionMode: 'plan' } as ChatSessionInfo)
    expect((await s.call('POST', `/requests/${id}`, { decision: 'accepted' }, 'owner')).status).toBe(403)
    expect((await s.call('GET', `/requests/${id}`)).result).toMatchObject({ decision: 'accepted', ok: false, status: 403 })
    expect(s.createSession).not.toHaveBeenCalled()
  })

  it('serializes concurrent opens so session deduplication sees the preceding creation', async () => {
    const s = await setup()
    const results = await Promise.all([s.call('POST', '', { ...s.input, worktree: false }), s.call('POST', '', { ...s.input, worktree: false })])
    expect(results.map((response) => response.result.sessionName)).toEqual(['fix-bug-2', 'fix-bug-3'])
  })

  it('long polls until the owner decides and rechecks caller identity', async () => {
    const s = await setup()
    s.parent.openedBy = 'grandparent'
    const id = (await s.call('POST', '', s.input)).result.requestId
    const poll = s.call('GET', `/requests/${id}?wait=1`)
    s.parent.targetId = 'replacement'
    expect((await s.call('POST', `/requests/${id}`, { decision: 'accepted' }, 'owner')).status).toBe(404)
    expect((await poll).result).toMatchObject({ decision: 'accepted', ok: false, error: 'Caller pane no longer exists' })
    expect(s.createSession).not.toHaveBeenCalled()
  })

  it('lists only children of the caller stable target with known and unknown statuses', async () => {
    const s = await setup()
    await s.call('POST', '', s.input)
    await s.call('POST', '', { ...s.input, location: 'pane', title: 'Beside' })
    s.statuses.set('%10', { status: 'done' } as AgentStatus)
    s.snapshot.panes.push({ ...s.parent, id: '%99', targetId: 'unrelated', openedBy: 'someone-else' })
    expect((await s.call('GET')).result).toEqual([
      { paneId: '%10', targetId: 'target-%10', title: 'Fix bug', sessionName: 'fix-bug-2', cwd: '/repo/worktrees/fix-bug', status: 'done' },
      { paneId: '%11', targetId: 'target-%11', title: 'Beside', sessionName: 'parent', cwd: s.parent.path, status: 'unknown' },
    ])
  })

  it.each([true, false])('reports to a parent (chat=%s) with collapsed newlines', async (chat) => {
    const s = await setup()
    await s.call('POST', '', s.input)
    if (chat) s.chats.set('%1', {} as ChatSessionInfo)
    expect((await s.call('POST', '/report', { message: 'Done\nTests pass\r\nReady' }, TOKEN, '%10')).status).toBe(200)
    const text = '[from %10 · Fix bug] Done Tests pass Ready'
    if (chat) { expect(s.sendChat).toHaveBeenCalledWith('%1', text, expect.any(String)); expect(s.sendTerminal).not.toHaveBeenCalled() }
    else { expect(s.sendTerminal).toHaveBeenCalledWith('%1', text); expect(s.sendChat).not.toHaveBeenCalled() }
  })

  it('returns 409 for non-child reports, 410 for missing parents and 502 for unavailable chats', async () => {
    const s = await setup()
    expect((await s.call('POST', '/report', { message: 'Done' })).status).toBe(409)
    await s.call('POST', '', s.input)
    s.chats.set('%1', {} as ChatSessionInfo)
    s.sendChat.mockReturnValue(false)
    expect((await s.call('POST', '/report', { message: 'Done' }, TOKEN, '%10')).status).toBe(502)
    s.snapshot.panes.splice(0, 1)
    expect((await s.call('POST', '/report', { message: 'Done' }, TOKEN, '%10')).status).toBe(410)
  })

  it('limits reports to 1000 characters and ten burst, refilling one each thirty seconds', async () => {
    const s = await setup()
    await s.call('POST', '', s.input)
    expect((await s.call('POST', '/report', { message: 'x'.repeat(1001) }, TOKEN, '%10')).status).toBe(400)
    for (let index = 0; index < 10; index++) expect((await s.call('POST', '/report', { message: 'Done' }, TOKEN, '%10')).status).toBe(200)
    expect((await s.call('POST', '/report', { message: 'Done' }, TOKEN, '%10')).status).toBe(429)
    s.clock(30_000)
    expect((await s.call('POST', '/report', { message: 'Done' }, TOKEN, '%10')).status).toBe(200)
  })

  it.each(['claude-chat', 'codex'] as const)('stashes the full long brief for %s', async (agent) => {
    const s = await setup()
    const prompt = 'é'.repeat(4200)
    expect((await s.call('POST', '', { ...s.input, agent, prompt })).status).toBe(200)
    const stashed = await s.stash.mock.results[0].value
    expect(await readFile(stashed.path, 'utf8')).toContain(`\n---\n${prompt}`)
    const launch = s.createSession.mock.calls[0][0].agent!
    expect(launch.prompt).toContain(stashed.path)
    expect(Buffer.byteLength(launch.prompt!)).toBeLessThan(8192)
    expect(launch.readableDir).toBe(agent === 'claude-chat' ? stashed.dir : undefined)
  })

  it('returns explicit worktree conflicts and preserves created targets for unacknowledged launches', async () => {
    const s = await setup()
    s.createSession.mockRejectedValueOnce(new GitWorktreeError('branch-checked-out', 'Branch is already checked out'))
    expect((await s.call('POST', '', s.input)).status).toBe(409)
    const original = s.createSession.getMockImplementation()!
    s.createSession.mockImplementationOnce(async (input) => ({ ...await original(input), agentLaunch: undefined }))
    const response = await s.call('POST', '', s.input)
    expect(response).toMatchObject({ status: 502, result: { ok: false, created: { paneId: '%10', targetId: 'target-%10' }, error: expect.stringContaining('do not retry') } })
  })

  it('preserves a compatibility error target and reports lineage failure as a partial creation', async () => {
    const s = await setup()
    const original = s.createSession.getMockImplementation()!
    s.createSession.mockImplementationOnce(async (input) => {
      const response = { ...await original(input), agentLaunch: undefined }
      throw new TmuxAgentLaunchCompatibilityError(response, input.agent!.provider)
    })
    expect(await s.call('POST', '', s.input)).toMatchObject({ status: 502, result: { ok: false, created: { paneId: '%10', targetId: 'target-%10' } } })
    s.setChatLineage.mockRejectedValueOnce(new Error('pane option failed'))
    expect(await s.call('POST', '', s.input)).toMatchObject({ status: 502, result: { ok: false, created: { paneId: '%11' }, error: expect.stringContaining('do not retry') } })
  })
})


it.each([['bypassPermissions', 'bypassPermissions'], ['default', 'default'], ['auto', 'bypassPermissions'], ['plan', 'plan']] as const)('inherits Cursor chat %s as %s without carrying a Claude profile', async (permissionMode, childMode) => {
  const s = await setup()
  s.chats.set('%1', { provider: 'cursor', permissionMode, configDir: '/ignored' } as ChatSessionInfo)
  expect(await s.call('POST', '', s.input)).toMatchObject({ status: 200, result: { agent: { provider: 'cursor-chat', permissionMode: childMode } } })
  expect(s.createSession.mock.calls[0]![0].agent).not.toHaveProperty('configDir')
})

it.each([
  ['bypassPermissions', 'bypassPermissions'], ['acceptEdits', 'default'], ['default', 'plan'], ['auto', 'plan'], ['plan', 'plan'],
] as const)('caps Cursor child from Claude %s to %s', async (parentMode, childMode) => {
  const s = await setup()
  s.chats.set('%1', { provider: 'claude', permissionMode: parentMode } as ChatSessionInfo)
  expect(await s.call('POST', '', { ...s.input, agent: 'cursor-chat' })).toMatchObject({ status: 200, result: { agent: { provider: 'cursor-chat', permissionMode: childMode } } })
  if (parentMode !== 'bypassPermissions') {
    for (const permissionMode of ['bypassPermissions', 'auto']) {
      expect(await s.call('POST', '', { ...s.input, agent: 'cursor-chat', permissionMode })).toMatchObject({ status: 403 })
    }
  }
})

it('validates Cursor modes without widening Claude or Codex launch modes', async () => {
  const s = await setup()
  s.chats.set('%1', { provider: 'cursor', permissionMode: 'bypassPermissions' } as ChatSessionInfo)
  for (const permissionMode of ['acceptEdits', 'dontAsk']) expect(await s.call('POST', '', { ...s.input, agent: 'cursor-chat', permissionMode })).toMatchObject({ status: 400 })
  for (const agent of ['claude-chat', 'codex-chat']) expect(await s.call('POST', '', { ...s.input, agent, permissionMode: 'auto' })).toMatchObject({ status: 400 })
  expect((await s.call('POST', '', { ...s.input, agent: 'cursor-chat', permissionMode: 'auto' })).result.agent).toEqual({ provider: 'cursor-chat', permissionMode: 'auto' })
})


it('treats a Cursor Auto-review parent as full access for Claude, Codex and explicit Cursor children', async () => {
  const s = await setup()
  s.chats.set('%1', { provider: 'cursor', permissionMode: 'auto' } as ChatSessionInfo)
  for (const agent of ['claude-chat', 'codex-chat']) {
    expect(await s.call('POST', '', { ...s.input, agent })).toMatchObject({ status: 200, result: { agent: { provider: agent, permissionMode: 'bypassPermissions' } } })
  }
  expect(await s.call('POST', '', { ...s.input, agent: 'cursor-chat', permissionMode: 'auto' })).toMatchObject({ status: 200, result: { agent: { provider: 'cursor-chat', permissionMode: 'auto' } } })
})

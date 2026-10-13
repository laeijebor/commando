import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatSessionInfo } from '../../shared/agent-chat.js'
import { ChatImageStore } from '../chat-images.js'
import { chatResumeCommand, claudeCodeSwitchCommand, parseHostArgs, restartEnv, sessionFlags, terminalLine, withSessionSettings } from './main.js'
import { AgentSession, PLAN_CAPTURED_MESSAGE, type SessionStore } from './session.js'
import { createChatProviderSession } from './factory.js'
import type { ChatProviderSession } from './provider.js'

/** A stand-in for the SDK query: records prompts and lets the test push messages. */
function fakeQuery() {
  const prompts: SDKUserMessage[] = []
  const outbox: SDKMessage[] = []
  let wake: (() => void) | null = null
  let done = false
  let options: Options | undefined
  const interrupt = vi.fn(async () => undefined)
  const setModel = vi.fn(async (_model?: string) => undefined)
  const applyFlagSettings = vi.fn(async (_settings: Record<string, unknown>) => undefined)
  const setPermissionMode = vi.fn(async (_mode: string) => undefined)
  const stopTask = vi.fn(async (_taskId: string) => undefined)
  const backgroundTasks = vi.fn(async (_toolUseId?: string) => true)
  const supportedModels = vi.fn(async () => [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'], supportsAutoMode: true },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Fast', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'bad model', displayName: 'Bad', description: '' },
  ])
  const getSettings = vi.fn(async (): Promise<{ applied?: { model?: unknown } }> => ({ applied: { model: 'claude-opus-5-5' } }))
  const supportedCommands = vi.fn(async () => [
    { name: 'compact', description: 'Free up context', argumentHint: '<instructions>', builtin: true },
    { name: 'mcp', description: 'Manage MCP servers', argumentHint: '', builtin: true },
    { name: 'model', description: 'Set the model', argumentHint: '<model>', builtin: true },
    { name: 'code-review', description: 'Review the diff', argumentHint: '', aliases: ['review'], builtin: true },
    { name: 'redline', description: 'Review in a tile', argumentHint: '<what>' },
    { name: 'mcp', description: 'A user skill that happens to be called mcp', argumentHint: '' },
  ])
  const contextUsage = vi.fn(async () => ({
    skills: { totalSkills: 2, includedSkills: 2, tokens: 10, skillFrontmatter: [{ name: 'code-review', source: 'built-in', tokens: 5 }, { name: 'redline', source: 'userSettings', tokens: 5 }] },
    categories: [
      { name: 'System tools', tokens: 12_000, color: 'inactive', kind: 'used' },
      { name: 'Messages', tokens: 30_000, color: 'purple', kind: 'used' },
      { name: 'Free space', tokens: 900_000, color: 'promptBorder', kind: 'free' },
    ],
    totalTokens: 42_000, maxTokens: 1_000_000, autoCompactThreshold: 967_000, isAutoCompactEnabled: true,
  }))
  const planUsage = vi.fn(async (_options?: { skipBehaviors?: boolean }): Promise<unknown> => ({
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: { limits: [{ kind: 'session', group: 'session', percent: 38, severity: 'normal', resets_at: '2026-10-13T15:00:00Z' }] },
  }))
  const run = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    options = params.options
    void (async () => { for await (const message of params.prompt) prompts.push(message) })()
    async function* stream(): AsyncGenerator<SDKMessage, void> {
      while (!done) {
        const next = outbox.shift()
        if (next) yield next
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    }
    const handle = stream() as unknown as Query
    Object.assign(handle, { interrupt, setModel, applyFlagSettings, setPermissionMode, stopTask, backgroundTasks, supportedModels, supportedCommands, getSettings, getContextUsage: contextUsage, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: planUsage, close: () => { done = true; wake?.() } })
    return handle
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query
  return {
    run,
    prompts,
    interrupt,
    setModel,
    applyFlagSettings,
    setPermissionMode,
    stopTask,
    backgroundTasks,
    supportedModels,
    supportedCommands,
    getSettings,
    contextUsage,
    planUsage,
    get options() { return options! },
    push(message: SDKMessage) { outbox.push(message); wake?.(); wake = null },
    canUseTool: (...args: Parameters<CanUseTool>) => options!.canUseTool!(...args),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function started(spec: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}, store: SessionStore = { messages: async () => [], title: async () => undefined }) {
  const fake = fakeQuery()
  const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {}, configDir: '/home/me/.claudew', ...spec }, fake.run, () => 1, store)
  const items = new Map<string, ChatItem>()
  const sessions: ChatSessionInfo[] = []
  session.on('items', (changed) => { for (const item of changed) items.set(item.id, item) })
  session.on('session', (info) => sessions.push(info))
  session.start()
  return { fake, session, items, sessions }
}

const signalOptions = (requestId: string) => ({ signal: new AbortController().signal, toolUseID: `tool-${requestId}`, requestId })

describe('AgentSession', () => {
  it('starts the SDK with the pane cwd, chosen config dir and the TUI settings', async () => {
    const { fake } = started({ resume: 'abcd1234-0000', permissionMode: 'bypassPermissions', resumeCommand: '/c/commando-agent claude' })
    await tick()
    expect(fake.options.env).toMatchObject({ COMMANDO_CHAT_RESUME: '/c/commando-agent claude' })
    expect(fake.options).toMatchObject({
      cwd: '/work',
      resume: 'abcd1234-0000',
      env: { CLAUDE_CONFIG_DIR: '/home/me/.claudew' },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
    })
  })

  it('sends user turns as human prompts and tracks running → idle', async () => {
    const { fake, session, items, sessions } = started()
    session.send('  hello  ')
    await tick()
    expect(fake.prompts).toEqual([expect.objectContaining({ message: { role: 'user', content: 'hello' }, origin: { kind: 'human' } })])
    expect([...items.values()][0]).toMatchObject({ kind: 'user_message', text: 'hello' })
    expect(sessions.at(-1)?.status).toBe('running')
    fake.push({ type: 'result', subtype: 'success', session_id: 'sess-1' } as unknown as SDKMessage)
    await tick()
    expect(sessions.at(-1)).toMatchObject({ status: 'idle', sessionId: 'sess-1' })
  })

  it('turns a permission check into a request item and resolves it with the answer', async () => {
    const { fake, session, items, sessions } = started()
    session.send('push it')
    const pending = fake.canUseTool('Bash', { command: 'git push' }, { ...signalOptions('r1'), suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] })
    const request = items.get('request-r1')
    expect(request).toMatchObject({ kind: 'request', requestKind: 'approval', detail: 'git push', status: 'running' })
    expect(sessions.at(-1)?.status).toBe('waiting')
    expect(session.answer('r1', { kind: 'question', answers: {} })).toBe(false)
    expect(session.answer('r1', { kind: 'approval', decision: 'allow_always' })).toBe(true)
    const result = await pending as PermissionResult
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { command: 'git push' }, updatedPermissions: [expect.objectContaining({ type: 'addRules' })] })
    expect(items.get('request-r1')).toMatchObject({ status: 'completed', answer: { decision: 'allow_always' } })
    expect(sessions.at(-1)?.status).toBe('running')
  })

  it('answers AskUserQuestion with the questions and answers the tool expects', async () => {
    const { fake, session, items } = started()
    const questions = [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]
    const pending = fake.canUseTool('AskUserQuestion', { questions }, signalOptions('q1'))
    expect(items.get('request-q1')).toMatchObject({ requestKind: 'question', questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] })
    session.answer('q1', { kind: 'question', answers: { 'Which?': 'B' } })
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { questions, answers: { 'Which?': 'B' } } })
  })

  it('takes a denial for a question as dismissing it, but not an approval', async () => {
    const { fake, session, items } = started()
    const questions = [{ question: 'Which?', multiSelect: false, options: [{ label: 'A', description: '' }] }]
    const pending = fake.canUseTool('AskUserQuestion', { questions }, signalOptions('q2'))
    expect(session.answer('q2', { kind: 'approval', decision: 'allow' })).toBe(false)
    expect(session.answer('q2', { kind: 'approval', decision: 'deny', message: 'The user dismissed the question.' })).toBe(true)
    expect(await pending).toEqual({ behavior: 'deny', message: 'The user dismissed the question.' })
    expect(items.get('request-q2')).toMatchObject({ status: 'interrupted', answer: { kind: 'cancelled', reason: 'Dismissed' } })
  })

  it('denies open requests and interrupts the SDK on interrupt', async () => {
    const { fake, session, items } = started()
    const pending = fake.canUseTool('Write', { file_path: '/work/a' }, signalOptions('r2'))
    await session.interrupt()
    expect(await pending).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(fake.interrupt).toHaveBeenCalled()
    expect(items.get('request-r2')).toMatchObject({ answer: { kind: 'cancelled' } })
  })
})

describe('AgentSession endings', () => {
  it('reads a turn the user stopped as interrupted, not failed', async () => {
    const { fake, session, items, sessions } = started()
    session.send('long job')
    fake.push({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 60' } }] }, parent_tool_use_id: null, uuid: 'a', session_id: 's' } as unknown as SDKMessage)
    await tick()
    await session.interrupt()
    fake.push({ type: 'result', subtype: 'error_during_execution', errors: ['aborted'], session_id: 's' } as unknown as SDKMessage)
    await tick()
    expect(items.get('tool-1')).toMatchObject({ status: 'interrupted' })
    const notices = [...items.values()].filter((item) => item.kind === 'notice')
    expect(notices).toEqual([expect.objectContaining({ level: 'info', text: 'Interrupted' })])
    expect(sessions.at(-1)?.status).toBe('idle')
  })

  it('refuses new turns once the SDK stream has ended', async () => {
    const { fake, session, items, sessions } = started()
    session.close()
    await tick()
    expect(sessions.at(-1)?.status).toBe('closed')
    session.send('anyone there?')
    expect(fake.prompts).toEqual([])
    expect([...items.values()].at(-1)).toMatchObject({ kind: 'notice', level: 'error' })
  })

  it('denies at once when the permission check was already cancelled', async () => {
    const { fake, items } = started()
    const controller = new AbortController()
    controller.abort()
    const result = await fake.canUseTool('Bash', { command: 'ls' }, { signal: controller.signal, toolUseID: 't', requestId: 'r-gone' })
    expect(result).toMatchObject({ behavior: 'deny' })
    expect(items.has('request-r-gone')).toBe(false)
  })
})

describe('commando-agent arguments', () => {
  it('parses Codex options and keeps the provider in resume commands', () => {
    const args = parseHostArgs(['codex', '--model', 'gpt-5.4', '--effort', 'high', '--resume', 'abcd1234-0000'], { CLAUDE_CONFIG_DIR: '/x/.claudep' })
    expect(args).toEqual({ provider: 'codex', permissionMode: 'default', model: 'gpt-5.4', effort: 'high', resume: 'abcd1234-0000' })
    if (typeof args === 'string') throw new Error(args)
    expect(chatResumeCommand('/c/commando-agent', args)).toBe('/c/commando-agent codex --model gpt-5.4 --effort high --permission-mode default')
  })

  it('lists both providers in help and rejects unsupported subcommands', () => {
    expect(parseHostArgs(['codex', '--help'], {})).toMatch(/^Usage: commando-agent <claude\|codex>/)
    expect(parseHostArgs(['cursor'], {})).toMatch(/^Usage/)
    expect(parseHostArgs([], {})).toMatch(/^Usage/)
    expect(parseHostArgs(['codex', '--effort', 'turbo'], {})).toMatch(/Unknown effort/)
  })

  it('reads the config dir from the environment and flags, and maps permissions', () => {
    expect(parseHostArgs(['claude', '--dangerously-skip-permissions'], { CLAUDE_CONFIG_DIR: '/x/.claudep' }))
      .toEqual({ provider: 'claude', permissionMode: 'bypassPermissions', bypassAllowed: true, configDir: '/x/.claudep' })
    expect(parseHostArgs(['claude', '--config-dir', '/y/.claudew', '--resume', 'abcdef12-34', '--model', 'opus'], {}))
      .toMatchObject({ configDir: '/y/.claudew', resume: 'abcdef12-34', model: 'opus', permissionMode: 'default' })
    expect(parseHostArgs(['claude', '--permission-mode', 'yolo'], {})).toMatch(/Unknown permission mode/)
    expect(parseHostArgs(['claude', '--resume', '$(rm -rf)'], {})).toMatch(/Invalid session id/)
    expect(parseHostArgs(['codex'], {})).toEqual({ provider: 'codex', permissionMode: 'default' })
  })

  it('prints finished items as terminal lines and skips streaming ones', () => {
    expect(terminalLine({ id: 'a', turnId: 't', status: 'running', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text: 'partial' })).toBeNull()
    expect(terminalLine({ id: 'b', turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'command', toolUseId: 'x', command: 'npm test' })).toContain('npm test')
  })
})

describe('chat provider sessions', () => {
  it('constructs Claude through the seam', async () => {
    const spec = { paneId: '%3', cwd: '/work', permissionMode: 'default' as const, env: {}, claudePath: '/bin/claude' }
    const session = await createChatProviderSession('claude', spec)
    expect(session.snapshot().session).toMatchObject({ provider: 'claude', status: 'starting' })
    expect(session.tui?.label).toBe('Claude Code')
    session.close()
  })

  it('keeps Claude TUI settings and readiness behind the optional capability', async () => {
    const { session: claude, fake } = started({ claudePath: '/bin/claude', model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', bypassAllowed: true })
    const session: ChatProviderSession = claude
    await tick()
    const tui = session.tui!
    expect(() => tui.command(undefined, [], 'abcd1234-0000')).toThrow(/commando-agent launcher/)
    expect(() => tui.command('/c/commando-agent', [], undefined)).toThrow('this chat has no conversation yet')
    const info = session.snapshot().session
    const args = withSessionSettings({ provider: 'claude', permissionMode: 'acceptEdits', bypassAllowed: true }, info)
    const flags = [...sessionFlags(args), '--readable-dir', '/state/chat-plans/plan-a']
    expect(tui.command('/c/commando-agent', flags, 'abcd1234-0000'))
      .toBe(claudeCodeSwitchCommand({ ...args, readableDir: '/state/chat-plans/plan-a' }, '/bin/claude', '/c/commando-agent', 'abcd1234-0000'))
    expect(tui.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claudew' })
    const ready = vi.fn()
    tui.onReady(ready)
    fake.push({ type: 'system', subtype: 'init', session_id: 'abcd1234-0000', model: 'claude-sonnet-5-5' } as SDKMessage)
    await tick()
    await tui.requestSwitch('after_turn')
    expect(ready).toHaveBeenCalledOnce()
    tui.endSwitch()
    session.close()
  })
})

describe('AgentSession start-up', () => {
  it('shows the earlier turns of a resumed conversation before continuing it', async () => {
    const history = [
      { type: 'user', message: { role: 'user', content: 'What changed?' }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log' } }] }, parent_tool_use_id: null },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'abc fix' }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'One fix landed.' }] }, parent_tool_use_id: null },
      { type: 'user', message: { role: 'user', content: '<local-command-caveat>noise</local-command-caveat>' }, parent_tool_use_id: null },
    ]
    const { items, sessions } = started({ resume: 'abcd1234-0000' }, { messages: async () => history, title: async () => 'Recent changes' })
    await tick()
    await tick()
    expect([...items.values()].map((item) => [item.kind, item.status])).toEqual([
      ['user_message', 'completed'], ['command', 'completed'], ['assistant_message', 'completed'],
    ])
    expect(sessions.at(-1)?.title).toBe('Recent changes')
  })

  it("titles a chat from its first prompt without that prompt's attachment notes", async () => {
    const firstPrompt = 'Why is this pane blank?\n\n[Attached image "pane.png" is saved at: /sessions/abcd1234-0000/x.png]'
    const { sessions } = started({ resume: 'abcd1234-0000' }, { messages: async () => [], title: async () => firstPrompt })
    await tick()
    await tick()
    expect(sessions.at(-1)?.title).toBe('Why is this pane blank?')
  })

  it('reports a history it cannot read and still starts', async () => {
    const { fake, items } = started({ resume: 'abcd1234-0000' }, { messages: async () => { throw new Error('no transcript') }, title: async () => undefined })
    await tick()
    expect([...items.values()][0]).toMatchObject({ kind: 'notice', level: 'error' })
    expect(fake.options).toBeDefined()
  })

  it('sends the opening prompt and titles the chat after it', async () => {
    const { fake, sessions } = started({ initialPrompt: 'Tidy the README please' })
    await tick()
    expect(fake.prompts).toEqual([expect.objectContaining({ message: { role: 'user', content: 'Tidy the README please' } })])
    expect(sessions.at(-1)?.title).toBe('Tidy the README please')
  })
})

describe('commando-agent resume and prompt arguments', () => {
  it('takes an opening prompt and builds the chat resume command from session flags only', () => {
    const args = parseHostArgs(['claude', '--config-dir', '/x/.claudew', '--permission-mode', 'acceptEdits', '--prompt', 'hi there'], {})
    if (typeof args === 'string') throw new Error(args)
    expect(args.prompt).toBe('hi there')
    expect(chatResumeCommand('/c/scripts/commando-agent', args)).toBe('/c/scripts/commando-agent claude --config-dir /x/.claudew --permission-mode acceptEdits')
  })
})

describe('commando-agent prompt parsing', () => {
  it('keeps a prompt that starts with dashes', () => {
    expect(parseHostArgs(['claude', '--prompt', '--- yaml notes'], {})).toMatchObject({ prompt: '--- yaml notes' })
    expect(parseHostArgs(['claude', '--prompt'], {})).toMatch(/needs a value/)
  })
})

describe('AgentSession resume replay', () => {
  it('holds sends until the earlier turns have replayed, then starts a new turn after them', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const history = [
      { type: 'user', message: { role: 'user', content: 'Earlier question' }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Earlier answer' }] }, parent_tool_use_id: null },
    ]
    const { fake, session, items } = started({ resume: 'abcd1234-0000' }, { messages: async () => { await gate; return history }, title: async () => undefined })
    session.send('new question')
    await tick()
    expect(fake.prompts).toEqual([])
    expect(items.size).toBe(0)
    release()
    await tick()
    await tick()
    const ordered = [...items.values()]
    expect(ordered.map((item) => item.kind === 'user_message' || item.kind === 'assistant_message' ? item.text : item.kind))
      .toEqual(['Earlier question', 'Earlier answer', 'new question'])
    expect(ordered[2]!.turnId).not.toBe(ordered[1]!.turnId)
    expect(fake.prompts).toEqual([expect.objectContaining({ message: { role: 'user', content: 'new question' } })])
  })
})

const system = (subtype: string, fields: Record<string, unknown> = {}) => ({ type: 'system', subtype, session_id: 's', uuid: 'u', ...fields } as unknown as SDKMessage)

describe('AgentSession state from Claude', () => {
  it('starts Claude with summarized thinking, the chosen effort and session state events', async () => {
    const { fake } = started({ effort: 'high' })
    await tick()
    expect(fake.options).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
      env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
    })
    expect(fake.options.allowDangerouslySkipPermissions).toBeUndefined()
  })

  it('stays running until Claude reports idle, so a folded-in send never sticks', async () => {
    const { fake, session, sessions } = started()
    fake.push(system('session_state_changed', { state: 'running' }))
    session.send('first')
    session.send('second, folded into the same turn')
    await tick()
    // One result for two sends: Claude folded the second message into the turn.
    fake.push({ type: 'result', subtype: 'success', session_id: 's' } as unknown as SDKMessage)
    await tick()
    expect(sessions.at(-1)?.status).toBe('running')
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(sessions.at(-1)?.status).toBe('idle')
    expect(session.busy).toBe(false)
  })

  it('reads requires_action as waiting and ignores state once the session has ended', async () => {
    const { fake, session, sessions } = started()
    fake.push(system('session_state_changed', { state: 'requires_action' }))
    await tick()
    expect(sessions.at(-1)?.status).toBe('waiting')
    session.close()
    await tick()
    expect(sessions.at(-1)?.status).toBe('closed')
  })

  it('follows permission mode changes Claude makes itself', async () => {
    const { fake, sessions } = started()
    fake.push(system('status', { status: null, permissionMode: 'plan' }))
    await tick()
    expect(sessions.at(-1)?.permissionMode).toBe('plan')
    fake.push(system('init', { model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits' }))
    await tick()
    expect(sessions.at(-1)).toMatchObject({ permissionMode: 'acceptEdits', model: 'claude-sonnet-5-5' })
  })

  it('lists the models Claude offers and reads context usage at start and when idle', async () => {
    const { fake, sessions } = started()
    await tick()
    expect(sessions.at(-1)?.models?.map((model) => model.value)).toEqual(['default', 'sonnet'])
    expect(sessions.at(-1)?.models?.[1]).toEqual({ value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Fast', resolvedModel: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'] })
    expect(sessions.at(-1)?.contextUsage).toEqual({
      usedTokens: 42_000, maxTokens: 1_000_000, autoCompactThreshold: 967_000, autoCompact: true,
      categories: [{ name: 'Messages', tokens: 30_000 }, { name: 'System tools', tokens: 12_000 }],
    })
    expect(fake.contextUsage).toHaveBeenCalledWith({ detail: 'summary' })
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(fake.contextUsage).toHaveBeenCalledTimes(2)
  })

  it('reads plan limits at start, follows rate-limit events, and re-reads after turns at most once a minute', async () => {
    const fake = fakeQuery()
    let now = 1_000
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {} }, fake.run, () => now, { messages: async () => [], title: async () => undefined })
    const sessions: ChatSessionInfo[] = []
    session.on('session', (info) => sessions.push(info))
    void session.start()
    await tick()
    expect(fake.planUsage).toHaveBeenCalledWith({ skipBehaviors: true })
    expect(sessions.at(-1)?.planUsage).toEqual({ plan: 'max', updatedAt: 1_000, limits: [{ kind: 'session', title: 'Current session', percent: 38, severity: 'normal', resetsAt: Date.parse('2026-10-13T15:00:00Z') }] })
    now = 2_000
    fake.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.81, resetsAt: 1_800_000_000 } } }, uuid: 'u', session_id: 's' } as unknown as SDKMessage)
    await tick()
    expect(sessions.at(-1)?.planUsage?.limits[0]).toMatchObject({ percent: 81, severity: 'warning', resetsAt: 1_800_000_000_000 })
    // No read was under way, so the event leaves the once-a-minute limit alone (checked below).
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(fake.planUsage).toHaveBeenCalledTimes(1)
    now = 62_000
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(fake.planUsage).toHaveBeenCalledTimes(2)
    session.close()
  })

  it('keeps a rate-limit event over a /usage read that was already under way', async () => {
    const fake = fakeQuery()
    let finishRead!: (report: unknown) => void
    fake.planUsage.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve }))
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {} }, fake.run, () => 100_000, { messages: async () => [], title: async () => undefined })
    const sessions: ChatSessionInfo[] = []
    session.on('session', (info) => sessions.push(info))
    void session.start()
    await tick()
    fake.push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1_800_000_000 } } }, uuid: 'u', session_id: 's' } as unknown as SDKMessage)
    await tick()
    finishRead({ subscription_type: 'max', rate_limits_available: true, rate_limits: { limits: [{ kind: 'session', group: 'session', percent: 40, severity: 'normal', resets_at: null }] } })
    await tick()
    expect(sessions.at(-1)?.planUsage?.limits[0]).toMatchObject({ kind: 'session', percent: 100, reached: true })
    // The dropped read is retried at the next turn's end.
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(fake.planUsage).toHaveBeenCalledTimes(2)
    session.close()
  })

  it('keeps the last plan reading when a later one fails', async () => {
    const log = vi.fn()
    const fake = fakeQuery()
    let now = 1_000
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {}, log }, fake.run, () => now, { messages: async () => [], title: async () => undefined })
    const sessions: ChatSessionInfo[] = []
    session.on('session', (info) => sessions.push(info))
    void session.start()
    await tick()
    fake.planUsage.mockResolvedValueOnce({ subscription_type: 'max', rate_limits_available: true, rate_limits: null })
    now = 100_000
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(sessions.at(-1)?.planUsage).toMatchObject({ updatedAt: 1_000 })
    expect(log).toHaveBeenCalledWith("Couldn't read plan usage: Claude returned no limits")
    now = 200_000
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(fake.planUsage).toHaveBeenCalledTimes(3)
    expect(sessions.at(-1)?.planUsage).toMatchObject({ updatedAt: 200_000 })
    session.close()
  })

  it('leaves the meter out, and stops asking, for a login without plan limits', async () => {
    const fake = fakeQuery()
    fake.planUsage.mockResolvedValueOnce({ subscription_type: null, rate_limits_available: false, rate_limits: null })
    let now = 1_000
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {} }, fake.run, () => now, { messages: async () => [], title: async () => undefined })
    const sessions: ChatSessionInfo[] = []
    session.on('session', (info) => sessions.push(info))
    void session.start()
    await tick()
    now = 100_000
    fake.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1 } } }, uuid: 'u', session_id: 's' } as unknown as SDKMessage)
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(fake.planUsage).toHaveBeenCalledTimes(1)
    expect(sessions.some((info) => info.planUsage)).toBe(false)
    session.close()
  })

  it('logs, rather than shows, a model list or meter it cannot read', async () => {
    const log = vi.fn()
    const fake = fakeQuery()
    fake.supportedModels.mockRejectedValueOnce(new Error('offline'))
    fake.contextUsage.mockRejectedValueOnce(new Error('busy'))
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {}, log }, fake.run, () => 1, { messages: async () => [], title: async () => undefined })
    const items: ChatItem[] = []
    session.on('items', (changed) => items.push(...changed))
    void session.start()
    await tick()
    expect(log.mock.calls.map(([line]) => line)).toEqual(["Couldn't list Claude's models: offline", "Couldn't read context usage: busy"])
    expect(items).toEqual([])
  })
})

describe('AgentSession settings', () => {
  it('switches model, effort and mode on the running query and remembers the picks', async () => {
    const { fake, session, sessions } = started({ model: 'haiku' })
    await tick()
    expect(sessions.at(-1)?.selectedModel).toBe('haiku')
    await session.configure({ model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits' })
    expect(fake.setModel).toHaveBeenCalledWith('sonnet')
    expect(fake.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'high' })
    expect(fake.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
    expect(sessions.at(-1)).toMatchObject({ selectedModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'high', permissionMode: 'acceptEdits' })
  })

  it('stops claiming an effort the new model does not offer', async () => {
    const { session, sessions } = started({ effort: 'max' })
    await tick()
    await session.configure({ model: 'sonnet' })
    expect(sessions.at(-1)?.effort).toBeUndefined()
    await session.configure({ effort: 'high' })
    await session.configure({ model: 'default' })
    expect(sessions.at(-1)?.effort).toBe('high')
  })

  it('stops claiming an effort on a model without effort levels', async () => {
    const fake = fakeQuery()
    fake.supportedModels.mockResolvedValueOnce([
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', description: '', supportsEffort: true, supportedEffortLevels: ['high'] },
      { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: '', supportsEffort: false, supportedEffortLevels: [] },
    ])
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', effort: 'high', env: {}, log: () => {} }, fake.run, () => 1, { messages: async () => [], title: async () => undefined })
    const sessions: ChatSessionInfo[] = []
    session.on('session', (info) => sessions.push(info))
    void session.start()
    await tick()
    await session.configure({ model: 'haiku' })
    expect(sessions.at(-1)).toMatchObject({ selectedModel: 'haiku' })
    expect(sessions.at(-1)?.effort).toBeUndefined()
  })

  it('refuses an effort the current model does not offer', async () => {
    const { fake, session, sessions, items } = started({ effort: 'high' })
    await tick()
    await session.configure({ model: 'sonnet' })
    await session.configure({ effort: 'max' })
    expect(fake.applyFlagSettings).not.toHaveBeenCalled()
    expect(sessions.at(-1)).toMatchObject({ selectedModel: 'sonnet', effort: 'high' })
    expect([...items.values()].filter((item) => item.kind === 'notice').map((item) => item.kind === 'notice' && item.text))
      .toEqual(["Sonnet 5.5 doesn't offer max effort."])
    await session.configure({ model: 'default', effort: 'max' })
    expect(fake.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' })
    expect(sessions.at(-1)?.effort).toBe('max')
  })

  it('names the model a fresh chat will run before its first turn, and checks effort against it', async () => {
    const fake = fakeQuery()
    fake.getSettings.mockResolvedValueOnce({ applied: { model: 'claude-sonnet-5-5' } })
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {} }, fake.run, () => 1, { messages: async () => [], title: async () => undefined })
    const sessions: ChatSessionInfo[] = []
    const items: ChatItem[] = []
    session.on('session', (info) => sessions.push(info))
    session.on('items', (changed) => items.push(...changed))
    void session.start()
    await tick()
    expect(sessions.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5' })
    expect(sessions.at(-1)?.selectedModel).toBeUndefined()
    await session.configure({ effort: 'max' })
    expect(fake.applyFlagSettings).not.toHaveBeenCalled()
    expect(items.flatMap((item) => item.kind === 'notice' ? [item.text] : [])).toEqual(["Sonnet 5.5 doesn't offer max effort."])
  })

  it('checks a fresh chat’s effort against the default row when Claude cannot say its model', async () => {
    const log = vi.fn()
    const fake = fakeQuery()
    fake.getSettings.mockRejectedValueOnce(new Error('unsupported'))
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {}, log }, fake.run, () => 1, { messages: async () => [], title: async () => undefined })
    const sessions: ChatSessionInfo[] = []
    session.on('session', (info) => sessions.push(info))
    void session.start()
    await tick()
    expect(log).toHaveBeenCalledWith("Couldn't read the model Claude will run: unsupported")
    expect(sessions.at(-1)?.model).toBeUndefined()
    await session.configure({ effort: 'xhigh' })
    expect(fake.applyFlagSettings).not.toHaveBeenCalled()
    await session.configure({ effort: 'max' })
    expect(fake.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' })
  })

  it('checks effort against the model behind a context-window variant', async () => {
    const fake = fakeQuery()
    fake.getSettings.mockResolvedValueOnce({ applied: { model: 'claude-sonnet-5-5[1m]' } })
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {} }, fake.run, () => 1, { messages: async () => [], title: async () => undefined })
    void session.start()
    await tick()
    await session.configure({ effort: 'max' })
    expect(fake.applyFlagSettings).not.toHaveBeenCalled()
    await session.configure({ effort: 'high' })
    expect(fake.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'high' })
  })

  it('leaves the model unset when Claude has no settings to read', async () => {
    const fake = fakeQuery()
    fake.getSettings.mockResolvedValueOnce({})
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {} }, fake.run, () => 1, { messages: async () => [], title: async () => undefined })
    const sessions: ChatSessionInfo[] = []
    session.on('session', (info) => sessions.push(info))
    void session.start()
    await tick()
    expect(sessions.at(-1)?.models).toHaveLength(2)
    expect(sessions.at(-1)?.model).toBeUndefined()
  })

  it('keeps a model picked before Claude says which one it would have run', async () => {
    const fake = fakeQuery()
    let answer!: (value: { applied: { model: string } }) => void
    fake.getSettings.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {} }, fake.run, () => 1, { messages: async () => [], title: async () => undefined })
    const sessions: ChatSessionInfo[] = []
    session.on('session', (info) => sessions.push(info))
    void session.start()
    await tick()
    await session.configure({ model: 'sonnet' })
    answer({ applied: { model: 'claude-opus-5-5' } })
    await tick()
    expect(sessions.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', selectedModel: 'sonnet' })
  })

  it('checks effort against the alias row of a model started by its full id', async () => {
    const { fake, session, items } = started({ model: 'claude-sonnet-5-5' })
    await tick()
    await session.configure({ effort: 'max' })
    expect(fake.applyFlagSettings).not.toHaveBeenCalled()
    expect([...items.values()].filter((item) => item.kind === 'notice').map((item) => item.kind === 'notice' && item.text))
      .toEqual(["Sonnet 5.5 doesn't offer max effort."])
  })

  it('retries a model list that failed to load once a turn ends', async () => {
    const { fake, sessions } = (() => {
      const fake = fakeQuery()
      fake.supportedModels.mockRejectedValueOnce(new Error('offline'))
      const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {}, log: () => {} }, fake.run, () => 1, { messages: async () => [], title: async () => undefined })
      const sessions: ChatSessionInfo[] = []
      session.on('session', (info) => sessions.push(info))
      void session.start()
      return { fake, sessions }
    })()
    await tick()
    expect(sessions.at(-1)?.models).toBeUndefined()
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(fake.supportedModels).toHaveBeenCalledTimes(2)
    expect(sessions.at(-1)?.models?.length).toBe(2)
  })

  it('treats the default model as no explicit pick', async () => {
    const { fake, session, sessions } = started({ model: 'sonnet' })
    await tick()
    await session.configure({ model: 'default' })
    expect(fake.setModel).toHaveBeenCalledWith(undefined)
    expect(sessions.at(-1)).toMatchObject({ model: 'claude-opus-5-5' })
    expect(sessions.at(-1)?.selectedModel).toBeUndefined()
  })

  it('refuses unknown models and bypass in a chat not started with it, and reports SDK failures', async () => {
    const { fake, session, items } = started()
    await tick()
    await session.configure({ model: 'gpt-9', permissionMode: 'bypassPermissions' })
    expect(fake.setModel).not.toHaveBeenCalled()
    expect(fake.setPermissionMode).not.toHaveBeenCalled()
    fake.applyFlagSettings.mockRejectedValueOnce(new Error('no effort here'))
    await session.configure({ effort: 'max' })
    expect([...items.values()].filter((item) => item.kind === 'notice').map((item) => item.kind === 'notice' && item.text)).toEqual([
      "Claude doesn't offer the model gpt-9 here.",
      'Bypass permissions is only available in a chat started with it.',
      "Couldn't change the effort: no effort here",
    ])
  })

  it('keeps bypass available in a chat started with it', async () => {
    const { fake, session, sessions } = started({ permissionMode: 'default', bypassAllowed: true })
    await tick()
    expect(fake.options.allowDangerouslySkipPermissions).toBe(true)
    await session.configure({ permissionMode: 'bypassPermissions' })
    expect(fake.setPermissionMode).toHaveBeenCalledWith('bypassPermissions')
    expect(sessions.at(-1)).toMatchObject({ permissionMode: 'bypassPermissions', bypassAllowed: true })
  })
})

describe('commando-agent restart environment', () => {
  const env = {
    COMMANDO_PORT: '4410',
    COMMANDO_AGENT_HOOK_TOKEN_PATH: '/state/hook-token',
    COMMANDO_TMUX_SOCKET_NAME: 'chat-providers',
    COMMANDO_TMUX_SOCKET_PATH: '/state/tmux.sock',
    COMMANDO_CHAT_IMAGES_DIR: '/state/chat-images',
    COMMANDO_CHAT_PLANS_DIR: '/state/chat-plans',
    CLAUDE_CONFIG_DIR: '/home/me/.claudew',
    OTHER_ENV: 'ignored',
  }
  const daemonEnv = [
    '-e', 'COMMANDO_PORT=4410',
    '-e', 'COMMANDO_AGENT_HOOK_TOKEN_PATH=/state/hook-token',
    '-e', 'COMMANDO_TMUX_SOCKET_NAME=chat-providers',
    '-e', 'COMMANDO_TMUX_SOCKET_PATH=/state/tmux.sock',
    '-e', 'COMMANDO_CHAT_IMAGES_DIR=/state/chat-images',
    '-e', 'COMMANDO_CHAT_PLANS_DIR=/state/chat-plans',
  ]

  it('includes CODEX_HOME for Codex when set', () => {
    expect(restartEnv('codex', { ...env, CODEX_HOME: '/home/me/Codex account' }))
      .toEqual([...daemonEnv, '-e', 'CODEX_HOME=/home/me/Codex account'])
  })

  it('omits CODEX_HOME for Codex when unset or empty', () => {
    expect(restartEnv('codex', env)).toEqual(daemonEnv)
    expect(restartEnv('codex', { ...env, CODEX_HOME: '' })).toEqual(daemonEnv)
    expect(restartEnv('codex', {})).toEqual([])
  })

  it('keeps Claude restart environment byte-identical even when CODEX_HOME is set', () => {
    expect(restartEnv('claude', { ...env, CODEX_HOME: '/home/me/.codex-work' })).toEqual(daemonEnv)
    expect(restartEnv('claude', { COMMANDO_PORT: '4410', COMMANDO_TMUX_SOCKET_NAME: '' }))
      .toEqual(['-e', 'COMMANDO_PORT=4410'])
  })
})

describe('commando-agent settings flags', () => {
  it('reads effort and the bypass allowance', () => {
    expect(parseHostArgs(['claude', '--effort', 'xhigh', '--allow-dangerously-skip-permissions'], {}))
      .toEqual({ provider: 'claude', permissionMode: 'default', effort: 'xhigh', bypassAllowed: true })
    expect(parseHostArgs(['claude', '--effort', 'turbo'], {})).toMatch(/Unknown effort/)
    // The daemon only accepts model ids, so a host never starts with one it would reject.
    expect(parseHostArgs(['claude', '--model', 'opus plus'], {})).toMatch(/Invalid model/)
    expect(parseHostArgs(['claude', '--model', 'opus[1m]'], {})).toMatchObject({ model: 'opus[1m]' })
    expect(parseHostArgs(['claude', '--permission-mode', 'bypassPermissions'], {})).toMatchObject({ bypassAllowed: true })
  })

  it("takes one stashed plan's folder to read, keeps it across restarts, and refuses any other", () => {
    const env = { COMMANDO_CHAT_PLANS_DIR: '/state/chat-plans' }
    const dir = `/state/chat-plans/${'b'.repeat(32)}`
    const args = parseHostArgs(['claude', '--readable-dir', dir, '--prompt', 'PLEASE IMPLEMENT'], env)
    expect(args).toMatchObject({ readableDir: dir, prompt: 'PLEASE IMPLEMENT' })
    expect(sessionFlags(args as Exclude<typeof args, string>)).toEqual(['--permission-mode', 'default', '--readable-dir', dir])
    expect(chatResumeCommand('/c/commando-agent', args as Exclude<typeof args, string>)).toContain(`--readable-dir ${dir}`)
    expect(parseHostArgs(['claude', '--readable-dir', '/state/chat-plans'], env)).toMatch(/stashed plan's folder/)
    expect(parseHostArgs(['claude', '--readable-dir', '/Users/me'], env)).toMatch(/stashed plan's folder/)
  })

  it('carries what the pickers changed into the restart and resume flags', () => {
    const args = parseHostArgs(['claude', '--config-dir', '/x/.claudew', '--model', 'haiku', '--dangerously-skip-permissions', '--prompt', 'hi'], {})
    if (typeof args === 'string') throw new Error(args)
    const info: ChatSessionInfo = { paneId: '%3', provider: 'claude', cwd: '/w', status: 'idle', hostPid: 1, hostVersion: 1, model: 'claude-sonnet-5-5', selectedModel: 'sonnet', effort: 'high', permissionMode: 'plan' }
    const next = withSessionSettings(args, info)
    expect(sessionFlags(next)).toEqual(['--config-dir', '/x/.claudew', '--model', 'sonnet', '--effort', 'high', '--permission-mode', 'plan', '--allow-dangerously-skip-permissions'])
    expect(chatResumeCommand('/c/commando-agent', next)).toBe('/c/commando-agent claude --config-dir /x/.claudew --model sonnet --effort high --permission-mode plan --allow-dangerously-skip-permissions')
    // Picking the default model drops the explicit one; an unknown mode keeps the launch mode.
    const { selectedModel: _picked, ...defaults } = info
    expect(sessionFlags(withSessionSettings(args, { ...defaults, permissionMode: 'weird' }))).toEqual(['--config-dir', '/x/.claudew', '--effort', 'high', '--permission-mode', 'bypassPermissions'])
  })

  it('keeps the mode a plan-mode chat returns to on Implement across a restart or resume', async () => {
    const args = parseHostArgs(['claude', '--permission-mode', 'default'], {})
    if (typeof args === 'string') throw new Error(args)
    const info: ChatSessionInfo = { paneId: '%3', provider: 'claude', cwd: '/w', status: 'idle', hostPid: 1, hostVersion: 1, permissionMode: 'plan', prePlanPermissionMode: 'acceptEdits' }
    const flags = sessionFlags(withSessionSettings(args, info))
    expect(flags).toEqual(['--permission-mode', 'plan', '--pre-plan-permission-mode', 'acceptEdits'])
    // The respawned host parses them back and starts in plan mode, remembering acceptEdits.
    const restarted = parseHostArgs(['claude', ...flags, '--resume', 'abcd1234-0000'], {})
    if (typeof restarted === 'string') throw new Error(restarted)
    expect(restarted).toMatchObject({ permissionMode: 'plan', prePlanPermissionMode: 'acceptEdits' })
    const { fake, sessions } = started({ resume: 'abcd1234-0000', permissionMode: restarted.permissionMode, prePlanPermissionMode: restarted.prePlanPermissionMode })
    await tick()
    // Claude's init repeats plan mode; that isn't a fresh entry into it.
    fake.push(system('init', { model: 'claude-haiku-4-5', permissionMode: 'plan' }))
    await tick()
    expect(sessions.at(-1)).toMatchObject({ permissionMode: 'plan', prePlanPermissionMode: 'acceptEdits' })
    // Out of plan mode the remembered mode is stale, so it isn't carried.
    expect(sessionFlags(withSessionSettings(args, { ...info, permissionMode: 'acceptEdits' }))).toEqual(['--permission-mode', 'acceptEdits'])
    expect(parseHostArgs(['claude', '--pre-plan-permission-mode', 'plan'], {})).toMatch(/Unknown pre-plan permission mode/)
    expect(parseHostArgs(['claude', '--pre-plan-permission-mode', 'weird'], {})).toMatch(/Unknown pre-plan permission mode/)
  })
})

describe('AgentSession richer input', () => {
  const imageId = `${'c'.repeat(64)}.png`
  const images = {
    read: vi.fn(async (id: string) => {
      if (id !== imageId) throw new Error('ENOENT: no such file')
      return Buffer.from('png-bytes')
    }),
    saveBase64: vi.fn(() => undefined),
    sessionDir: vi.fn((sessionId: string) => `/sessions/${sessionId}`),
    stage: vi.fn(async (id: string, sessionId: string) => {
      if (id !== imageId) throw new Error('ENOENT: no such file')
      return `/sessions/${sessionId}/${id}`
    }),
    stagedImage: (path: string) => {
      const match = /^\/sessions\/([^/]+)\/([^/]+)$/.exec(path)
      return match ? { sessionId: match[1]!, id: match[2]! } : null
    },
  }

  it('lists commands and skills, hiding TUI-only built-ins but not same-named user entries', async () => {
    const { fake, session } = started()
    const lists: unknown[] = []
    session.on('commands', (commands) => lists.push(commands))
    await tick()
    await tick()
    expect(fake.supportedCommands).toHaveBeenCalled()
    expect(session.commands).toEqual([
      { name: 'compact', description: 'Free up context', argumentHint: '<instructions>', kind: 'command' },
      { name: 'code-review', description: 'Review the diff', aliases: ['review'], kind: 'skill' },
      { name: 'redline', description: 'Review in a tile', argumentHint: '<what>', kind: 'skill' },
      { name: 'mcp', description: 'A user skill that happens to be called mcp', kind: 'command' },
    ])
    expect(lists.length).toBeGreaterThanOrEqual(1)
  })

  it('replaces the list when Claude reports new commands', async () => {
    const { fake, session } = started()
    await tick()
    await tick()
    fake.push({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'redline', description: 'Review', argumentHint: '' }, { name: 'new-skill', description: 'Fresh', argumentHint: '' }], session_id: 's', uuid: 'u' } as unknown as SDKMessage)
    await tick()
    expect(session.commands?.map((command) => [command.name, command.kind])).toEqual([['redline', 'skill'], ['new-skill', 'command']])
  })

  it('sends images before the text and names their copies in the session folder', async () => {
    const { fake, session, items } = started({ images })
    const sessionId = fake.options.sessionId
    session.send('what is this?', [{ id: imageId, name: 'pane.png' }])
    session.send('and a follow-up')
    await tick()
    await tick()
    expect(fake.prompts).toHaveLength(2)
    expect(fake.prompts[0]!.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png-bytes').toString('base64') } },
      { type: 'text', text: `what is this?\n\n[Attached image "pane.png" is saved at: /sessions/${sessionId}/${imageId}]` },
    ])
    expect(fake.prompts[1]!.message.content).toBe('and a follow-up')
    const users = [...items.values()].filter((item) => item.kind === 'user_message')
    expect(users[0]).toMatchObject({ text: 'what is this?', images: [{ id: imageId, name: 'pane.png' }] })
  })

  it('gives Claude only its own session folder, never the whole image store', async () => {
    const { fake } = started({ images })
    await tick()
    // A new conversation gets its id up front, so resuming it finds the same folder.
    expect(fake.options.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.options.additionalDirectories).toEqual([`/sessions/${fake.options.sessionId}`])
    const resumed = started({ images, resume: 'abcd1234-0000' })
    await tick()
    expect(resumed.fake.options).toMatchObject({ resume: 'abcd1234-0000', additionalDirectories: ['/sessions/abcd1234-0000'] })
    expect(resumed.fake.options.sessionId).toBeUndefined()
  })

  it("adds only the stashed plan folder it was started with, and no plans folder otherwise", async () => {
    const plan = `/state/chat-plans/${'c'.repeat(32)}`
    const withPlan = started({ images, resume: 'abcd1234-0000', readableDirectories: [plan] })
    await tick()
    expect(withPlan.fake.options.additionalDirectories).toEqual(['/sessions/abcd1234-0000', plan])
    const plain = started({ resume: 'abcd1234-0000' })
    await tick()
    expect(plain.fake.options.additionalDirectories).toBeUndefined()
  })

  it('copies a resumed conversation\'s attached images back to the folders its notes name', async () => {
    const store = { ...images, saveBase64: vi.fn(() => ({ id: imageId })), stage: vi.fn(async (id: string, sessionId: string) => `/sessions/${sessionId}/${id}`) }
    const attached = (path: string) => ({ type: 'user', message: { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
      { type: 'text', text: `look\n\n[Attached image "pane.png" is saved at: ${path}]` },
    ] }, parent_tool_use_id: null })
    const history = [
      // Saved before a /clear gave the conversation its current id.
      attached(`/sessions/beforeclear-0000/${imageId}`),
      attached(`/sessions/abcd1234-0000/${imageId}`),
      // From before session folders: the shared store stays closed.
      attached(`/images/${imageId}`),
      // A note-shaped line someone typed, with no image beside it, opens nothing.
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `[Attached image "x" is saved at: /sessions/someoneelse-0000/${imageId}]` }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'A pane.' }] }, parent_tool_use_id: null },
    ]
    const { fake } = started({ images: store, resume: 'abcd1234-0000' }, { messages: async () => history, title: async () => undefined })
    await tick()
    expect(store.stage.mock.calls).toEqual([[imageId, 'beforeclear-0000'], [imageId, 'abcd1234-0000']])
    expect(fake.options.additionalDirectories).toEqual(['/sessions/abcd1234-0000', '/sessions/beforeclear-0000'])
  })

  it('still sends an image it could not copy for Claude, without a note', async () => {
    const log = vi.fn()
    const { fake, session } = started({ images: { ...images, stage: vi.fn(async () => { throw new Error('ENOSPC') }) }, log })
    session.send('look', [{ id: imageId }])
    session.send('', [{ id: imageId }])
    await tick()
    await tick()
    expect(fake.prompts[0]!.message.content).toEqual([expect.objectContaining({ type: 'image' }), { type: 'text', text: 'look' }])
    // No empty text block, which the API refuses.
    expect(fake.prompts[1]!.message.content).toEqual([expect.objectContaining({ type: 'image' })])
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ENOSPC/))
  })

  it('opens each chat to its own attachments only, on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chat-session-images-'))
    try {
      const store = new ChatImageStore(join(root, 'images'))
      const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
      const saved = await store.save(png)
      const id = 'id' in saved ? saved.id : ''
      const mine = started({ images: store })
      const theirs = started({ images: store })
      mine.session.send('look', [{ id, name: 'mine.png' }])
      await vi.waitFor(() => expect(mine.fake.prompts).toHaveLength(1))
      const [myDir] = mine.fake.options.additionalDirectories!
      const [theirDir] = theirs.fake.options.additionalDirectories!
      expect(myDir).not.toBe(theirDir)
      for (const dir of [myDir, theirDir]) expect(dir!.startsWith(store.dir)).toBe(false)
      expect(await readdir(myDir!)).toEqual([id])
      expect(await readdir(theirDir!)).toEqual([])
      expect(JSON.stringify(mine.fake.prompts[0]!.message.content)).toContain(join(myDir!, id))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('sends an image on its own, and refuses a send whose image is gone', async () => {
    const { fake, session, items } = started({ images })
    session.send('', [{ id: imageId }])
    session.send('look', [{ id: `${'d'.repeat(64)}.png` }])
    await tick()
    await tick()
    expect(fake.prompts).toHaveLength(1)
    expect(fake.prompts[0]!.message.content).toEqual([expect.objectContaining({ type: 'image' }), { type: 'text', text: `[Attached image "${imageId}" is saved at: /sessions/${fake.options.sessionId}/${imageId}]` }])
    expect([...items.values()].some((item) => item.kind === 'notice' && /message wasn't sent: ENOENT/.test(item.text))).toBe(true)
  })

  it('shows an image error from Claude as a notice', async () => {
    const { fake, session, items } = started()
    session.send('look')
    fake.push({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'image_error', errors: ['Could not process image'], session_id: 's', uuid: 'r' } as unknown as SDKMessage)
    await tick()
    expect([...items.values()].find((item) => item.kind === 'notice')).toMatchObject({ level: 'error', text: "Claude couldn't read an attached image: Could not process image. Try a smaller PNG or JPEG." })
  })

  it('marks /clear in the timeline and drops the old title', async () => {
    const { fake, session, items, sessions } = started()
    session.send('first question')
    await tick()
    fake.push({ type: 'conversation_reset', new_conversation_id: 'n', uuid: 'n', trigger: 'clear', session_id: 's2' } as unknown as SDKMessage)
    await tick()
    expect([...items.values()].some((item) => item.kind === 'notice' && /Context cleared/.test(item.text))).toBe(true)
    expect(sessions.at(-1)?.title).toBeUndefined()
  })

  it('answers @ searches from the session folder', async () => {
    const { session } = started({ cwd: '/definitely/missing/folder' })
    expect(await session.searchFiles('x')).toEqual({ entries: [], truncated: false, error: expect.stringMatching(/^Couldn't list files: .*ENOENT/) })
  })
})

describe('AgentSession command list failures', () => {
  it('says when Claude cannot list its commands and stops the menu waiting for them', async () => {
    const fake = fakeQuery()
    fake.supportedCommands.mockRejectedValue(new Error('control request timed out'))
    const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {} }, fake.run, () => 1, { messages: async () => [], title: async () => undefined })
    const notices: string[] = []
    session.on('items', (changed) => { for (const item of changed) if (item.kind === 'notice') notices.push(item.text) })
    void session.start()
    await tick()
    await tick()
    expect(session.commands).toEqual([])
    expect(notices).toEqual(["Couldn't list Claude's commands for the / menu: control request timed out"])
  })
})

const resultMessage = (fields: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', session_id: 's', ...fields }) as unknown as SDKMessage
const userTexts = (items: Map<string, ChatItem>) => [...items.values()].flatMap((item) => (item.kind === 'user_message' ? [item.text] : []))

describe('AgentSession plans', () => {
  it('captures an ExitPlanMode plan as a card and tells Claude to wait', async () => {
    const { fake, items } = started({ permissionMode: 'plan' })
    const result = await fake.canUseTool('ExitPlanMode', { plan: '# Plan\n- one', planFilePath: '/p.md' }, { ...signalOptions('p1'), toolUseID: 'toolu_plan' })
    expect(result).toEqual({ behavior: 'deny', message: PLAN_CAPTURED_MESSAGE })
    expect(items.get('plan-toolu_plan')).toMatchObject({ kind: 'plan', text: '# Plan\n- one', toolUseId: 'toolu_plan' })
    expect([...items.values()].some((item) => item.kind === 'request')).toBe(false)
  })

  it('falls back to the approval when ExitPlanMode carries no plan, or comes from a subagent', async () => {
    const { fake, items } = started({ permissionMode: 'plan' })
    void fake.canUseTool('ExitPlanMode', { allowedPrompts: [] }, signalOptions('p2'))
    expect(items.get('request-p2')).toMatchObject({ kind: 'request', requestKind: 'approval', toolName: 'ExitPlanMode' })
    void fake.canUseTool('ExitPlanMode', { plan: 'sub plan' }, { ...signalOptions('p3'), agentID: 'a1' })
    expect(items.get('request-p3')).toMatchObject({ kind: 'request' })
  })

  it('remembers the mode the chat left for plan mode, from the picker or from Claude', async () => {
    const { fake, session, sessions } = started({ permissionMode: 'acceptEdits' })
    await session.configure({ permissionMode: 'plan' })
    expect(sessions.at(-1)).toMatchObject({ permissionMode: 'plan', prePlanPermissionMode: 'acceptEdits' })
    await session.configure({ permissionMode: 'default' })
    fake.push(system('status', { status: null, permissionMode: 'plan' }))
    await tick()
    expect(sessions.at(-1)).toMatchObject({ permissionMode: 'plan', prePlanPermissionMode: 'default' })
  })

  it('implements: switches back to the pre-plan mode before sending, and refuses to send if that fails', async () => {
    const { fake, session, items, sessions } = started({ permissionMode: 'plan' })
    session.send('PLEASE IMPLEMENT THIS PLAN:\n# Plan', [], { permissionMode: 'acceptEdits' })
    await tick()
    expect(fake.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
    expect(fake.prompts).toHaveLength(1)
    expect(sessions.at(-1)?.permissionMode).toBe('acceptEdits')
    fake.push(resultMessage())
    await tick()
    fake.setPermissionMode.mockRejectedValueOnce(new Error('nope'))
    session.send('again', [], { permissionMode: 'default' })
    await tick()
    expect(fake.prompts).toHaveLength(1)
    expect([...items.values()].at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: expect.stringContaining("message wasn't sent") })
  })
})

describe('AgentSession queue and steer', () => {
  it('holds queued sends while a turn runs and sends them together when it ends', async () => {
    const { fake, session, sessions } = started()
    session.send('first', [], { delivery: 'queue' })
    session.send('second', [], { delivery: 'queue' })
    session.send('third', [], { delivery: 'queue' })
    await tick()
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['first'])
    expect(sessions.at(-1)?.queue?.map((queued) => queued.text)).toEqual(['second', 'third'])
    fake.push(resultMessage())
    await tick()
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['first', 'second\n\nthird'])
    expect(sessions.at(-1)?.queue).toBeUndefined()
  })

  it('edits and removes queued messages, and steers one in with priority now', async () => {
    const { fake, session, sessions, items } = started()
    session.send('first')
    session.send('typo', [], { delivery: 'queue' })
    session.send('drop me', [], { delivery: 'queue' })
    session.send('steer me', [], { delivery: 'queue' })
    const [typo, drop, steer] = sessions.at(-1)!.queue!
    session.updateQueue({ action: 'edit', id: typo!.id, text: 'fixed' })
    session.updateQueue({ action: 'remove', id: drop!.id })
    session.updateQueue({ action: 'steer', id: steer!.id })
    await tick()
    expect(fake.prompts.at(-1)).toMatchObject({ message: { content: 'steer me' }, priority: 'now' })
    expect([...items.values()].at(-1)).toMatchObject({ kind: 'user_message', text: 'steer me', steered: true })
    expect(sessions.at(-1)?.queue?.map((queued) => queued.text)).toEqual(['fixed'])
    // The steer cuts the turn short: no failure, and the queue waits for the steered turn.
    fake.push(resultMessage({ terminal_reason: 'aborted_tools' }))
    await tick()
    expect(fake.prompts).toHaveLength(2)
    expect([...items.values()].some((item) => item.kind === 'notice')).toBe(false)
    fake.push(resultMessage())
    await tick()
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['first', 'steer me', 'fixed'])
  })

  it('sends a steer or queued send straight away when no turn runs', async () => {
    const { fake, session } = started()
    session.send('queued but idle', [], { delivery: 'queue' })
    fake.push(resultMessage())
    await tick()
    session.send('steer but idle', [], { delivery: 'steer' })
    await tick()
    expect(fake.prompts.map((prompt) => [prompt.message.content, prompt.priority])).toEqual([['queued but idle', undefined], ['steer but idle', undefined]])
  })

  it('reads an aborted turn as interrupted work, not a failure', async () => {
    const { fake, session, items } = started()
    session.send('write a story')
    fake.push({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 9' } }] }, parent_tool_use_id: null } as unknown as SDKMessage)
    fake.push(resultMessage({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming', errors: ['aborted'] }))
    await tick()
    expect(items.get('tool-1')).toMatchObject({ status: 'interrupted' })
    expect([...items.values()].some((item) => item.kind === 'notice')).toBe(false)
  })

  it('holds the queue during a turn Claude starts itself, and drops what Stop took back', async () => {
    const { fake, session, sessions } = started()
    fake.push({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Your subagent finished.' }] }, parent_tool_use_id: null } as unknown as SDKMessage)
    await tick()
    session.send('keep', [], { delivery: 'queue' })
    session.send('take back', [], { delivery: 'queue' })
    const back = sessions.at(-1)!.queue!.find((queued) => queued.text === 'take back')!
    await session.interrupt([back.id])
    expect(fake.interrupt).toHaveBeenCalled()
    fake.push(resultMessage({ terminal_reason: 'aborted_streaming' }))
    await tick()
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['keep'])
  })

  it('relays a message to a subagent through main Claude, labelled in the timeline', async () => {
    const { fake, session, items } = started()
    session.send('The fruit is MANGO.', [], { relayTo: { agentId: 'a711', label: 'fruit waiter' } })
    await tick()
    expect(fake.prompts[0]!.message.content).toContain('SendMessage tool')
    expect(fake.prompts[0]!.message.content).toContain('(agentId: a711)')
    expect([...items.values()][0]).toMatchObject({ kind: 'user_message', text: 'The fruit is MANGO.', relayTo: { agentId: 'a711', label: 'fruit waiter' } })
    expect(userTexts(items)).toEqual(['The fruit is MANGO.'])
  })
})

describe('AgentSession subagents', () => {
  it('forwards subagent text, and stops or backgrounds one subagent', async () => {
    const { fake, session, items } = started()
    await tick()
    expect(fake.options.forwardSubagentText).toBe(true)
    await session.controlTask('stop', 'a711', 'toolu_1')
    expect(fake.stopTask).toHaveBeenCalledWith('a711')
    await session.controlTask('background', 'a711', 'toolu_1')
    expect(fake.backgroundTasks).toHaveBeenCalledWith('toolu_1')
    fake.backgroundTasks.mockResolvedValueOnce(false)
    await session.controlTask('background', 'a711', 'toolu_1')
    fake.stopTask.mockRejectedValueOnce(new Error('no such task'))
    await session.controlTask('stop', 'a711', 'toolu_1')
    expect([...items.values()].filter((item) => item.kind === 'notice').map((item) => item.kind === 'notice' && item.text)).toEqual([
      'That subagent already runs in the background or has finished.',
      "Couldn't stop the subagent: no such task",
    ])
  })

  it('reads a subagent transcript from the saved session', async () => {
    const subagentMessages = vi.fn(async () => [
      // As saved: every message carries the Agent call that started the subagent.
      { type: 'user', parent_tool_use_id: 'toolu_agent', message: { role: 'user', content: 'Run date' } },
      { type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { id: 'm1', content: [{ type: 'text', text: 'It is Sunday.' }] } },
    ])
    const { fake, session } = started({}, { messages: async () => [], title: async () => undefined, subagentMessages })
    expect(await session.subagentTranscript('a711')).toEqual({ items: [], error: 'This chat has no saved conversation yet' })
    fake.push(resultMessage({ session_id: 'sess-9' }))
    await tick()
    const transcript = await session.subagentTranscript('a711')
    expect(subagentMessages).toHaveBeenCalledWith('sess-9', 'a711', '/work')
    expect(transcript.items.map((item) => [item.kind, item.parentToolUseId])).toEqual([['user_message', undefined], ['assistant_message', undefined]])
    subagentMessages.mockRejectedValueOnce(new Error('gone'))
    expect(await session.subagentTranscript('a711')).toEqual({ items: [], error: "Couldn't read the subagent's transcript: gone" })
    subagentMessages.mockResolvedValueOnce([])
    expect((await session.subagentTranscript('a711')).error).toMatch(/hasn't saved/)
  })
})

describe('AgentSession queue review fixes', () => {
  it("keeps queueing when Claude's idle for the flushed turn's predecessor arrives late", async () => {
    const { fake, session } = started()
    fake.push(system('session_state_changed', { state: 'running' }))
    session.send('first')
    session.send('queued', [], { delivery: 'queue' })
    fake.push(resultMessage())
    // Claude reports idle for that result after the host already sent the queue.
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    session.send('wait for the flushed turn', [], { delivery: 'queue' })
    await tick()
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['first', 'queued'])
    fake.push(resultMessage())
    await tick()
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['first', 'queued', 'wait for the flushed turn'])
  })

  it("stays running through the stale idle after a flush, so the composer keeps queueing", async () => {
    const { fake, session, sessions } = started()
    fake.push(system('session_state_changed', { state: 'running' }))
    session.send('first')
    session.send('queued', [], { delivery: 'queue' })
    await tick()
    fake.push(resultMessage())
    await tick()
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['first', 'queued'])
    const seen = sessions.length
    // The idle for the first turn's result arrives after the queue went out.
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(sessions.slice(seen).map((info) => info.status)).not.toContain('idle')
    expect(sessions.at(-1)?.status).toBe('running')
    expect(session.busy).toBe(true)
    // The flushed turn's own result and idle end it.
    fake.push(system('session_state_changed', { state: 'running' }))
    fake.push(resultMessage())
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(sessions.at(-1)?.status).toBe('idle')
    expect(session.busy).toBe(false)
  })

  it("ends a turn Claude ran without a result once it reports idle (a local command's output)", async () => {
    const { fake, session, sessions } = started()
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    session.send('/context')
    fake.push(system('session_state_changed', { state: 'running' }))
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(sessions.at(-1)?.status).toBe('idle')
    expect(session.busy).toBe(false)
  })

  it("keeps a send that beat Claude's start-up idle running", async () => {
    const { fake, session, sessions } = started()
    session.send('first')
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(sessions.at(-1)?.status).toBe('running')
    fake.push(system('session_state_changed', { state: 'running' }))
    fake.push(resultMessage())
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(sessions.at(-1)?.status).toBe('idle')
  })

  it('ignores only one stale idle, so a send that never gets a result cannot stick the chat running', async () => {
    const { fake, session, sessions } = started()
    session.send('first')
    session.send('queued', [], { delivery: 'queue' })
    fake.push(resultMessage())
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(sessions.at(-1)?.status).toBe('running')
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(sessions.at(-1)?.status).toBe('idle')
    expect(session.busy).toBe(false)
  })

  it('waits for every steer when two cut the turn short', async () => {
    const { fake, session } = started()
    session.send('long job')
    session.send('steer one', [], { delivery: 'steer' })
    session.send('steer two', [], { delivery: 'steer' })
    session.send('later', [], { delivery: 'queue' })
    fake.push(resultMessage({ terminal_reason: 'aborted_tools' }))
    fake.push(resultMessage({ terminal_reason: 'aborted_streaming' }))
    await tick()
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['long job', 'steer one', 'steer two'])
    fake.push(resultMessage())
    await tick()
    expect(fake.prompts.at(-1)?.message.content).toBe('later')
  })

  it('stays busy (so a restart waits) while messages are queued or a turn is open', async () => {
    const { fake, session } = started()
    session.send('first')
    session.send('queued', [], { delivery: 'queue' })
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(session.busy).toBe(true)
    fake.push(resultMessage())
    fake.push(resultMessage())
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(session.busy).toBe(false)
  })

  it('says when an edit or removal reaches a message that was already sent', async () => {
    const { session, items } = started()
    session.updateQueue({ action: 'edit', id: 'gone', text: 'my edit' })
    session.updateQueue({ action: 'remove', id: 'gone' })
    expect([...items.values()].flatMap((item) => (item.kind === 'notice' ? [item.text] : []))).toEqual([
      `That queued message was already sent, so your edit wasn't applied: "my edit"`,
      'That queued message was already sent.',
    ])
  })

  it('caps the queue and reports queued messages a session ended with', async () => {
    const { fake, session, items, sessions } = started()
    session.send('first')
    for (let index = 0; index < 21; index += 1) session.send(`q${index}`, [], { delivery: 'queue' })
    expect(sessions.at(-1)?.queue).toHaveLength(20)
    expect([...items.values()].at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('"q20"') })
    session.close()
    await tick()
    expect(sessions.at(-1)?.queue).toBeUndefined()
    expect([...items.values()].at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('"q0", "q1"') })
    expect(fake.prompts).toHaveLength(1)
  })

  it("keeps a background subagent's approval open past the main turn's end", async () => {
    const { fake, session, items } = started()
    session.send('go')
    fake.push({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { description: 'bg', run_in_background: true } }] }, parent_tool_use_id: null } as unknown as SDKMessage)
    fake.push(system('task_started', { task_id: 'a711', tool_use_id: 'tu-agent', description: 'bg', subagent_type: 'general-purpose', is_backgrounded: true }))
    await tick()
    const pending = fake.canUseTool('Bash', { command: 'make' }, { ...signalOptions('r9'), agentID: 'a711' })
    fake.push(resultMessage())
    await tick()
    expect(items.get('request-r9')).toMatchObject({ status: 'running', parentToolUseId: 'tu-agent' })
    expect(items.get('request-r9')).not.toHaveProperty('answer')
    session.answer('r9', { kind: 'approval', decision: 'allow' })
    expect(await pending).toMatchObject({ behavior: 'allow' })
  })
})

describe('AgentSession switch to Claude Code', () => {
  const resumed = () => {
    const ready = vi.fn()
    const run = started({ resume: 'abcd1234-0000' })
    run.session.on('switchReady', ready)
    return { ...run, ready }
  }

  it('switches at once when idle', async () => {
    const { session, sessions, ready } = resumed()
    await tick()
    await session.requestSwitch('after_turn')
    expect(ready).toHaveBeenCalledTimes(1)
    expect(sessions.at(-1)?.claudeCodeSwitch).toBe('switching')
  })

  it('waits for the turn, holds the queue instead of sending it, and hands it over', async () => {
    const { fake, session, sessions, items, ready } = resumed()
    await tick()
    session.send('first')
    session.send('later', [], { delivery: 'queue' })
    await tick()
    await session.requestSwitch('after_turn')
    expect(ready).not.toHaveBeenCalled()
    expect(sessions.at(-1)?.claudeCodeSwitch).toBe('after_turn')
    fake.push(resultMessage())
    await tick()
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['first'])
    expect(ready).toHaveBeenCalledTimes(1)
    expect(session.queued.map((queued) => queued.text)).toEqual(['later'])
    // The session ends for the switch: the queue went across, so no "not sent" notice.
    session.handOver()
    await tick()
    expect([...items.values()].some((item) => item.kind === 'notice')).toBe(false)
  })

  it('interrupts the turn for Switch now, keeping the queue', async () => {
    const { fake, session, ready } = resumed()
    await tick()
    session.send('first')
    session.send('later', [], { delivery: 'queue' })
    await session.requestSwitch('now')
    expect(fake.interrupt).toHaveBeenCalled()
    fake.push(resultMessage({ terminal_reason: 'aborted_streaming' }))
    await tick()
    expect(ready).toHaveBeenCalledTimes(1)
    expect(fake.prompts).toHaveLength(1)
    expect(session.queued.map((queued) => queued.text)).toEqual(['later'])
  })

  it('waits for a pending approval to be answered', async () => {
    const { fake, session, ready } = resumed()
    await tick()
    session.send('run it')
    const pending = fake.canUseTool('Bash', { command: 'ls' }, signalOptions('r1'))
    await session.requestSwitch('after_turn')
    fake.push(resultMessage())
    await tick()
    expect(ready).not.toHaveBeenCalled()
    session.answer('r1', { kind: 'approval', decision: 'allow' })
    await pending
    fake.push(system('session_state_changed', { state: 'idle' }))
    await tick()
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('sends the held queue when the switch is cancelled, or fails', async () => {
    const { fake, session, sessions, items, ready } = resumed()
    await tick()
    session.send('first')
    session.send('later', [], { delivery: 'queue' })
    await session.requestSwitch('after_turn')
    await session.requestSwitch('cancel')
    expect(sessions.at(-1)?.claudeCodeSwitch).toBeUndefined()
    fake.push(resultMessage())
    await tick()
    expect(fake.prompts.map((prompt) => prompt.message.content)).toEqual(['first', 'later'])
    fake.push(resultMessage())
    await tick()
    await session.requestSwitch('after_turn')
    expect(ready).toHaveBeenCalledTimes(1)
    session.endSwitch("Couldn't switch to Claude Code: no daemon.")
    expect([...items.values()].at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: "Couldn't switch to Claude Code: no daemon." })
    expect(sessions.at(-1)?.claudeCodeSwitch).toBeUndefined()
  })

  it('refuses a switch before there is a conversation, and sends while switching', async () => {
    const { session, items, ready, fake } = (() => {
      const run = started()
      const ready = vi.fn()
      run.session.on('switchReady', ready)
      return { ...run, ready }
    })()
    await tick()
    await session.requestSwitch('after_turn')
    expect(ready).not.toHaveBeenCalled()
    expect([...items.values()].at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Send a message first') })
    const other = resumed()
    await tick()
    await other.session.requestSwitch('after_turn')
    other.session.send('too late')
    await tick()
    expect(other.fake.prompts).toEqual([])
    expect([...other.items.values()].at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('switching to Claude Code') })
    expect(fake.prompts).toEqual([])
  })

  it('switches once a resumed chat has replayed, when asked while it started', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ready = vi.fn()
    const { session } = started({ resume: 'abcd1234-0000' }, { messages: async () => { await gate; return [] }, title: async () => undefined })
    session.on('switchReady', ready)
    await session.requestSwitch('after_turn')
    expect(ready).not.toHaveBeenCalled()
    release()
    await tick()
    await tick()
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('says it is back from Claude Code after the earlier turns', async () => {
    const history = [{ type: 'user', message: { role: 'user', content: 'Asked in the TUI' }, parent_tool_use_id: null }]
    const { items } = started({ resume: 'abcd1234-0000', returnedFromClaudeCode: true }, { messages: async () => history, title: async () => undefined })
    await tick()
    await tick()
    expect([...items.values()].map((item) => item.kind === 'notice' ? item.text : item.kind)).toEqual(['user_message', 'Returned from Claude Code'])
  })
})

describe('commando-agent switch command', () => {
  it('runs Claude Code with the chat settings, then the chat again on the same conversation', () => {
    const args = parseHostArgs(['claude', '--config-dir', '/x/.claudep', '--model', 'sonnet', '--effort', 'high', '--permission-mode', 'acceptEdits', '--allow-dangerously-skip-permissions', '--resume', 'abcd1234-0000'], {})
    if (typeof args === 'string') throw new Error(args)
    expect(claudeCodeSwitchCommand(args, '/bin/claude', '/c/commando-agent', 'abcd1234-0000')).toBe(
      "exec /bin/bash -c 'set -m; /bin/claude --model sonnet --effort high --permission-mode acceptEdits --allow-dangerously-skip-permissions --resume abcd1234-0000; "
      + "exec /c/commando-agent claude --config-dir /x/.claudep --model sonnet --effort high --permission-mode acceptEdits --allow-dangerously-skip-permissions --resume abcd1234-0000 --from-claude-code'",
    )
    const bypass = parseHostArgs(['claude', '--dangerously-skip-permissions'], {})
    if (typeof bypass === 'string') throw new Error(bypass)
    expect(claudeCodeSwitchCommand(bypass, '/bin/claude', '/c/commando-agent', 'abcd1234-0000')).toContain('set -m; /bin/claude --dangerously-skip-permissions --resume')
    expect(parseHostArgs(['claude', '--from-claude-code', '--resume', 'abcd1234-0000'], {})).toMatchObject({ fromClaudeCode: true })
    // A restart or resume of the returned chat doesn't claim to be back from Claude Code again.
    expect(sessionFlags({ ...args, fromClaudeCode: true })).not.toContain('--from-claude-code')
  })
})

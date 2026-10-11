import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatSessionInfo } from '../../shared/agent-chat.js'
import { chatResumeCommand, parseHostArgs, sessionFlags, terminalLine, withSessionSettings } from './main.js'
import { AgentSession, type SessionStore } from './session.js'

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
  const supportedModels = vi.fn(async () => [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'], supportsAutoMode: true },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Fast', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'bad model', displayName: 'Bad', description: '' },
  ])
  const contextUsage = vi.fn(async () => ({
    categories: [
      { name: 'System tools', tokens: 12_000, color: 'inactive', kind: 'used' },
      { name: 'Messages', tokens: 30_000, color: 'purple', kind: 'used' },
      { name: 'Free space', tokens: 900_000, color: 'promptBorder', kind: 'free' },
    ],
    totalTokens: 42_000, maxTokens: 1_000_000, autoCompactThreshold: 967_000, isAutoCompactEnabled: true,
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
    Object.assign(handle, { interrupt, setModel, applyFlagSettings, setPermissionMode, supportedModels, getContextUsage: contextUsage, close: () => { done = true; wake?.() } })
    return handle
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query
  return {
    run,
    prompts,
    interrupt,
    setModel,
    applyFlagSettings,
    setPermissionMode,
    supportedModels,
    contextUsage,
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
  it('reads the config dir from the environment and flags, and maps permissions', () => {
    expect(parseHostArgs(['claude', '--dangerously-skip-permissions'], { CLAUDE_CONFIG_DIR: '/x/.claudep' }))
      .toEqual({ provider: 'claude', permissionMode: 'bypassPermissions', bypassAllowed: true, configDir: '/x/.claudep' })
    expect(parseHostArgs(['claude', '--config-dir', '/y/.claudew', '--resume', 'abcdef12-34', '--model', 'opus'], {}))
      .toMatchObject({ configDir: '/y/.claudew', resume: 'abcdef12-34', model: 'opus', permissionMode: 'default' })
    expect(parseHostArgs(['claude', '--permission-mode', 'yolo'], {})).toMatch(/Unknown permission mode/)
    expect(parseHostArgs(['claude', '--resume', '$(rm -rf)'], {})).toMatch(/Invalid session id/)
    expect(parseHostArgs(['codex'], {})).toMatch(/^Usage/)
  })

  it('prints finished items as terminal lines and skips streaming ones', () => {
    expect(terminalLine({ id: 'a', turnId: 't', status: 'running', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text: 'partial' })).toBeNull()
    expect(terminalLine({ id: 'b', turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'command', toolUseId: 'x', command: 'npm test' })).toContain('npm test')
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
})

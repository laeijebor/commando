import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatSessionInfo } from '../../shared/agent-chat.js'
import { parseHostArgs, terminalLine } from './main.js'
import { AgentSession } from './session.js'

/** A stand-in for the SDK query: records prompts and lets the test push messages. */
function fakeQuery() {
  const prompts: SDKUserMessage[] = []
  const outbox: SDKMessage[] = []
  let wake: (() => void) | null = null
  let done = false
  let options: Options | undefined
  const interrupt = vi.fn(async () => undefined)
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
    Object.assign(handle, { interrupt, close: () => { done = true; wake?.() } })
    return handle
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query
  return {
    run,
    prompts,
    interrupt,
    get options() { return options! },
    push(message: SDKMessage) { outbox.push(message); wake?.(); wake = null },
    canUseTool: (...args: Parameters<CanUseTool>) => options!.canUseTool!(...args),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function started(spec: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}) {
  const fake = fakeQuery()
  const session = new AgentSession({ paneId: '%3', cwd: '/work', permissionMode: 'default', env: {}, configDir: '/home/me/.claudew', ...spec }, fake.run, () => 1)
  const items = new Map<string, ChatItem>()
  const sessions: ChatSessionInfo[] = []
  session.on('items', (changed) => { for (const item of changed) items.set(item.id, item) })
  session.on('session', (info) => sessions.push(info))
  session.start()
  return { fake, session, items, sessions }
}

const signalOptions = (requestId: string) => ({ signal: new AbortController().signal, toolUseID: `tool-${requestId}`, requestId })

describe('AgentSession', () => {
  it('starts the SDK with the pane cwd, chosen config dir and the TUI settings', () => {
    const { fake } = started({ resume: 'abcd1234-0000', permissionMode: 'bypassPermissions' })
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
      .toEqual({ provider: 'claude', permissionMode: 'bypassPermissions', configDir: '/x/.claudep' })
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

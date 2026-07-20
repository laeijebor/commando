import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentHookInstaller,
  CLAUDE_HOOK_EVENTS,
  OPENCODE_HOOK_EVENTS,
} from './agent-hook-installer.js'
import { AGENT_HOOK_TOKEN_PATH_ENV, AgentHookTokenStore } from './agent-hook-token.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(cleanup.splice(0).map((task) => task()))
})

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'commando-hook-home-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  return home
}

type OpenCodeEvent = {
  type: string
  properties: Record<string, unknown>
}

type GeneratedOpenCodeHooks = {
  event: (input: { event: OpenCodeEvent }) => Promise<void> | undefined
  'chat.message': (
    input: { sessionID: string },
    output: { message?: unknown; parts: unknown[] },
  ) => Promise<void> | undefined
  'tool.execute.before': (
    input: { tool: string; sessionID: string; callID?: string },
    output: { args: Record<string, unknown> },
  ) => Promise<void> | undefined
  'tool.execute.after': (
    input: { tool: string; sessionID: string; callID?: string; args: Record<string, unknown> },
    output: { title?: string; output?: string; metadata?: unknown },
  ) => Promise<void> | undefined
  'experimental.text.complete': (
    input: { sessionID: string; messageID?: string; partID?: string },
    output: { text: string },
  ) => void
}

async function loadOpenCodePlugin(path: string): Promise<GeneratedOpenCodeHooks> {
  const source = await readFile(path, 'utf8')
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as {
    CommandoAgentStatusPlugin: (
      context: { directory: string },
    ) => Promise<GeneratedOpenCodeHooks>
  }
  return module.CommandoAgentStatusPlugin({ directory: '/workspace' })
}

describe('agent hook token', () => {
  it('persists a private token in a private directory', async () => {
    const home = await temporaryHome()
    const store = new AgentHookTokenStore({ home })
    const first = await store.loadOrCreate()
    const second = await store.loadOrCreate()

    expect(first.length).toBeGreaterThanOrEqual(32)
    expect(second).toBe(first)
    expect((await stat(join(home, '.commando'))).mode & 0o777).toBe(0o700)
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
  })

  it('rejects an existing token shorter than 32 characters', async () => {
    const home = await temporaryHome()
    const path = join(home, 'secrets', 'hook-token')
    await mkdir(join(home, 'secrets'))
    await writeFile(path, 'too-short\n')

    await expect(new AgentHookTokenStore({ path }).loadOrCreate()).rejects.toThrow(
      'must contain at least 32 characters',
    )
  })

  it('uses an explicit home independently of the process token path', async () => {
    const home = await temporaryHome()
    vi.stubEnv(AGENT_HOOK_TOKEN_PATH_ENV, join(home, 'outside-test-home'))

    expect(new AgentHookTokenStore({ home }).path).toBe(
      join(home, '.commando', 'agent-hook-token'),
    )
    expect(new AgentHookInstaller({ home }).paths.tokenPath).toBe(
      join(home, '.commando', 'agent-hook-token'),
    )
  })

  it('does not change permissions on a custom token directory', async () => {
    const home = await temporaryHome()
    const directory = join(home, 'shared')
    const path = join(directory, 'hook-token')
    await mkdir(directory, { mode: 0o750 })

    await new AgentHookTokenStore({ path }).loadOrCreate()

    expect((await stat(directory)).mode & 0o777).toBe(0o750)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

describe('agent hook installer', () => {
  it('preserves unrelated Claude settings and hooks', async () => {
    const home = await temporaryHome()
    const settingsPath = join(home, '.claude', 'settings.json')
    await mkdir(join(home, '.claude'))
    await writeFile(settingsPath, `${JSON.stringify({
      theme: 'dark',
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: '/usr/local/bin/existing-hook' }],
        }],
        CustomEvent: [{ matcher: 'custom', hooks: [] }],
      },
    }, null, 2)}\n`)

    const installed = await new AgentHookInstaller({ home }).install()
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))

    expect(settings.theme).toBe('dark')
    expect(settings.hooks.CustomEvent).toEqual([{ matcher: 'custom', hooks: [] }])
    expect(settings.hooks.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: '/usr/local/bin/existing-hook' }],
    })
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(settings.hooks[event]).toContainEqual({
        matcher: '',
        hooks: [{
          type: 'command',
          command: 'node',
          args: [installed.claudeBridgePath, '--commando-agent-status-hook'],
        }],
      })
    }
  })

  it('is idempotent and preserves files it does not own', async () => {
    const home = await temporaryHome()
    const installer = new AgentHookInstaller({ home })
    const unrelatedPlugin = join(home, '.config', 'opencode', 'plugins', 'unrelated.js')
    const unrelatedHook = join(home, '.commando', 'hooks', 'unrelated.sh')
    await mkdir(join(home, '.config', 'opencode', 'plugins'), { recursive: true })
    await mkdir(join(home, '.commando', 'hooks'), { recursive: true })
    await writeFile(unrelatedPlugin, 'export const unrelated = true\n')
    await writeFile(unrelatedHook, '#!/bin/sh\n')

    const paths = await installer.install()
    const firstSettings = await readFile(paths.claudeSettingsPath, 'utf8')
    const firstBridge = await readFile(paths.claudeBridgePath, 'utf8')
    const firstPlugin = await readFile(paths.openCodePluginPath, 'utf8')
    await installer.install()

    expect(await readFile(paths.claudeSettingsPath, 'utf8')).toBe(firstSettings)
    expect(await readFile(paths.claudeBridgePath, 'utf8')).toBe(firstBridge)
    expect(await readFile(paths.openCodePluginPath, 'utf8')).toBe(firstPlugin)
    expect(await readFile(unrelatedPlugin, 'utf8')).toBe('export const unrelated = true\n')
    expect(await readFile(unrelatedHook, 'utf8')).toBe('#!/bin/sh\n')

    const settings = JSON.parse(firstSettings)
    for (const event of CLAUDE_HOOK_EVENTS) {
      const installedHooks = settings.hooks[event]
        .flatMap((entry: { hooks?: unknown[] }) => entry.hooks ?? [])
        .filter((hook: { args?: unknown[] }) => hook.args?.includes('--commando-agent-status-hook'))
      expect(installedHooks).toHaveLength(1)
    }
  })

  it('generates provider bridges without embedding the hook token', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const token = (await readFile(paths.tokenPath, 'utf8')).trim()
    const claudeBridge = await readFile(paths.claudeBridgePath, 'utf8')
    const openCodePlugin = await readFile(paths.openCodePluginPath, 'utf8')

    expect(claudeBridge).toContain('/api/agent-status/hooks/claude')
    expect(claudeBridge).toContain('X-Commando-Pane')
    expect(claudeBridge).toContain('for await (const chunk of process.stdin)')
    expect(claudeBridge).toContain('prompt_id: boundedText(input.prompt_id, 200)')
    expect(claudeBridge).toContain('backgroundTasks: Array.isArray(input.background_tasks)')
    expect(claudeBridge).not.toContain('tool_response')
    expect(claudeBridge).not.toContain('transcript_path')
    expect(openCodePlugin).toContain('/api/agent-status/hooks/opencode')
    expect(openCodePlugin).toContain("type: 'commando.turn.started'")
    expect(openCodePlugin).toContain("type: 'commando.activity.started'")
    expect(openCodePlugin).toContain("type: 'commando.activity.completed'")
    expect(openCodePlugin).toContain("'experimental.text.complete':")
    expect(openCodePlugin).not.toContain('output.output')
    for (const event of OPENCODE_HOOK_EVENTS) expect(openCodePlugin).toContain(event)
    expect(claudeBridge).not.toContain(token)
    expect(openCodePlugin).not.toContain(token)
    expect((await stat(paths.claudeBridgePath)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.openCodePluginPath)).mode & 0o777).toBe(0o600)
  })

  it('forwards only bounded sanitized Claude metadata', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const token = (await readFile(paths.tokenPath, 'utf8')).trim()
    const received: Array<{
      authorization: string | undefined
      body: Record<string, unknown>
      pane: string | undefined
    }> = []
    const server = createServer((request, response) => {
      void (async () => {
        let body = ''
        for await (const chunk of request) body += chunk
        received.push({
          authorization: request.headers.authorization,
          body: JSON.parse(body),
          pane: request.headers['x-commando-pane'] as string | undefined,
        })
        response.writeHead(200)
        response.end()
      })()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')

    try {
      const send = async (input: Record<string, unknown>) => {
        const child = spawn(process.execPath, [paths.claudeBridgePath], {
          env: { ...process.env, COMMANDO_PORT: String(address.port), TMUX_PANE: '%42' },
          stdio: ['pipe', 'ignore', 'inherit'],
        })
        child.stdin.end(JSON.stringify({ session_id: 'claude-session', ...input }))
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code) => code === 0
            ? resolve()
            : reject(new Error(`Bridge exited ${code}`)))
        })
      }

      await send({
        hook_event_name: 'UserPromptSubmit',
        prompt_id: 'prompt-1',
        source: 'startup',
        prompt: [
          'Inspect',
          'OPENAI_API_KEY=raw-prompt-secret',
          '{"api_key":"raw-json-secret"}',
          'password: raw multiword secret',
          'https://user:raw-url-secret@example.com',
          'ghp_1234567890abcdefghijkl',
        ].join('\n'),
      })
      await send({
        hook_event_name: 'UserPromptSubmit',
        prompt_id: 'synthetic-task-notification',
        prompt: '<task-notification><task-id>task-1</task-id><tool-use-id>tool-1</tool-use-id><output-file>/tmp/task.output</output-file></task-notification>',
      })
      await send({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        tool_input: {
          command: 'TOKEN=raw-command-secret npm test -- raw-command-argument',
          description: 'raw command description',
        },
      })
      await send({
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/src/private.ts', content: 'raw-file-content' },
        tool_response: { content: 'raw-tool-output', diff: 'raw-diff' },
      })
      await send({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {
          command: 'rm raw-permission-command',
          description: 'Approve this\nSECRET=raw-attention-secret',
        },
      })
      await send({
        hook_event_name: 'TaskCreated',
        task_id: 'task-1',
        task_subject: 'Implement login\nTOKEN=raw-task-secret',
        task_description: 'raw-task-description',
      })
      await send({
        hook_event_name: 'Stop',
        last_assistant_message: `Finished\nBearer raw-final-secret ${'y'.repeat(2100)}\n🟢 Shipped safely`,
        background_tasks: [{ command: 'raw-background-command' }, { prompt: 'raw-background-prompt' }],
      })

      expect(received).toHaveLength(6)
      expect(received.some(({ body }) => body.prompt_id === 'synthetic-task-notification')).toBe(false)
      for (const request of received) {
        expect(request.authorization).toBe(`Bearer ${token}`)
        expect(request.pane).toBe('%42')
      }

      const bodies = new Map(received.map(({ body }) => [body.hook_event_name, body]))
      const prompt = bodies.get('UserPromptSubmit')
      expect(prompt).toMatchObject({
        session_id: 'claude-session',
        prompt_id: 'prompt-1',
        source: 'startup',
      })
      expect(String(prompt?.intent).length).toBeLessThanOrEqual(240)
      expect(String(prompt?.intent)).toContain('Inspect OPENAI_API_KEY=[REDACTED]')
      expect(bodies.get('PreToolUse')).toMatchObject({
        activityId: 'tool-1',
        activity: { label: 'Running tests', kind: 'check', state: 'running' },
        check: { label: 'tests', status: 'running' },
      })
      expect(bodies.get('PostToolUse')).toMatchObject({
        activity: { label: 'Editing private.ts', kind: 'edit', state: 'completed' },
        filePath: '/repo/src/private.ts',
      })
      expect(bodies.get('PermissionRequest')).toMatchObject({
        attention: 'Approve this SECRET=[REDACTED]',
      })
      expect(bodies.get('TaskCreated')).toMatchObject({
        task: {
          id: 'task-1',
          subject: 'Implement login TOKEN=[REDACTED]',
          state: 'created',
        },
      })
      expect(String(bodies.get('Stop')?.finalMessage).length).toBeLessThanOrEqual(2000)
      expect(String(bodies.get('Stop')?.finalMessage)).toMatch(/\n🟢 Shipped safely$/)
      expect(bodies.get('Stop')).toMatchObject({ backgroundTasks: 2 })

      const serialized = JSON.stringify(received)
      for (const rawValue of [
        'raw-prompt-secret',
        'raw-json-secret',
        'raw multiword secret',
        'raw-url-secret',
        'ghp_1234567890abcdefghijkl',
        'raw-command-secret',
        'raw-command-argument',
        'raw-file-content',
        'raw-tool-output',
        'raw-diff',
        'raw-attention-secret',
        'raw-task-secret',
        'raw-task-description',
        'raw-final-secret',
        'raw-background-command',
        'raw-background-prompt',
      ]) expect(serialized).not.toContain(rawValue)
      expect(serialized).not.toContain('tool_input')
      expect(serialized).not.toContain('tool_response')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('serializes sanitized OpenCode metadata and filters child sessions', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const requests: Array<{ directory: string; event: OpenCodeEvent }> = []
    vi.stubEnv('TMUX_PANE', '%42')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { directory: string; event: OpenCodeEvent }
      if (requests.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      requests.push(request)
      return new Response(null, { status: 200 })
    }))
    const plugin = await loadOpenCodePlugin(paths.openCodePluginPath)
    const send = (type: string, sessionID: string, properties: Record<string, unknown> = {}) =>
      plugin.event({ event: { type, properties: { sessionID, ...properties } } })

    plugin.event({
      event: {
        type: 'session.created',
        properties: { sessionID: 'child', info: { id: 'child', parentID: 'main' } },
      },
    })
    const deliveries = [
      send('session.status', 'main', { status: { type: 'busy' } }),
      plugin['chat.message'](
        { sessionID: 'main' },
        {
          message: { parts: ['raw-message-array'] },
          parts: [{ type: 'text', text: 'Fix login\nAPI_TOKEN=raw-intent-secret' }],
        },
      ),
      plugin['tool.execute.before'](
        { tool: 'bash', sessionID: 'main', callID: 'call-typecheck' },
        { args: { command: 'npm run typecheck -- raw-command-argument' } },
      ),
      plugin['tool.execute.after'](
        {
          tool: 'bash',
          sessionID: 'main',
          callID: 'call-typecheck',
          args: { command: 'npm run typecheck -- raw-command-argument' },
        },
        { output: 'raw-tool-output', metadata: { exit: 0 } },
      ),
      plugin['tool.execute.before'](
        { tool: 'edit', sessionID: 'main' },
        { args: { filePath: '/repo/src/app.ts', content: 'raw-file-content' } },
      ),
      plugin['tool.execute.after'](
        {
          tool: 'edit',
          sessionID: 'main',
          args: { filePath: '/repo/src/app.ts', content: 'raw-file-content' },
        },
        { output: 'raw-edit-output' },
      ),
      send('permission.asked', 'main', {
        id: 'permission-1',
        permission: 'shell\nTOKEN=raw-permission-secret',
        patterns: ['raw-permission-pattern'],
      }),
      send('question.asked', 'main', {
        id: 'question-1',
        questions: [{
          question: 'Choose target\nSECRET=raw-question-secret',
          options: [{ label: 'Deploy\nTOKEN=raw-question-option-secret' }],
        }],
      }),
      send('session.status', 'main', {
        status: {
          type: 'retry',
          attempt: 2,
          next: 10,
          message: 'Retrying\nBearer raw-retry-secret',
          action: { message: 'raw-retry-action' },
        },
      }),
      send('session.error', 'main', {
        error: {
          name: 'APIError',
          data: { message: 'Failed\nAPI_KEY=raw-error-secret', responseBody: 'raw-error-body' },
        },
      }),
      send('todo.updated', 'main', {
        todos: Array.from({ length: 21 }, (_, index) => ({
          content: index === 0
            ? 'Implement auth\nTOKEN=raw-todo-secret'
            : `Todo ${index}`,
          status: index === 0 ? 'in_progress' : 'pending',
          priority: 'high',
          output: 'raw-todo-output',
        })),
      }),
      send('session.diff', 'main', {
        diff: Array.from({ length: 21 }, (_, index) => ({
          file: `src/file-${index}.ts`,
          additions: index + 1,
          deletions: index,
          patch: 'raw-diff-patch',
        })),
      }),
      plugin.event({
        event: {
          type: 'file.edited',
          properties: { file: '/repo/src/app.ts', content: 'raw-edited-content' },
        },
      }),
      send('session.status', 'child', { status: { type: 'busy' } }),
      plugin['chat.message'](
        { sessionID: 'child' },
        { parts: [{ type: 'text', text: 'raw-child-prompt' }] },
      ),
      plugin['tool.execute.before'](
        { tool: 'bash', sessionID: 'child' },
        { args: { command: 'npm test raw-child-command' } },
      ),
    ].filter((delivery): delivery is Promise<void> => delivery !== undefined)

    plugin['experimental.text.complete'](
      { sessionID: 'main' },
      { text: 'Completed work\nBearer raw-final-secret\n🟢 Shipped safely' },
    )
    const finalDeliveries = [
      send('session.idle', 'main'),
      send('session.status', 'next', { status: { type: 'busy' } }),
    ].filter((delivery): delivery is Promise<void> => delivery !== undefined)
    deliveries.push(...finalDeliveries)
    await Promise.all(deliveries)

    expect(requests.map(({ event }) => event.type)).toEqual([
      'session.status',
      'commando.turn.started',
      'commando.activity.started',
      'commando.activity.completed',
      'commando.activity.started',
      'commando.activity.completed',
      'permission.asked',
      'question.asked',
      'session.status',
      'session.error',
      'todo.updated',
      'session.diff',
      'file.edited',
      'session.idle',
      'session.status',
    ])
    expect(requests.every(({ directory }) => directory === '/workspace')).toBe(true)
    const events = requests.map(({ event }) => event)
    expect(events[1]?.properties).toMatchObject({
      sessionID: 'main',
      intent: 'Fix login API_TOKEN=[REDACTED]',
    })
    expect(events[2]?.properties).toMatchObject({
      activityId: 'call-typecheck',
      activity: { label: 'Running typecheck', kind: 'check', state: 'running' },
      check: { label: 'typecheck', status: 'running' },
    })
    expect(events[3]?.properties).toMatchObject({
      activityId: 'call-typecheck',
      activity: { label: 'Running typecheck', kind: 'check', state: 'completed' },
      check: { label: 'typecheck', status: 'passed' },
    })
    expect(events[4]?.properties).toMatchObject({
      activity: { label: 'Editing app.ts', kind: 'edit', state: 'running' },
      filePath: '/repo/src/app.ts',
    })
    expect(events[6]?.properties).toMatchObject({
      attention: 'shell TOKEN=[REDACTED]',
    })
    expect(events[7]?.properties).toMatchObject({
      attention: 'Choose target SECRET=[REDACTED]',
    })
    expect(events[8]?.properties.status).toEqual({
      type: 'retry',
      attempt: 2,
      next: 10,
      message: 'Retrying Bearer [REDACTED]',
    })
    expect(events[9]?.properties.error).toBe('Failed API_KEY=[REDACTED]')
    expect(events[10]?.properties.todos).toHaveLength(20)
    expect(events[10]?.properties.todos).toContainEqual({
      content: 'Implement auth TOKEN=[REDACTED]',
      status: 'in_progress',
      priority: 'high',
    })
    expect(events[11]?.properties.diff).toHaveLength(20)
    expect(events[11]?.properties.diff).toContainEqual({
      file: 'src/file-0.ts',
      additions: 1,
      deletions: 0,
    })
    expect(events[12]?.properties).toMatchObject({
      sessionID: 'main',
      filePath: '/repo/src/app.ts',
    })
    expect(events[13]?.properties).toMatchObject({
      sessionID: 'main',
      finalMessage: 'Completed work\nBearer [REDACTED]\n🟢 Shipped safely',
    })
    expect(events[13]?.properties.todos).toEqual(events[10]?.properties.todos)
    expect(events[13]?.properties.diff).toEqual(events[11]?.properties.diff)
    expect(events[14]?.properties.sessionID).toBe('next')

    const serialized = JSON.stringify(requests)
    for (const rawValue of [
      'raw-message-array',
      'raw-intent-secret',
      'raw-command-argument',
      'raw-tool-output',
      'raw-file-content',
      'raw-edit-output',
      'raw-permission-secret',
      'raw-permission-pattern',
      'raw-question-secret',
      'raw-question-option-secret',
      'raw-retry-secret',
      'raw-retry-action',
      'raw-error-secret',
      'raw-error-body',
      'raw-todo-secret',
      'raw-todo-output',
      'raw-diff-patch',
      'raw-edited-content',
      'raw-child-prompt',
      'raw-child-command',
      'raw-final-secret',
    ]) expect(serialized).not.toContain(rawValue)
    expect(serialized).not.toContain('"args"')
    expect(serialized).not.toContain('"output"')
    expect(serialized).not.toContain('"parts"')
  })

  it('clears OpenCode turn caches, redacts common credentials, and reports failed checks', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const requests: OpenCodeEvent[] = []
    vi.stubEnv('TMUX_PANE', '%42')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { event: OpenCodeEvent }
      requests.push(request.event)
      return new Response(null, { status: 200 })
    }))
    const plugin = await loadOpenCodePlugin(paths.openCodePluginPath)
    const send = (type: string, properties: Record<string, unknown> = {}) =>
      plugin.event({ event: { type, properties: { sessionID: 'main', ...properties } } })

    const firstTurn = [
      plugin['chat.message'](
        { sessionID: 'main' },
        {
          parts: [{
            type: 'text',
            text: [
              '{"api_key":"raw-json-secret"}',
              'password: raw multiword secret',
              'https://user:raw-url-secret@example.com',
              'ghp_1234567890abcdefghijkl',
              'AWS_SECRET_ACCESS_KEY=raw-aws-secret-key',
              'ASIA1234567890ABCDEF',
              'eyJheader123.payload123.signature123',
              '-----BEGIN PRIVATE KEY-----\nraw-private-key\n-----END PRIVATE KEY-----',
            ].join('\n'),
          }],
        },
      ),
      plugin['tool.execute.before'](
        { tool: 'bash', sessionID: 'main', callID: 'failed-check' },
        { args: { command: 'npm test' } },
      ),
      plugin['tool.execute.after'](
        { tool: 'bash', sessionID: 'main', callID: 'failed-check', args: { command: 'npm test' } },
        { metadata: { exit: null } },
      ),
      send('todo.updated', {
        todos: [{ content: 'First turn todo', status: 'completed', priority: 'high' }],
      }),
      send('session.diff', {
        diff: [{ file: 'src/private.ts', additions: 1, deletions: 0 }],
      }),
    ].filter((delivery): delivery is Promise<void> => delivery !== undefined)
    plugin['experimental.text.complete'](
      { sessionID: 'main' },
      { text: 'First turn result' },
    )
    firstTurn.push(send('session.idle') as Promise<void>)
    await Promise.all(firstTurn)

    await plugin['chat.message'](
      { sessionID: 'main' },
      { parts: [{ type: 'text', text: 'Second turn' }] },
    )
    await send('session.idle')

    const failedCheck = requests.find((event) => (
      event.type === 'commando.activity.completed' && event.properties.activityId === 'failed-check'
    ))
    expect(failedCheck?.properties).toMatchObject({
      activity: { state: 'failed' },
      check: { label: 'tests', status: 'failed' },
    })
    const idleEvents = requests.filter((event) => event.type === 'session.idle')
    expect(idleEvents[0]?.properties).toMatchObject({
      finalMessage: 'First turn result',
      todos: [{ content: 'First turn todo' }],
      diff: [{ file: 'src/private.ts' }],
    })
    expect(idleEvents[1]?.properties).not.toHaveProperty('finalMessage')
    expect(idleEvents[1]?.properties).not.toHaveProperty('todos')
    expect(idleEvents[1]?.properties).not.toHaveProperty('diff')

    const serialized = JSON.stringify(requests)
    for (const secret of [
      'raw-json-secret',
      'raw multiword secret',
      'raw-url-secret',
      'ghp_1234567890abcdefghijkl',
      'raw-aws-secret-key',
      'ASIA1234567890ABCDEF',
      'eyJheader123.payload123.signature123',
      'raw-private-key',
    ]) expect(serialized).not.toContain(secret)
  })
})

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentHookInstaller,
  CLAUDE_HOOK_EVENTS,
  OPENCODE_HOOK_EVENTS,
  repairAgentStatusHooks,
} from './agent-hook-installer.js'
import { AGENT_HOOK_TOKEN_PATH_ENV, AgentHookTokenStore } from './agent-hook-token.js'
import { SANDBOXED_AGENT_PROFILE_ENV } from './test-env-sandbox.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(cleanup.splice(0).map((task) => task()))
})

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'commando-hook-home-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  // Installer paths must stay inside this home even when the caller constructs an installer
  // without options: an inherited profile variable would otherwise point a real settings file
  // at the bridge below, which cleanup deletes.
  vi.stubEnv('HOME', home)
  for (const name of SANDBOXED_AGENT_PROFILE_ENV) vi.stubEnv(name, undefined)
  return home
}

type OpenCodeEvent = {
  type: string
  properties: Record<string, unknown>
}

type GeneratedOpenCodeHooks = {
  'experimental.chat.system.transform': (input: { sessionID?: string }, output: { system: string[] }) => Promise<void>
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

async function loadOpenCodePlugin(
  path: string,
  client?: Record<string, unknown>,
): Promise<GeneratedOpenCodeHooks> {
  const source = await readFile(path, 'utf8')
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as {
    CommandoAgentStatusPlugin: (
      context: { directory: string; client?: Record<string, unknown> },
    ) => Promise<GeneratedOpenCodeHooks>
  }
  return module.CommandoAgentStatusPlugin({ directory: '/workspace', client })
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
  it('injects PR ownership and worklog guidance in OpenCode only inside tmux', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const hooks = await loadOpenCodePlugin(paths.openCodePluginPath)
    const output = { system: ['Existing instructions'] }
    vi.stubEnv('TMUX_PANE', '')
    await hooks['experimental.chat.system.transform']({}, output)
    expect(output.system).toEqual(['Existing instructions'])
    vi.stubEnv('TMUX_PANE', '%42')
    await hooks['experimental.chat.system.transform']({}, output)
    await hooks['experimental.chat.system.transform']({}, output)
    expect(output.system).toHaveLength(2)
    expect(output.system[1]).toContain(paths.prMarkerCliPath)
    expect(output.system[1]).toContain('Append its exact HTML comment')
    expect(output.system[1]).toContain(paths.sessionBriefCliPath)
    expect(output.system[1]).toContain('unless requested by the user')
  })

  it('emits Claude context through the installed startup/prompt command without changing permission output', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const settings = JSON.parse(await readFile(paths.claudeSettingsPath, 'utf8'))
    const server = createServer((_request, response) => { response.writeHead(200); response.end('{}') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
      const command = settings.hooks[event][0].hooks[0]
      const child = spawn(command.command, command.args, {
        env: { ...process.env, COMMANDO_PORT: String(address.port), TMUX_PANE: '%42' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'test', prompt: 'Create the requested PR' }))
      const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) })
      expect(code).toBe(0)
      if (event === 'PostToolUse') expect(stdout).toBe('')
      else expect(JSON.parse(stdout)).toMatchObject({ hookSpecificOutput: {
        hookEventName: event, additionalContext: expect.stringContaining(paths.prMarkerCliPath),
      } })
    }
  })

  it('keeps installer writes inside the test home when profile variables are inherited', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'commando-hook-outside-'))
    cleanup.push(() => rm(outside, { recursive: true, force: true }))
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(outside, 'claude'))
    vi.stubEnv(AGENT_HOOK_TOKEN_PATH_ENV, join(outside, 'token'))

    const home = await temporaryHome()
    const installed = await new AgentHookInstaller().install()

    expect(installed.claudeSettingsPath).toBe(join(home, '.claude', 'settings.json'))
    expect(installed.claudeBridgePath).toBe(
      join(home, '.commando', 'hooks', 'commando-claude-agent-status.mjs'),
    )
    expect(installed.tokenPath).toBe(join(home, '.commando', 'agent-hook-token'))
    await expect(readdir(outside)).resolves.toEqual([])
  })

  it('honors CLAUDE_CONFIG_DIR for explicit Claude profiles', async () => {
    const home = await temporaryHome()
    const profile = join(home, '.claudep')
    vi.stubEnv('HOME', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile)

    const installed = await new AgentHookInstaller().install()

    expect(installed.claudeSettingsPath).toBe(join(profile, 'settings.json'))
    const settings = JSON.parse(await readFile(installed.claudeSettingsPath, 'utf8'))
    expect(settings.hooks.SessionStart).toBeDefined()
  })

  it('rejects an explicitly empty CLAUDE_CONFIG_DIR', () => {
    vi.stubEnv('HOME', '/tmp/commando-home')
    vi.stubEnv('CLAUDE_CONFIG_DIR', '   ')

    expect(() => new AgentHookInstaller()).toThrow('CLAUDE_CONFIG_DIR must not be empty')
  })

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
    const sessionBriefCli = await readFile(paths.sessionBriefCliPath, 'utf8')
    const prMarkerCli = await readFile(paths.prMarkerCliPath, 'utf8')

    expect(claudeBridge).toContain('/api/agent-status/hooks/claude')
    expect(claudeBridge).toContain('X-Commando-Pane')
    expect(claudeBridge).toContain('for await (const chunk of process.stdin)')
    expect(claudeBridge).toContain('prompt_id: boundedText(input.prompt_id, 200)')
    expect(claudeBridge).toContain('backgroundTasks: Array.isArray(input.background_tasks)')
    expect(claudeBridge).not.toContain('transcript_path')
    expect(openCodePlugin).toContain('/api/agent-status/hooks/opencode')
    expect(openCodePlugin).toContain("type: 'commando.turn.started'")
    expect(openCodePlugin).toContain("type: 'commando.activity.started'")
    expect(openCodePlugin).toContain("type: 'commando.activity.completed'")
    expect(openCodePlugin).toContain("'experimental.text.complete':")
    expect(openCodePlugin).not.toContain('output.output')
    expect(sessionBriefCli).toContain('/api/session-brief')
    expect(sessionBriefCli).toContain('X-Commando-Pane')
    expect(sessionBriefCli).toContain("flag === '--screenshots'")
    expect(sessionBriefCli).toContain('resolve(valueAfter(index++, flag))')
    expect(prMarkerCli).toContain('/api/pane-target-marker')
    expect(prMarkerCli).toContain('X-Commando-Pane')
    for (const event of OPENCODE_HOOK_EVENTS) expect(openCodePlugin).toContain(event)
    expect(claudeBridge).not.toContain(token)
    expect(openCodePlugin).not.toContain(token)
    expect(sessionBriefCli).not.toContain(token)
    expect(prMarkerCli).not.toContain(token)
    expect((await stat(paths.claudeBridgePath)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.openCodePluginPath)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.sessionBriefCliPath)).mode & 0o777).toBe(0o700)
    expect((await stat(paths.prMarkerCliPath)).mode & 0o777).toBe(0o700)
    const cliExit = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [paths.sessionBriefCliPath], {
        env: { ...process.env, TMUX_PANE: '%1' },
        stdio: 'ignore',
      })
      child.on('exit', resolve)
    })
    expect(cliExit).toBe(2)
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
        hook_event_name: 'PostToolUse',
        tool_name: 'TodoWrite',
        tool_input: {
          todos: [
            { content: 'Map current behavior', status: 'completed' },
            { content: 'Build plan support', status: 'in_progress' },
          ],
        },
        tool_response: { content: 'raw-todo-output' },
      })
      await send({
        hook_event_name: 'PostToolUse',
        tool_name: 'TaskUpdate',
        tool_input: { taskId: 'task-1', status: 'in_progress' },
        tool_response: { success: true, taskId: 'task-1' },
      })
      await send({
        hook_event_name: 'Stop',
        last_assistant_message: `Finished\nBearer raw-final-secret ${'y'.repeat(2100)}\n🟢 Shipped safely`,
        background_tasks: [{ command: 'raw-background-command' }, { prompt: 'raw-background-prompt' }],
      })

      expect(received).toHaveLength(8)
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
      const write = received.find(({ body }) => body.tool_name === 'Write')?.body
      expect(write).toMatchObject({
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
      const todoWrite = received.find(({ body }) => body.tool_name === 'TodoWrite')?.body
      expect(todoWrite).toMatchObject({
        taskSnapshot: [
          { content: 'Map current behavior', status: 'completed', priority: 'medium' },
          { content: 'Build plan support', status: 'in_progress', priority: 'medium' },
        ],
      })
      const taskUpdate = received.find(({ body }) => body.tool_name === 'TaskUpdate')?.body
      expect(taskUpdate).toMatchObject({
        taskPatch: { id: 'task-1', status: 'in_progress' },
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
        'raw-todo-output',
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

  it('returns Claude question answers through PermissionRequest hook output', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const received: Record<string, unknown>[] = []
    const server = createServer((request, response) => {
      void (async () => {
        let body = ''
        for await (const chunk of request) body += chunk
        received.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          answer: { action: 'answer', answers: [['Production']] },
        }))
      })()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')

    try {
      const child = spawn(process.execPath, [paths.claudeBridgePath], {
        env: { ...process.env, COMMANDO_PORT: String(address.port), TMUX_PANE: '%42' },
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      let output = ''
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: 'claude-session',
        session_title: 'Release review',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [{
            header: 'Target',
            question: 'Which target?',
            options: [
              { label: 'Production', description: 'Ship now' },
              { label: 'Staging', description: 'Review first' },
            ],
            multiSelect: false,
          }],
        },
      }))
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => code === 0
          ? resolve()
          : reject(new Error(`Bridge exited ${code}`)))
      })

      expect(received[0]).toMatchObject({
        session_title: 'Release review',
        request: {
          kind: 'question',
          prompt: 'Which target?',
          questions: [{
            question: 'Which target?',
            options: [{ label: 'Production' }, { label: 'Staging' }],
          }],
        },
      })
      expect(JSON.parse(output)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: {
              questions: [{
                header: 'Target',
                question: 'Which target?',
                options: [
                  { label: 'Production', description: 'Ship now' },
                  { label: 'Staging', description: 'Review first' },
                ],
                multiSelect: false,
              }],
              answers: { 'Which target?': 'Production' },
            },
          },
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('answers OpenCode permission and question events through its SDK client', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const permissionReply = vi.fn(async () => ({ data: true }))
    const questionReply = vi.fn(async () => ({ data: true }))
    vi.stubEnv('TMUX_PANE', '%42')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { event: OpenCodeEvent }
      const answer = body.event.type === 'permission.asked'
        ? { action: 'allow_once' }
        : { action: 'answer', answers: [['Production']] }
      return new Response(JSON.stringify({ answer }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))
    const plugin = await loadOpenCodePlugin(paths.openCodePluginPath, {
      permission: { reply: permissionReply },
      question: { reply: questionReply },
    })

    plugin.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'main', title: 'Release review' } },
      },
    })
    await plugin.event({
      event: {
        type: 'permission.asked',
        properties: { sessionID: 'main', id: 'permission-1', permission: 'bash' },
      },
    })
    await plugin.event({
      event: {
        type: 'question.asked',
        properties: {
          sessionID: 'main',
          id: 'question-1',
          questions: [{
            header: 'Target',
            question: 'Which target?',
            options: [{ label: 'Production', description: 'Ship now' }],
          }],
        },
      },
    })

    expect(permissionReply).toHaveBeenCalledWith({
      requestID: 'permission-1',
      directory: '/workspace',
      reply: 'once',
    })
    expect(questionReply).toHaveBeenCalledWith({
      requestID: 'question-1',
      directory: '/workspace',
      answers: [['Production']],
    })
  })

  it('delivers OpenCode question replies while the original ask is still waiting', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const requests: OpenCodeEvent[] = []
    let releaseAsk: (() => void) | undefined
    let markAskStarted: (() => void) | undefined
    const askStarted = new Promise<void>((resolve) => {
      markAskStarted = resolve
    })
    const askReleased = new Promise<void>((resolve) => {
      releaseAsk = resolve
    })
    vi.stubEnv('TMUX_PANE', '%42')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { event: OpenCodeEvent }
      requests.push(body.event)
      if (body.event.type === 'question.asked') {
        markAskStarted?.()
        await askReleased
      }
      return new Response(null, { status: 200 })
    }))
    const plugin = await loadOpenCodePlugin(paths.openCodePluginPath)
    plugin.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'main', title: 'Release review' } },
      },
    })

    const asking = plugin.event({
      event: {
        type: 'question.asked',
        properties: {
          sessionID: 'main',
          id: 'question-1',
          questions: [{ question: 'Which target?', options: [] }],
        },
      },
    })
    await askStarted
    await plugin.event({
      event: {
        type: 'question.replied',
        properties: { sessionID: 'main', requestID: 'question-1' },
      },
    })

    expect(requests.map((event) => event.type)).toEqual(['question.asked', 'question.replied'])
    releaseAsk?.()
    await asking
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
          id: `todo-${index}`,
          content: index === 0
            ? 'Implement auth\nTOKEN=raw-todo-secret'
            : `Todo ${index}`,
          status: index === 0 ? 'in_progress' : 'pending',
          priority: 'high',
          createdAt: 100 + index,
          updatedAt: 200 + index,
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
      id: 'todo-0',
      content: 'Implement auth TOKEN=[REDACTED]',
      status: 'in_progress',
      priority: 'high',
      createdAt: 100,
      updatedAt: 200,
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

describe('agent hook repair', () => {
  it('rewrites hooks left pointing at a bridge that no longer exists', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const departed = join(home, 'departed', 'commando-claude-agent-status.mjs')
    const settings = JSON.parse(await readFile(paths.claudeSettingsPath, 'utf8'))
    for (const event of CLAUDE_HOOK_EVENTS) {
      settings.hooks[event].at(-1).hooks[0].args[0] = departed
    }
    await writeFile(paths.claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`)

    const repair = await repairAgentStatusHooks({ home })

    expect(repair).toEqual({ repaired: true, staleBridgePaths: [departed] })
    const repaired = JSON.parse(await readFile(paths.claudeSettingsPath, 'utf8'))
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(repaired.hooks[event].at(-1).hooks[0].args).toEqual([
        paths.claudeBridgePath,
        '--commando-agent-status-hook',
      ])
    }
  })

  it('restores a bridge deleted from underneath healthy settings', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    await rm(paths.claudeBridgePath)

    const repair = await repairAgentStatusHooks({ home })

    expect(repair).toEqual({ repaired: true, staleBridgePaths: [paths.claudeBridgePath] })
    expect((await stat(paths.claudeBridgePath)).mode & 0o777).toBe(0o600)
  })

  it('leaves installed hooks and profiles without Commando hooks untouched', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()

    expect(await repairAgentStatusHooks({ home })).toEqual({
      repaired: false,
      staleBridgePaths: [],
    })

    const foreign = await temporaryHome()
    const foreignSettingsPath = join(foreign, '.claude', 'settings.json')
    const foreignSettings = `${JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-hook' }] }] },
    }, null, 2)}\n`
    await mkdir(join(foreign, '.claude'), { recursive: true })
    await writeFile(foreignSettingsPath, foreignSettings)

    expect(await repairAgentStatusHooks({ home: foreign })).toEqual({
      repaired: false,
      staleBridgePaths: [],
    })
    expect(await readFile(foreignSettingsPath, 'utf8')).toBe(foreignSettings)
    await expect(stat(join(foreign, '.commando', 'hooks'))).rejects.toThrow()
    expect(paths.claudeBridgePath).not.toBe(join(foreign, '.commando', 'hooks'))
  })

  it('never repairs a profile outside the running home', async () => {
    const elsewhere = await temporaryHome()
    const elsewherePaths = await new AgentHookInstaller({ home: elsewhere }).install()
    const before = await readFile(elsewherePaths.claudeSettingsPath, 'utf8')
    await rm(elsewherePaths.claudeBridgePath)

    const home = await temporaryHome()
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(elsewhere, '.claude'))

    expect(await repairAgentStatusHooks()).toEqual({ repaired: false, staleBridgePaths: [] })
    expect(await readFile(elsewherePaths.claudeSettingsPath, 'utf8')).toBe(before)
    await expect(stat(join(home, '.commando', 'hooks'))).rejects.toThrow()
  })

  it('repairs the profile named by CLAUDE_CONFIG_DIR', async () => {
    const home = await temporaryHome()
    const profile = join(home, '.claudew')
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
    const paths = await new AgentHookInstaller().install()
    const settings = JSON.parse(await readFile(paths.claudeSettingsPath, 'utf8'))
    settings.hooks.Stop.at(-1).hooks[0].args[0] = join(home, 'gone.mjs')
    await writeFile(paths.claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`)

    const repair = await repairAgentStatusHooks()

    expect(paths.claudeSettingsPath).toBe(join(profile, 'settings.json'))
    expect(repair).toEqual({ repaired: true, staleBridgePaths: [join(home, 'gone.mjs')] })
    const repaired = JSON.parse(await readFile(paths.claudeSettingsPath, 'utf8'))
    expect(repaired.hooks.Stop.at(-1).hooks[0].args[0]).toBe(paths.claudeBridgePath)
  })
})

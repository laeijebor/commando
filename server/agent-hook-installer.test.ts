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
  mergeCodexNotify,
  generatedSimCli,
  repairAgentStatusHooks,
} from './agent-hook-installer.js'
import { formatSimLabel } from './sim-leases.js'
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

describe('Codex notify merge', () => {
  const bridgePath = '/home/agent/.commando/hooks/commando-codex-notify.mjs'
  const managed = `notify = ["node", "${bridgePath}"]`

  it('adds a managed block to the top-level region without reordering anything', () => {
    const merged = mergeCodexNotify(
      'model = "gpt-5"\napproval_policy = "on-request"\n\n[tui]\nnotifications = true\n',
      bridgePath,
    )

    expect(merged.changed).toBe(true)
    expect(merged.forwardTo).toBeNull()
    expect(merged.warning).toBeNull()
    expect(merged.content).toBe([
      'model = "gpt-5"',
      'approval_policy = "on-request"',
      '',
      '# commando:codex-notify v1',
      managed,
      '',
      '[tui]',
      'notifications = true',
      '',
    ].join('\n'))
  })

  it('creates the file, stays idempotent, and never touches tables', () => {
    const first = mergeCodexNotify('', bridgePath)
    const second = mergeCodexNotify(first.content, bridgePath)

    expect(first.content).toBe(`# commando:codex-notify v1\n${managed}\n`)
    expect(second.changed).toBe(false)
    expect(second.content).toBe(first.content)

    const scoped = mergeCodexNotify('[profiles.work]\nnotify = ["their-notifier"]\n', bridgePath)
    expect(scoped.forwardTo).toBeNull()
    expect(scoped.content).toBe(
      `# commando:codex-notify v1\n${managed}\n\n[profiles.work]\nnotify = ["their-notifier"]\n`,
    )
  })

  it('wraps a pre-existing notifier and remembers it across reruns', () => {
    const first = mergeCodexNotify(
      'model = "x"\nnotify = [\n  "notify-send",\n  "Codex",  # label\n]\nsandbox_mode = "workspace-write"\n',
      bridgePath,
    )

    expect(first.forwardTo).toEqual(['notify-send', 'Codex'])
    expect(first.content).toBe([
      'model = "x"',
      '# commando:codex-notify v1 wrapped=["notify-send","Codex"]',
      managed,
      'sandbox_mode = "workspace-write"',
      '',
    ].join('\n'))

    const rerun = mergeCodexNotify(first.content, bridgePath)
    expect(rerun.changed).toBe(false)
    expect(rerun.forwardTo).toEqual(['notify-send', 'Codex'])

    // A hand-edited notify is the newer intent, so it is wrapped in turn.
    const edited = mergeCodexNotify(
      first.content.replace(managed, 'notify = ["their-notifier"]'),
      bridgePath,
    )
    expect(edited.forwardTo).toEqual(['their-notifier'])
    expect(edited.content).toBe([
      'model = "x"',
      '# commando:codex-notify v1 wrapped=["their-notifier"]',
      managed,
      'sandbox_mode = "workspace-write"',
      '',
    ].join('\n'))
  })

  it('leaves a notify it cannot parse alone and reports it', () => {
    const merged = mergeCodexNotify('notify = [42, "Codex"]\nmodel = "x"\n', bridgePath)

    expect(merged.changed).toBe(false)
    expect(merged.content).toBe('notify = [42, "Codex"]\nmodel = "x"\n')
    expect(merged.warning).toContain('cannot safely rewrite')
  })

  it('does not mistake bracketed text inside a multi-line string for a table', () => {
    const merged = mergeCodexNotify(
      'instructions = """\n[not a table]\nnotify = ["not a key"]\n"""\nmodel = "x"\n',
      bridgePath,
    )

    expect(merged.content).toBe([
      'instructions = """',
      '[not a table]',
      'notify = ["not a key"]',
      '"""',
      'model = "x"',
      '',
      '# commando:codex-notify v1',
      managed,
      '',
    ].join('\n'))
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
    expect(output.system[1]).toContain(paths.simCliPath)
    expect(output.system[1]).toContain('slim and labelled with the session and task')
    expect(output.system[1]).toMatch(/Release them with node "[^"]+commando-sim\.mjs" release when done\./)
    expect(output.system[1]).toContain('unless requested by the user')
  })

  it('hands opencode its exact resume command once the session id is known', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    vi.stubEnv('TMUX_PANE', '%42')
    const hooks = await loadOpenCodePlugin(paths.openCodePluginPath)
    const output = { system: ['base'] }
    await hooks['experimental.chat.system.transform']({}, output)
    expect(output.system[1]).not.toContain('Resume command')
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses_f08700672ffenN8gLm9kPx2xb6' }, output)
    expect(output.system.at(-1)).toContain('Resume command for this conversation: opencode --yolo -s ses_f08700672ffenN8gLm9kPx2xb6')
    await hooks['experimental.chat.system.transform']({ sessionID: 'ses_x; rm -rf /' }, output)
    expect(output.system.at(-1)).not.toContain('rm -rf')
  })

  it.each([
    ['/Users/leo/.claudep', 'claudep'],
    ['/Users/leo/.claudew/', 'claudew'],
    ['/Users/leo/.claude', 'claude'],
    [undefined, 'claude'],
  ])('tells Claude its resume command for config dir %s on session start only', async (configDir, launcher) => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const settings = JSON.parse(await readFile(paths.claudeSettingsPath, 'utf8'))
    const run = async (event: string) => {
      const command = settings.hooks[event][0].hooks[0]
      const env: NodeJS.ProcessEnv = { ...process.env, COMMANDO_PORT: '1', TMUX_PANE: '%42' }
      if (configDir) env.CLAUDE_CONFIG_DIR = configDir
      else delete env.CLAUDE_CONFIG_DIR
      const child = spawn(command.command, command.args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'd227943a-841a-4dfa-94c7-afe2e0774487', prompt: 'hi' }))
      await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) })
      return JSON.parse(stdout).hookSpecificOutput.additionalContext as string
    }
    expect(await run('SessionStart')).toContain(`Resume command for this conversation: ${launcher} --resume d227943a-841a-4dfa-94c7-afe2e0774487`)
    expect(await run('UserPromptSubmit')).not.toContain('Resume command')
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

  it('ignores profile variables that point outside an overridden HOME', async () => {
    const realHome = await mkdtemp(join(tmpdir(), 'commando-hook-real-home-'))
    const isolatedHome = await mkdtemp(join(tmpdir(), 'commando-hook-isolated-home-'))
    cleanup.push(() => rm(realHome, { recursive: true, force: true }))
    cleanup.push(() => rm(isolatedHome, { recursive: true, force: true }))
    vi.stubEnv('HOME', isolatedHome)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(realHome, '.claudep'))
    vi.stubEnv('CODEX_HOME', join(realHome, '.codex'))
    vi.stubEnv(AGENT_HOOK_TOKEN_PATH_ENV, join(realHome, '.commando', 'agent-hook-token'))

    const installed = await new AgentHookInstaller().install()

    expect(installed.claudeSettingsPath).toBe(join(isolatedHome, '.claude', 'settings.json'))
    expect(installed.codexConfigPath).toBe(join(isolatedHome, '.codex', 'config.toml'))
    expect(installed.tokenPath).toBe(join(isolatedHome, '.commando', 'agent-hook-token'))
    await expect(readdir(realHome)).resolves.toEqual([])
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
    const firstCodexConfig = await readFile(paths.codexConfigPath, 'utf8')
    const firstCodexBridge = await readFile(paths.codexBridgePath, 'utf8')
    await installer.install()

    expect(await readFile(paths.claudeSettingsPath, 'utf8')).toBe(firstSettings)
    expect(await readFile(paths.claudeBridgePath, 'utf8')).toBe(firstBridge)
    expect(await readFile(paths.openCodePluginPath, 'utf8')).toBe(firstPlugin)
    expect(await readFile(paths.codexConfigPath, 'utf8')).toBe(firstCodexConfig)
    expect(await readFile(paths.codexBridgePath, 'utf8')).toBe(firstCodexBridge)
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
    const simCli = await readFile(paths.simCliPath, 'utf8')

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
    expect(simCli).toContain('/api/sim-leases')
    expect(simCli).toContain('X-Commando-Pane')
    expect(simCli).not.toContain(token)
    expect(paths.simCliPath).toBe(join(home, '.commando', 'hooks', 'commando-sim.mjs'))
    expect((await stat(paths.simCliPath)).mode & 0o777).toBe(0o700)
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

  it('maps --session and --remove-session to session reference patches', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const bodies: unknown[] = []
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => { raw += chunk })
      request.on('end', () => { bodies.push(JSON.parse(raw)); response.writeHead(200); response.end('{}') })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')
    const run = (...args: string[]) => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [paths.sessionBriefCliPath, ...args], {
        env: { ...process.env, COMMANDO_PORT: String(address.port), TMUX_PANE: '%1' },
        stdio: 'ignore',
      })
      child.on('exit', resolve)
    })
    expect(await run('--session', 'claudep --resume d227943a-841a-4dfa-94c7-afe2e0774487')).toBe(0)
    expect(await run('--remove-session', 'claudep --resume d227943a-841a-4dfa-94c7-afe2e0774487')).toBe(0)
    expect(bodies).toEqual([
      { reference: { action: 'upsert', kind: 'session', value: 'claudep --resume d227943a-841a-4dfa-94c7-afe2e0774487' } },
      { reference: { action: 'remove', kind: 'session', value: 'claudep --resume d227943a-841a-4dfa-94c7-afe2e0774487' } },
    ])
  })

  it('installs the Codex notify bridge into config.toml', async () => {
    const home = await temporaryHome()
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(
      join(home, '.codex', 'config.toml'),
      'model = "gpt-5"\n\n[tui]\nnotifications = true\n',
    )
    const paths = await new AgentHookInstaller({ home }).install()
    const token = (await readFile(paths.tokenPath, 'utf8')).trim()
    const bridge = await readFile(paths.codexBridgePath, 'utf8')

    expect(paths.codexBridgePath).toBe(
      join(home, '.commando', 'hooks', 'commando-codex-notify.mjs'),
    )
    expect(await readFile(paths.codexConfigPath, 'utf8')).toBe([
      'model = "gpt-5"',
      '',
      '# commando:codex-notify v1',
      `notify = ["node", "${paths.codexBridgePath}"]`,
      '',
      '[tui]',
      'notifications = true',
      '',
    ].join('\n'))
    expect(bridge).toContain('/api/agent-status/hooks/codex')
    expect(bridge).toContain('X-Commando-Pane')
    expect(bridge).toContain('const forwardTo = null')
    expect(bridge).not.toContain(token)
    expect((await stat(paths.codexBridgePath)).mode & 0o777).toBe(0o600)

    // Running it without a payload or a pane must stay silent and successful.
    const exit = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [paths.codexBridgePath], {
        env: { ...process.env, TMUX_PANE: '' },
        stdio: 'ignore',
      })
      child.on('exit', resolve)
    })
    expect(exit).toBe(0)
  })

  it('honors CODEX_HOME and leaves an unparseable notify to the operator', async () => {
    const home = await temporaryHome()
    const codexHome = join(home, 'codex-profile')
    await mkdir(codexHome, { recursive: true })
    await writeFile(join(codexHome, 'config.toml'), 'notify = [42]\n')
    vi.stubEnv('HOME', home)
    vi.stubEnv('CODEX_HOME', codexHome)

    const installed = await new AgentHookInstaller().install()

    expect(installed.codexConfigPath).toBe(join(codexHome, 'config.toml'))
    expect(await readFile(installed.codexConfigPath, 'utf8')).toBe('notify = [42]\n')
    expect(installed.codexNotifyWarning).toContain(installed.codexConfigPath)

    vi.stubEnv('CODEX_HOME', '   ')
    expect(() => new AgentHookInstaller()).toThrow('CODEX_HOME must not be empty')
  })

  it('forwards only bounded sanitized Codex metadata and chains the previous notifier', async () => {
    const home = await temporaryHome()
    const previousNotifier = join(home, 'previous-notifier.mjs')
    const forwarded = join(home, 'forwarded.txt')
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(
      previousNotifier,
      `import { appendFile } from 'node:fs/promises'\n` +
      `await appendFile(${JSON.stringify(forwarded)}, process.argv.slice(2).join(' ') + '\\n')\n`,
    )
    await writeFile(
      join(home, '.codex', 'config.toml'),
      `notify = ["node", ${JSON.stringify(previousNotifier)}]\n`,
    )
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
      expect(await readFile(paths.codexConfigPath, 'utf8')).toBe([
        `# commando:codex-notify v1 wrapped=["node",${JSON.stringify(previousNotifier)}]`,
        `notify = ["node", "${paths.codexBridgePath}"]`,
        '',
      ].join('\n'))

      const payload = JSON.stringify({
        type: 'agent-turn-complete',
        'turn-id': 'turn-1',
        'session-id': 'legacy-thread',
        cwd: '/repo',
        client: 'codex-tui',
        'input-messages': ['Rename foo\nOPENAI_API_KEY=raw-input-secret'],
        'last-assistant-message': 'Renamed foo.\nghp_1234567890abcdefghijkl\n🟢 Renamed foo to bar',
        'raw-transcript': 'raw-transcript-content',
      })
      const child = spawn(process.execPath, [paths.codexBridgePath, payload], {
        env: { ...process.env, COMMANDO_PORT: String(address.port), TMUX_PANE: '%42' },
        stdio: 'ignore',
      })
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => code === 0
          ? resolve()
          : reject(new Error(`Bridge exited ${code}`)))
      })
      await vi.waitFor(() => expect(received).toHaveLength(1))
      await vi.waitFor(async () => expect(await readFile(forwarded, 'utf8')).toContain(payload))

      expect(received[0].pane).toBe('%42')
      expect(received[0].authorization).toBe(`Bearer ${token}`)
      expect(received[0].body.receivedAt).toBeTypeOf('number')
      expect(received[0].body.event).toEqual({
        type: 'agent-turn-complete',
        'turn-id': 'turn-1',
        'thread-id': 'legacy-thread',
        cwd: '/repo',
        client: 'codex-tui',
        'input-messages': ['Rename foo OPENAI_API_KEY=[REDACTED]'],
        'last-assistant-message': 'Renamed foo.\n[REDACTED]\n🟢 Renamed foo to bar',
      })
      expect(JSON.stringify(received[0].body)).not.toContain('raw-transcript-content')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
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

  it('rewrites a Codex notify left pointing at a departed bridge', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const departed = join(home, 'departed', 'commando-codex-notify.mjs')
    await writeFile(paths.codexConfigPath, [
      '# commando:codex-notify v1',
      `notify = ["node", "${departed}"]`,
      '',
    ].join('\n'))

    const repair = await repairAgentStatusHooks({ home })

    expect(repair).toEqual({ repaired: true, staleBridgePaths: [departed] })
    expect(await readFile(paths.codexConfigPath, 'utf8')).toBe([
      '# commando:codex-notify v1',
      `notify = ["node", "${paths.codexBridgePath}"]`,
      '',
    ].join('\n'))
    expect((await stat(paths.codexBridgePath)).mode & 0o777).toBe(0o600)
  })

  it('restores a Codex bridge deleted from underneath a healthy notify', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const notify = await readFile(paths.codexConfigPath, 'utf8')
    await rm(paths.codexBridgePath)

    const repair = await repairAgentStatusHooks({ home })

    expect(repair).toEqual({ repaired: true, staleBridgePaths: [paths.codexBridgePath] })
    expect(await readFile(paths.codexConfigPath, 'utf8')).toBe(notify)
    expect((await stat(paths.codexBridgePath)).mode & 0o777).toBe(0o600)
  })

  it('keeps a notify Commando does not manage out of a Claude repair', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const foreignNotify = 'notify = ["/usr/local/bin/my-notifier"]\n'
    await writeFile(paths.codexConfigPath, foreignNotify)
    await rm(paths.claudeBridgePath)

    const repair = await repairAgentStatusHooks({ home })

    expect(repair).toEqual({ repaired: true, staleBridgePaths: [paths.claudeBridgePath] })
    expect(await readFile(paths.codexConfigPath, 'utf8')).toBe(foreignNotify)
  })

  it('never creates a Codex config for a home that has none', async () => {
    const home = await temporaryHome()
    const settingsPath = join(home, '.claude', 'settings.json')
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(settingsPath, `${JSON.stringify({
      hooks: {
        Stop: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: 'node',
            args: [join(home, 'gone.mjs'), '--commando-agent-status-hook'],
          }],
        }],
      },
    }, null, 2)}\n`)

    const repair = await repairAgentStatusHooks({ home })

    expect(repair).toEqual({ repaired: true, staleBridgePaths: [join(home, 'gone.mjs')] })
    await expect(stat(join(home, '.codex', 'config.toml'))).rejects.toThrow()
  })

  it('never repairs a Codex config outside the running home', async () => {
    const elsewhere = await temporaryHome()
    const elsewherePaths = await new AgentHookInstaller({ home: elsewhere }).install()
    const before = await readFile(elsewherePaths.codexConfigPath, 'utf8')
    await rm(elsewherePaths.codexBridgePath)

    await temporaryHome()
    vi.stubEnv('CODEX_HOME', join(elsewhere, '.codex'))

    expect(await repairAgentStatusHooks()).toEqual({ repaired: false, staleBridgePaths: [] })
    expect(await readFile(elsewherePaths.codexConfigPath, 'utf8')).toBe(before)
    await expect(stat(elsewherePaths.codexBridgePath)).rejects.toThrow()
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

type SimCliDependencies = {
  request: (method: string, suffix: string, body?: Record<string, unknown>) => Promise<unknown>
  run: (file: string, args: string[], cwd?: string) => Promise<string>
  exists: (path: string) => Promise<boolean>
  onPath: (name: string) => Promise<boolean>
}
type SimCliModule = {
  formatLabel: (session: string, task?: string) => string
  chooseDevice: (listing: unknown, held: string[], requested?: string) => { udid: string; name: string }
  verifySlim: (output: string, udid: string) => void
  runSimCommand: (args: string[], dependencies: SimCliDependencies) => Promise<unknown>
}

async function loadSimCli(): Promise<SimCliModule> {
  const source = generatedSimCli('/test/token').replace(/^#![^\n]*\n/, '')
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Promise<SimCliModule>
}

const simUdid = '11111111-1111-1111-1111-111111111111'
const secondSimUdid = '22222222-2222-2222-2222-222222222222'
const fakeDevice = { udid: simUdid, name: 'iPhone 17', state: 'Shutdown', isAvailable: true }
const fakeDevices = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [fakeDevice] } }
const fakeSlim = `${simUdid}  iPhone 17  iOS 26.5   booted · 170/170 slim\n`
const fakeLease = { udid: simUdid, originalName: 'iPhone 17', task: 'previous task', label: 'Session · previous task', via: 'simslim', repo: { root: '/original-main' } }

function simDependencies(
  lease: typeof fakeLease | null = null,
  listing: { devices: Record<string, typeof fakeDevice[]> } = lease
    ? { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ ...fakeDevice, state: 'Booted' }] } }
    : fakeDevices,
) {
  const context = { sessionName: ' Session\n name ', repo: { root: '/main' }, lease, heldUdids: [] as string[] }
  const request = vi.fn(async (method: string, suffix: string, body?: Record<string, unknown>) => {
    if (suffix === '/context') return context
    if (suffix === '/reservation') return method === 'POST' ? { operation: 'operation-id' } : { ok: true }
    if (method === 'GET') return { leases: lease ? [lease] : [] }
    if (method === 'PUT' || method === 'PATCH') return { lease: { ...fakeLease, ...body, label: 'Session name' + (body?.task ? ' · ' + body.task : '') } }
    return { ok: true }
  })
  const run = vi.fn(async (file: string, args: string[], _cwd?: string) => {
    if (file === 'xcrun' && args[1] === 'list') return JSON.stringify(listing)
    if (file === 'simslim' && args[0] === 'list') return fakeSlim
    return ''
  })
  return { context, request, run, exists: vi.fn(async (_path: string) => false), onPath: vi.fn(async (_name: string) => false) }
}

describe('generated simulator lease CLI', () => {
  it('chooses a free Shutdown iPhone only on the newest available numeric iOS runtime', async () => {
    const cli = await loadSimCli()
    const listing = { devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-9': [fakeDevice],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-10': [
        { ...fakeDevice, udid: secondSimUdid },
        { ...fakeDevice, udid: '33333333-3333-3333-3333-333333333333', state: 'Booted' },
        { ...fakeDevice, udid: '44444444-4444-4444-4444-444444444444', name: 'iPad Pro' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ ...fakeDevice, isAvailable: false }],
      'com.apple.CoreSimulator.SimRuntime.tvOS-28-0': [fakeDevice],
    } }
    expect(cli.chooseDevice(listing, []).udid).toBe(secondSimUdid)
    expect(() => cli.chooseDevice(listing, [secondSimUdid])).toThrow('newest available')
    expect(cli.chooseDevice(listing, [], simUdid).udid).toBe(simUdid)
    expect(() => cli.chooseDevice(listing, [simUdid], simUdid)).toThrow('held by another pane')
    expect(() => cli.chooseDevice({ devices: {} }, [])).toThrow('No free')
    expect(cli.chooseDevice({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ ...fakeDevice, name: 'iPad Pro' }] } }, [], simUdid).udid).toBe(simUdid)
  })

  it('formats labels and verifies the exact UDID, boot state and complete slim counts', async () => {
    const cli = await loadSimCli()
    expect(cli.formatLabel(' Session\n name\u0000 ', ' check\t state\u0001 ')).toBe('Session name · check state')
    expect(cli.formatLabel('Session')).toBe('Session')
    for (const text of ['c \u0000 d', 't\n\t f', '😀'.repeat(80), '  ']) {
      expect(cli.formatLabel('a \u0001 b', text)).toBe(formatSimLabel('a \u0001 b', text))
    }
    expect(Array.from(cli.formatLabel('😀'.repeat(100)))).toHaveLength(60)
    expect(() => cli.verifySlim(fakeSlim, simUdid.toLowerCase())).not.toThrow()
    for (const output of ['', fakeSlim.replace('170/170', '169/170'), fakeSlim.replace('170/170', '0/0'),
      fakeSlim.replace('booted', 'shutdown'), fakeSlim.replace(simUdid, secondSimUdid)]) {
      expect(() => cli.verifySlim(output, simUdid)).toThrow('not booted and fully slim')
    }
  })

  it('boots via simslim, verifies before renaming and registering, and prints lease metadata', async () => {
    const cli = await loadSimCli()
    const dependencies = simDependencies()
    expect(await cli.runSimCommand(['lease', '--task', 'check empty state'], dependencies)).toEqual({
      udid: simUdid, label: 'Session name · check empty state', originalName: 'iPhone 17',
    })
    expect(dependencies.run.mock.calls).toEqual([
      ['xcrun', ['simctl', 'list', 'devices', '--json']], ['simslim', ['on', simUdid]],
      ['simslim', ['list', '--booted']], ['xcrun', ['simctl', 'rename', simUdid, 'Session name · check empty state']],
    ])
    expect(dependencies.request.mock.calls).toEqual([
      ['GET', '/context'], ['POST', '/reservation', { udid: simUdid }],
      ['PUT', '', { operation: 'operation-id', udid: simUdid, originalName: 'iPhone 17', via: 'simslim', task: 'check empty state' }],
      ['DELETE', '/reservation', { operation: 'operation-id' }],
    ])
    const calls = dependencies.run.mock.invocationCallOrder
    expect(dependencies.request.mock.invocationCallOrder[1]).toBeLessThan(calls[1])
    expect(calls[2]).toBeLessThan(calls[3])
    expect(calls[3]).toBeLessThan(dependencies.request.mock.invocationCallOrder[2])
  })

  it('uses simfleet only with a main-checkout project and executable, then releases through the original repo', async () => {
    const cli = await loadSimCli()
    const deps = simDependencies()
    deps.exists.mockResolvedValue(true)
    deps.onPath.mockResolvedValue(true)
    await cli.runSimCommand(['lease', '--device', simUdid], deps)
    expect(deps.exists).toHaveBeenCalledWith('/main/.sim-fleet/project.json')
    expect(deps.onPath).toHaveBeenCalledWith('simfleet')
    expect(deps.run.mock.calls.slice(1)).toEqual([
      ['simfleet', ['sim', 'boot', simUdid], '/main'], ['simfleet', ['claim', simUdid, 'Session name'], '/main'],
      ['simslim', ['list', '--booted']], ['xcrun', ['simctl', 'rename', simUdid, 'Session name']],
    ])
    expect(deps.request).toHaveBeenCalledWith('PUT', '', expect.objectContaining({ via: 'simfleet' }))
    const release = simDependencies({ ...fakeLease, via: 'simfleet' })
    await cli.runSimCommand(['release'], release)
    expect(release.run.mock.calls).toEqual([
      ['xcrun', ['simctl', 'list', 'devices', '--json']],
      ['xcrun', ['simctl', 'rename', simUdid, 'iPhone 17']], ['xcrun', ['simctl', 'shutdown', simUdid]],
      ['simfleet', ['release', simUdid], '/original-main'],
    ])
    expect(release.request.mock.calls.slice(2)).toEqual([
      ['DELETE', '', { operation: 'operation-id' }], ['DELETE', '/reservation', { operation: 'operation-id' }],
    ])
    const fallback = simDependencies()
    fallback.exists.mockResolvedValue(true)
    await cli.runSimCommand(['lease'], fallback)
    expect(fallback.run).toHaveBeenCalledWith('simslim', ['on', simUdid])
  })

  it('reuses and touches a lease without booting, relabels when tasks change and preserves the original name', async () => {
    const cli = await loadSimCli()
    const deps = simDependencies(fakeLease)
    await cli.runSimCommand(['lease'], deps)
    expect(deps.run.mock.calls).toEqual([
      ['xcrun', ['simctl', 'list', 'devices', '--json']],
      ['simslim', ['list', '--booted']], ['xcrun', ['simctl', 'rename', simUdid, 'Session name · previous task']],
    ])
    expect(deps.request).toHaveBeenCalledWith('PATCH', '', { operation: 'operation-id', task: 'previous task' })
    await cli.runSimCommand(['label', 'ready: check empty state'], deps)
    expect(deps.run).toHaveBeenLastCalledWith('xcrun', ['simctl', 'rename', simUdid, 'Session name · ready: check empty state'])
    await cli.runSimCommand(['lease', '--task', 'new task'], deps)
    expect(deps.request).toHaveBeenLastCalledWith('DELETE', '/reservation', { operation: 'operation-id' })
    expect(deps.request).toHaveBeenCalledWith('PATCH', '', { operation: 'operation-id', task: 'new task' })
  })

  it('does not rename or register if boot/slim verification fails, and unlocks for retry', async () => {
    const cli = await loadSimCli()
    for (const failingCommand of ['on', 'list']) {
      const deps = simDependencies()
      deps.run.mockImplementation(async (file, args) => {
        if (file === 'xcrun') return JSON.stringify(fakeDevices)
        if (args[0] === failingCommand && failingCommand === 'on') throw new Error('boot failed')
        return fakeSlim.replace('170/170', '169/170')
      })
      await expect(cli.runSimCommand(['lease'], deps)).rejects.toThrow(failingCommand === 'on' ? 'boot failed' : 'fully slim')
      const renames = deps.run.mock.calls.filter(([, args]) => args.includes('rename'))
      // A failed boot never renames; a failed slim check only restores the original name and shuts down.
      expect(renames.some(([, args]) => String(args.at(-1)).includes(' · '))).toBe(false)
      expect(renames.length).toBe(failingCommand === 'on' ? 0 : 1)
      expect(deps.run.mock.calls.some(([, args]) => args.includes('shutdown'))).toBe(failingCommand === 'list')
      expect(deps.request.mock.calls.some(([method]) => method === 'PUT' || method === 'PATCH')).toBe(false)
      expect(deps.request).toHaveBeenLastCalledWith('DELETE', '/reservation', { operation: 'operation-id' })
    }
  })

  it('restores and shuts down the simulator when recording a new lease fails', async () => {
    const cli = await loadSimCli()
    const deps = simDependencies()
    const request = deps.request.getMockImplementation()!
    deps.request.mockImplementation(async (method: string, suffix: string, body?: Record<string, unknown>) => {
      if (method === 'PUT') throw new Error('Commando returned 500')
      return request(method, suffix, body)
    })
    await expect(cli.runSimCommand(['lease', '--task', 'checkout'], deps)).rejects.toThrow('Commando returned 500')
    const simctl = deps.run.mock.calls.filter(([file]) => file === 'xcrun').map(([, args]) => args)
    const renames = simctl.filter((args) => args.includes('rename'))
    expect(renames).toHaveLength(2)
    expect(String(renames[1].at(-1))).not.toContain(' · ')
    expect(simctl.at(-1)).toContain('shutdown')
  })

  it('fails before any device mutation on a reservation conflict and reuses an existing lease over --device', async () => {
    const cli = await loadSimCli()
    const deps = simDependencies()
    deps.request.mockImplementation(async (_method, suffix) => {
      if (suffix === '/context') return deps.context
      throw new Error('Simulator is held by another pane')
    })
    await expect(cli.runSimCommand(['lease'], deps)).rejects.toThrow('held by another pane')
    expect(deps.run).toHaveBeenCalledTimes(1)
    const existing = simDependencies(fakeLease)
    await cli.runSimCommand(['lease', '--device', secondSimUdid], existing)
    expect(existing.run).toHaveBeenLastCalledWith('xcrun', ['simctl', 'rename', simUdid, 'Session name · previous task'])
  })

  it('retains the registry lease if restore, shutdown or fleet release fails', async () => {
    const cli = await loadSimCli()
    for (const command of ['rename', 'shutdown', 'release']) {
      const deps = simDependencies({ ...fakeLease, via: 'simfleet' })
      deps.run.mockImplementation(async (_file, args) => {
        if (args[1] === 'list') return JSON.stringify({ devices: { ios: [{ ...fakeDevice, state: 'Booted' }] } })
        if (args.includes(command)) throw new Error(command + ' failed')
        return ''
      })
      await expect(cli.runSimCommand(['release'], deps)).rejects.toThrow(command + ' failed')
      expect(deps.request.mock.calls.some(([method, suffix]) => method === 'DELETE' && suffix === '')).toBe(false)
      expect(deps.request).toHaveBeenLastCalledWith('DELETE', '/reservation', { operation: 'operation-id' })
    }
  })

  it('releases an already Shutdown device and a missing device without getting stuck', async () => {
    const cli = await loadSimCli()
    for (const missing of [false, true]) {
      const deps = simDependencies(fakeLease, missing ? { devices: {} } : fakeDevices)
      await expect(cli.runSimCommand(['release'], deps)).resolves.toEqual({ ok: true })
      expect(deps.run.mock.calls).toEqual([
        ['xcrun', ['simctl', 'list', 'devices', '--json']],
        ...(missing ? [] : [['xcrun', ['simctl', 'rename', simUdid, 'iPhone 17']]]),
      ])
      expect(deps.request).toHaveBeenCalledWith('DELETE', '', { operation: 'operation-id' })
      expect(deps.request).toHaveBeenLastCalledWith('DELETE', '/reservation', { operation: 'operation-id' })
      deps.context.lease = null
      deps.run.mockClear()
      await expect(cli.runSimCommand(['release'], deps)).resolves.toEqual({ ok: true })
      expect(deps.run).not.toHaveBeenCalled()
    }
  })

  it('deletes a simfleet lease when release reports nothing claimed, including a deleted simulator', async () => {
    const cli = await loadSimCli()
    for (const missing of [false, true]) {
      for (const stderr of ['Nothing is claimed', 'Device is not currently claimed', 'No active claim for device']) {
        const deps = simDependencies({ ...fakeLease, via: 'simfleet' }, missing ? { devices: {} } : fakeDevices)
        deps.run.mockImplementation(async (file, args) => {
          if (args[1] === 'list') return JSON.stringify(missing ? { devices: {} } : fakeDevices)
          if (file === 'simfleet') throw Object.assign(new Error('Command failed'), { stderr })
          return ''
        })
        await expect(cli.runSimCommand(['release'], deps)).resolves.toEqual({ ok: true })
        expect(deps.run).toHaveBeenLastCalledWith('simfleet', ['release', simUdid], '/original-main')
        expect(deps.request).toHaveBeenCalledWith('DELETE', '', { operation: 'operation-id' })
        expect(deps.run.mock.invocationCallOrder.at(-1)).toBeLessThan(deps.request.mock.invocationCallOrder[2])
      }
    }
  })

  it('reboots an existing Shutdown lease via its recorded boot path before verifying and touching', async () => {
    const cli = await loadSimCli()
    for (const via of ['simslim', 'simfleet']) {
      const deps = simDependencies({ ...fakeLease, via }, fakeDevices)
      const label = 'Session name · recovered task'
      await expect(cli.runSimCommand(['lease', '--task', 'recovered task'], deps)).resolves.toEqual({
        udid: simUdid, label, originalName: 'iPhone 17',
      })
      expect(deps.run.mock.calls).toEqual([
        ['xcrun', ['simctl', 'list', 'devices', '--json']],
        ...(via === 'simfleet' ? [
          ['simfleet', ['sim', 'boot', simUdid], '/original-main'],
          ['simfleet', ['claim', simUdid, label], '/original-main'],
        ] : [['simslim', ['on', simUdid]]]),
        ['simslim', ['list', '--booted']], ['xcrun', ['simctl', 'rename', simUdid, label]],
      ])
      expect(deps.exists).not.toHaveBeenCalled()
      expect(deps.onPath).not.toHaveBeenCalled()
      expect(deps.request.mock.calls.slice(2)).toEqual([
        ['PATCH', '', { operation: 'operation-id', task: 'recovered task' }],
        ['DELETE', '/reservation', { operation: 'operation-id' }],
      ])
      expect(deps.run.mock.invocationCallOrder.at(-1)).toBeLessThan(deps.request.mock.invocationCallOrder[2])
    }
    const unchangedTask = simDependencies(fakeLease, fakeDevices)
    await cli.runSimCommand(['lease'], unchangedTask)
    expect(unchangedTask.request).toHaveBeenCalledWith('PATCH', '', { operation: 'operation-id', task: 'previous task' })
  })

  it('tells label callers to lease again when the leased device is not Booted', async () => {
    const cli = await loadSimCli()
    for (const listing of [fakeDevices, { devices: {} }]) {
      const deps = simDependencies(fakeLease, listing)
      await expect(cli.runSimCommand(['label', 'ready: review'], deps)).rejects.toThrow('run commando-sim.mjs lease again')
      expect(deps.run.mock.calls).toEqual([['xcrun', ['simctl', 'list', 'devices', '--json']]])
      expect(deps.request.mock.calls.slice(2)).toEqual([['DELETE', '/reservation', { operation: 'operation-id' }]])
    }
  })

  it('keeps an existing lease when recovery boot or slim verification fails', async () => {
    const cli = await loadSimCli()
    for (const via of ['simslim', 'simfleet']) {
      for (const bootFails of [true, false]) {
        const deps = simDependencies({ ...fakeLease, via }, fakeDevices)
        deps.run.mockImplementation(async (file, args) => {
          if (file === 'xcrun' && args[1] === 'list') return JSON.stringify(fakeDevices)
          if (bootFails && (args[0] === 'on' || args[0] === 'sim')) throw new Error('boot failed')
          return fakeSlim.replace('170/170', '169/170')
        })
        await expect(cli.runSimCommand(['lease'], deps)).rejects.toThrow(bootFails ? 'boot failed' : 'fully slim')
        expect(deps.run.mock.calls.some(([, args]) => args.includes('rename'))).toBe(false)
        expect(deps.request.mock.calls.some(([method]) => method === 'PUT' || method === 'PATCH')).toBe(false)
        expect(deps.request.mock.calls.some(([method, suffix]) => method === 'DELETE' && suffix === '')).toBe(false)
        expect(deps.request).toHaveBeenLastCalledWith('DELETE', '/reservation', { operation: 'operation-id' })
      }
    }
  })

  it('directs lease callers to release a stale lease when its device no longer exists', async () => {
    const cli = await loadSimCli()
    const deps = simDependencies(fakeLease, { devices: {} })
    await expect(cli.runSimCommand(['lease'], deps)).rejects.toThrow('run release, then lease again')
    expect(deps.run.mock.calls).toEqual([['xcrun', ['simctl', 'list', 'devices', '--json']]])
    expect(deps.request.mock.calls.slice(2)).toEqual([['DELETE', '/reservation', { operation: 'operation-id' }]])
  })

  it('lists without invoking tools, handles missing leases and rejects malformed arguments', async () => {
    const cli = await loadSimCli()
    const deps = simDependencies()
    expect(await cli.runSimCommand(['list'], deps)).toEqual([])
    expect(deps.run).not.toHaveBeenCalled()
    expect(await cli.runSimCommand(['release'], deps)).toEqual({ ok: true })
    await expect(cli.runSimCommand(['label', 'task'], deps)).rejects.toThrow('no simulator lease')
    await expect(cli.runSimCommand(['lease', '--device', 'bad'], deps)).rejects.toThrow('simulator UUID')
    for (const args of [[], ['lease', '--device'], ['lease', '--wrong', 'value'], ['label'], ['list', 'extra']]) {
      await expect(cli.runSimCommand(args, deps)).rejects.toThrow('Usage:')
    }
  })

  it('runs the installed CLI with the hook token, port and pane headers using a fake transport', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const token = (await readFile(paths.tokenPath, 'utf8')).trim()
    const capturePath = join(home, 'request.json')
    const transportPath = join(home, 'fake-transport.mjs')
    await writeFile(transportPath, `import { writeFile } from 'node:fs/promises'
      globalThis.fetch = async (url, options) => {
        await writeFile(${JSON.stringify(capturePath)}, JSON.stringify({ url, headers: options.headers }))
        return { ok: true, json: async () => ({ leases: ${JSON.stringify([fakeLease])} }) }
      }
    `)
    const result = await new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', transportPath, paths.simCliPath, 'list'], {
        env: { ...process.env, TMUX_PANE: '%42', COMMANDO_PORT: '4410', PATH: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = '', error = ''
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { error += chunk })
      child.on('error', reject)
      child.on('exit', (code) => resolve({ code, output, error }))
    })
    expect(result.code).toBe(0)
    expect(result.error).toBe('')
    expect(JSON.parse(result.output)).toEqual([fakeLease])
    expect(JSON.parse(await readFile(capturePath, 'utf8'))).toEqual({
      url: 'http://127.0.0.1:4410/api/sim-leases', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Commando-Pane': '%42',
      },
    })
  })
})

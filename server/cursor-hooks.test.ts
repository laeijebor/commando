import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookInstaller } from './agent-hook-installer.js'
import { CURSOR_HOOK_EVENTS, normalizeCursorHook, sanitizeCursorActivityId } from './cursor-hooks.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(cleanups.splice(0).map((task) => task())) })
async function home() {
  const path = await mkdtemp(join(tmpdir(), "commando cursor 'home-"))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}
async function run(path: string, input: unknown, env: Record<string, string> = {}, event = 'sessionStart') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...(env.COMMANDO_TEST_TRANSPORT ? ['--import', env.COMMANDO_TEST_TRANSPORT] : []), path, '--commando-cursor-status-hook', event], {
      env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error) })
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
}
async function fakeTransport(directory: string, fails: boolean | number = false) {
  const path = join(directory, 'fake-transport.mjs')
  const requests = join(directory, 'requests.jsonl')
  await writeFile(path, `import { appendFile } from 'node:fs/promises'
    import fs from 'node:fs/promises'
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    import { promisify } from 'node:util'
    const realStat = fs.stat; const realPath = fs.realpath
    fs.realpath = async (path, ...args) => path === '/fixture/cursor.sock' || path === '/fixture/cursor-agent/versions/1/index.js' ? path : realPath(path, ...args)
    fs.stat = async (path, ...args) => path === '/fixture/cursor.sock' ? { isSocket: () => true, dev: 1n, ino: 2n } : realStat(path, ...args)
    childProcess.execFile = () => { throw new Error('Unexpected transport invocation') }
    childProcess.execFile[promisify.custom] = async (command, args) => {
      if (command === 'tmux') return { stdout: '/fixture/cursor.sock|90|100\\n' }
      if (command === '/bin/ps' && args[0] === '-p') return { stdout: process.execPath + '\\n' }
      if (command === '/bin/ps') return { stdout: '90 1 90 -1 Tue Oct 6 12:00:00 2026 tmux\\n100 90 100 100 Tue Oct 6 12:00:01 2026 ' + process.execPath + ' /fixture/cursor-agent/versions/1/index.js\\n' + process.pid + ' 100 100 100 Tue Oct 6 12:00:02 2026 node bridge.mjs\\n' }
      throw new Error('Unexpected command')
    }
    syncBuiltinESMExports()
    globalThis.fetch = async (url, options) => {
      await appendFile(process.env.COMMANDO_TEST_REQUESTS, JSON.stringify({ url, headers: options.headers, body: JSON.parse(options.body) }) + '\\n')
      ${fails === true ? "throw new Error('daemon unavailable')" : `return { ok: ${typeof fails === 'number' ? 'false' : 'true'}, status: ${typeof fails === 'number' ? fails : 200}, json: async () => ({ ok: true, accepted: true }) }`}
    }`)
  return {
    env: { TMUX: '/fixture/cursor.sock,90,0', TMUX_PANE: '%4', COMMANDO_PORT: '4319', COMMANDO_TEST_TRANSPORT: path, COMMANDO_TEST_REQUESTS: requests },
    received: async (): Promise<Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>> => {
      try { return (await readFile(requests, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    },
  }
}
const base = { conversation_id: 'conv-abcdefgh', generation_id: 'gen-1', cursor_version: '2026.10.01' }

describe('Cursor native bridge', () => {
  it('executes a standalone generated bridge, supplies context/resume, and sends bounded authenticated metadata', async () => {
    const paths = await new AgentHookInstaller({ home: await home() }).install()
    const transport = await fakeTransport(join(paths.cursorBridgePath, '..'))
    const env = transport.env
    const started = await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart' }, env)
    expect(started).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(started.stdout).additional_context).toContain('agent --resume=conv-abcdefgh')
    expect(started.stdout).not.toContain('--yolo')
    expect(started.stdout).toContain(paths.sessionBriefCliPath)
    const tool = await run(paths.cursorBridgePath, { ...base, hook_event_name: 'postToolUse', tool_name: 'Shell', tool_use_id: 'tool-1',
      tool_input: { command: 'npm test', password: 'input-secret' },
      tool_output: JSON.stringify({ exitCode: 0, stdout: 'private output '.repeat(20000), stderr: 'secret stderr' }),
      transcript_path: '/private/transcript', user_email: 'private@example.org', text: 'hidden thoughts',
    }, env)
    expect(tool).toMatchObject({ code: 0, stderr: '', stdout: '{}\n' })
    const received = await transport.received()
    expect(received).toHaveLength(2)
    expect(received[1]).toMatchObject({ url: 'http://127.0.0.1:4319/api/agent-status/hooks/cursor', headers: {
      Authorization: `Bearer ${(await readFile(paths.tokenPath, 'utf8')).trim()}`, 'X-Commando-Pane': '%4',
    }, body: { hook_event_name: 'postToolUse', check: { label: 'test', status: 'passed' }, activity: { label: 'Run command' } } })
    const serialized = JSON.stringify(received[1].body)
    for (const raw of ['input-secret', 'private output', 'secret stderr', 'npm test', '/private/transcript', 'private@example.org', 'hidden thoughts']) expect(serialized).not.toContain(raw)
    expect(Buffer.byteLength(serialized)).toBeLessThan(64 * 1024)
    const installed = await readFile(paths.cursorBridgePath, 'utf8')
    expect(installed).not.toContain((await readFile(paths.tokenPath, 'utf8')).trim())
    expect(installed).not.toContain('cursor-enable')
  })

  it('executes the exact installed shell command safely with spaces and quotes in the home path', async () => {
    const paths = await new AgentHookInstaller({ home: await home() }).install()
    const transport = await fakeTransport(join(paths.cursorBridgePath, '..'))
    const settings = JSON.parse(await readFile(paths.cursorHooksPath, 'utf8'))
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', settings.hooks.sessionStart[0].command], {
        env: { PATH: process.env.PATH, ...transport.env, NODE_OPTIONS: '--import=' + JSON.stringify(transport.env.COMMANDO_TEST_TRANSPORT) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', (data) => { stdout += data })
      child.stderr.on('data', (data) => { stderr += data })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      child.stdin.end(JSON.stringify({ ...base, hook_event_name: 'sessionStart' }))
    })
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout).additional_context).toContain('agent --resume=conv-abcdefgh')
    expect(await transport.received()).toHaveLength(1)
  })

  it('keeps oversized/malformed native pre-tool input neutral without transport', async () => {
    const paths = await new AgentHookInstaller({ home: await home() }).install()
    const transport = await fakeTransport(join(paths.cursorBridgePath, '..'))
    const result = await run(paths.cursorBridgePath, { ...base, hook_event_name: 'preToolUse', tool_input: { content: 'x'.repeat(9 * 1024 * 1024) } }, transport.env, 'preToolUse')
    expect(result).toEqual({ code: 0, stdout: '{"permission":"allow"}\n', stderr: '' })
    expect(await transport.received()).toEqual([])
  })

  it('guards imported Cursor hooks even when the token and pane environment are absent', async () => {
    const paths = await new AgentHookInstaller({ home: await home() }).install()
    await rm(paths.tokenPath)
    const result = await run(paths.claudeBridgePath, { ...base, hook_event_name: 'PreToolUse', session_id: base.conversation_id })
    expect(result).toEqual({ code: 0, stdout: '{"permission":"allow"}\n', stderr: '' })
  })

  it.each(['preToolUse', 'subagentStart', 'beforeSubmitPrompt', 'stop'])('returns valid neutral %s output without credentials/daemon', async (event) => {
    const paths = await new AgentHookInstaller({ home: await home() }).install()
    await rm(paths.tokenPath)
    const result = await run(paths.cursorBridgePath, { ...base, hook_event_name: event, status: 'completed' }, {}, event)
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual(event === 'preToolUse' || event === 'subagentStart' ? { permission: 'allow' } : event === 'beforeSubmitPrompt' ? { continue: true } : {})
    const malformed = await run(paths.cursorBridgePath, '{', {}, event)
    expect(malformed.stdout).toBe(result.stdout)
  })

  it('fails open on unavailable transport without enabling followups or permissions', async () => {
    const paths = await new AgentHookInstaller({ home: await home() }).install()
    const transport = await fakeTransport(join(paths.cursorBridgePath, '..'), true)
    const result = await run(paths.cursorBridgePath, { ...base, hook_event_name: 'stop', status: 'error' }, transport.env, 'stop')
    expect(result).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
  })

  it.each(['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'stop', 'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'])('makes imported Claude %s hooks neutral before context or POST', async (event) => {
    const paths = await new AgentHookInstaller({ home: await home() }).install()
    const transport = await fakeTransport(join(paths.cursorBridgePath, '..'))
    const result = await run(paths.claudeBridgePath, { ...base, hook_event_name: event, session_id: base.conversation_id,
      tool_name: 'AskUserQuestion', request: { id: 'must-not-wait', kind: 'question' }, prompt: 'private prompt',
    }, transport.env)
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(await transport.received()).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual(event === 'preToolUse' || event === 'PreToolUse' ? { permission: 'allow' } :
      event === 'beforeSubmitPrompt' || event === 'UserPromptSubmit' ? { continue: true } : {})
  })

  it('preserves real Claude even with inherited Cursor config variables', async () => {
    const paths = await new AgentHookInstaller({ home: await home() }).install()
    const transport = await fakeTransport(join(paths.cursorBridgePath, '..'))
    const result = await run(paths.claudeBridgePath, { hook_event_name: 'SessionStart', session_id: 'claude-abcdefgh' }, {
      ...transport.env, CURSOR_CONFIG_DIR: '/unused', CURSOR_VERSION: 'inherited', CURSOR_PROJECT_DIR: '/unused',
    })
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('claude --resume claude-abcdefgh')
    expect((await transport.received())[0]).toMatchObject({ url: 'http://127.0.0.1:4319/api/agent-status/hooks/claude' })
  })
})

describe('Cursor metadata privacy and schema', () => {
  it('redacts summaries and never forwards raw commands, outputs, edits, thoughts, or transcript paths', () => {
    const value = normalizeCursorHook({ ...base, hook_event_name: 'afterAgentResponse', text: '🟢 Done token=supersecret\nprivate body',
      transcript_path: '/private', user_email: 'private', tool_output: 'private', edits: [{ new_string: 'private' }] })
    expect(value?.finalMessage).toBe('🟢 Done token=[REDACTED]')
    expect(JSON.stringify(value)).not.toMatch(/supersecret|private/)
    const key = normalizeCursorHook({ ...base, hook_event_name: 'afterAgentResponse', text: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----' })
    expect(key?.finalMessage).toBe('Cursor response received')
  })
  it('does not fabricate check success or tasks from unknown native tool contracts', () => {
    expect(normalizeCursorHook({ ...base, hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: { command: 'npm test' }, tool_output: 'not-json' })?.check).toBeUndefined()
    expect(normalizeCursorHook({ ...base, hook_event_name: 'postToolUse', tool_name: 'TodoWrite', tool_output: '{"todos":[]}' })?.tasks).toBeUndefined()
  })
  it.each([{ hook_event_name: 'afterAgentThought' }, { hook_event_name: 'stop', status: 'idle' }, { hook_event_name: 'preToolUse', generation_id: '' }, { hook_event_name: 'stop', status: 'completed', conversation_id: 'bad;id' }])('rejects unsupported/invalid events %j', (patch) => {
    expect(normalizeCursorHook({ ...base, ...patch })).toBeNull()
  })
})

describe('Cursor config installation and repair', () => {
  it('preserves unrelated hooks, fields, modes, and managed fields idempotently with quoted paths', async () => {
    const root = await home(); const installer = new AgentHookInstaller({ home: root })
    await mkdir(join(root, '.cursor'))
    await writeFile(installer.paths.cursorHooksPath, JSON.stringify({ version: 1, custom: true, hooks: {
      stop: [{ command: 'my-hook --commando-cursor-status-hook', timeout: 19 }], workspaceOpen: [{ command: 'other' }],
    } }))
    await chmod(installer.paths.cursorHooksPath, 0o640)
    await installer.install()
    const settings = JSON.parse(await readFile(installer.paths.cursorHooksPath, 'utf8'))
    settings.hooks.stop.at(-1).timeout = 21
    await writeFile(installer.paths.cursorHooksPath, JSON.stringify(settings))
    await installer.install(); const first = await readFile(installer.paths.cursorHooksPath, 'utf8')
    await installer.install(); expect(await readFile(installer.paths.cursorHooksPath, 'utf8')).toBe(first)
    const merged = JSON.parse(first)
    expect(merged).toMatchObject({ custom: true, hooks: { stop: [{ command: 'my-hook --commando-cursor-status-hook', timeout: 19 }, { timeout: 21 }], workspaceOpen: [{ command: 'other' }] } })
    for (const event of CURSOR_HOOK_EVENTS) expect(merged.hooks[event].filter((entry: { command: string }) => entry.command.startsWith('node '))).toHaveLength(1)
    expect((await stat(installer.paths.cursorHooksPath)).mode & 0o777).toBe(0o640)
    expect((await stat(installer.paths.cursorBridgePath)).mode & 0o777).toBe(0o600)
    expect(await installer.staleCursorBridgePaths()).toEqual([])
  })

  it.each(['{', '[]', '{"version":2}', '{"hooks":[]}', '{"hooks":{"stop":{}}}'])('leaves malformed/unsupported config unchanged: %s', async (content) => {
    const installer = new AgentHookInstaller({ home: await home() })
    await mkdir(join(installer.paths.cursorHooksPath, '..'))
    await writeFile(installer.paths.cursorHooksPath, content)
    await expect(installer.install()).rejects.toThrow()
    expect(await readFile(installer.paths.cursorHooksPath, 'utf8')).toBe(content)
    await expect(stat(installer.paths.claudeSettingsPath)).rejects.toThrow()
  })

  it('repairs only opted-in Cursor, and upgrades a healthy managed Claude bridge on explicit install', async () => {
    const installer = new AgentHookInstaller({ home: await home() })
    await installer.install()
    await writeFile(installer.paths.claudeBridgePath, '// old readable bridge')
    expect(await installer.repair()).toEqual({ repaired: false, staleBridgePaths: [] })
    await installer.install()
    expect(await readFile(installer.paths.claudeBridgePath, 'utf8')).toContain('isCursorInvocation')
    await rm(installer.paths.cursorBridgePath)
    expect(await installer.repair()).toEqual({ repaired: true, staleBridgePaths: [installer.paths.cursorBridgePath] })
    expect(await installer.staleCursorBridgePaths()).toEqual([])
    await rm(installer.paths.cursorHooksPath)
    await rm(installer.paths.cursorBridgePath)
    await rm(installer.paths.claudeBridgePath)
    await installer.repair()
    await expect(stat(installer.paths.cursorHooksPath)).rejects.toThrow()
    await expect(stat(installer.paths.cursorBridgePath)).rejects.toThrow()
  })

  it('uses the verified HOME hook path despite CLI config overrides', async () => {
    const root = await home()
    vi.stubEnv('HOME', root); vi.stubEnv('CURSOR_CONFIG_DIR', join(root, 'cli-config')); vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'))
    const installer = new AgentHookInstaller()
    expect(installer.paths.cursorHooksPath).toBe(join(root, '.cursor', 'hooks.json'))
    await installer.install()
    await expect(stat(join(root, 'cli-config', 'hooks.json'))).rejects.toThrow()
  })

  it('rejects symlinked directories, files, and explicit paths outside HOME', async () => {
    const root = await home(); const elsewhere = await home()
    await symlink(elsewhere, join(root, '.cursor'))
    await expect(new AgentHookInstaller({ home: root }).install()).rejects.toThrow('symbolic link')
    await expect(new AgentHookInstaller({ home: root, cursorHooksPath: join(elsewhere, 'hooks.json') }).install()).rejects.toThrow('inside the installer home')
    await rm(join(root, '.cursor')); await mkdir(join(root, '.cursor'))
    await writeFile(join(elsewhere, 'hooks.json'), '{}')
    await symlink(join(elsewhere, 'hooks.json'), join(root, '.cursor', 'hooks.json'))
    await expect(new AgentHookInstaller({ home: root }).install()).rejects.toThrow('symbolic link')
    expect(await readFile(join(elsewhere, 'hooks.json'), 'utf8')).toBe('{}')
  })
})

it('Cursor-only repair never opts Claude, Codex or OpenCode into hooks', async () => {
  const installer = new AgentHookInstaller({ home: await home() })
  const paths = await installer.install()
  for (const path of [paths.claudeSettingsPath, paths.claudeBridgePath, paths.codexConfigPath, paths.codexBridgePath, paths.openCodePluginPath, paths.cursorBridgePath]) await rm(path)
  expect(await installer.repair()).toEqual({ repaired: true, staleBridgePaths: [paths.cursorBridgePath] })
  for (const path of [paths.claudeSettingsPath, paths.claudeBridgePath, paths.codexConfigPath, paths.codexBridgePath, paths.openCodePluginPath]) await expect(stat(path)).rejects.toThrow()
  expect(await installer.staleCursorBridgePaths()).toEqual([])
})

it('Claude-only repair leaves unmanaged Cursor and OpenCode untouched', async () => {
  const installer = new AgentHookInstaller({ home: await home() })
  const paths = await installer.install()
  const settings = '{"version":1,"custom":true,"hooks":{"stop":[{"command":"my-hook"}]}}'
  await writeFile(paths.cursorHooksPath, settings)
  for (const path of [paths.claudeBridgePath, paths.cursorBridgePath, paths.openCodePluginPath]) await rm(path)
  await installer.repair()
  expect(await readFile(paths.cursorHooksPath, 'utf8')).toBe(settings)
  await expect(stat(paths.cursorBridgePath)).rejects.toThrow()
  await expect(stat(paths.openCodePluginPath)).rejects.toThrow()
})

it('repairs departed Cursor paths while preserving unrelated managed-entry fields', async () => {
  const installer = new AgentHookInstaller({ home: await home() })
  const paths = await installer.install()
  const settings = JSON.parse(await readFile(paths.cursorHooksPath, 'utf8'))
  settings.hooks.stop[0].command = settings.hooks.stop[0].command.replace('commando-cursor-agent-status.mjs', 'departed/commando-cursor-agent-status.mjs')
  settings.hooks.stop[0].timeout = 30
  await writeFile(paths.cursorHooksPath, JSON.stringify(settings))
  expect(await installer.repair()).toEqual({ repaired: true, staleBridgePaths: [join(paths.cursorBridgePath, '..', 'departed', 'commando-cursor-agent-status.mjs')] })
  expect(JSON.parse(await readFile(paths.cursorHooksPath, 'utf8')).hooks.stop[0].timeout).toBe(30)
  expect(await installer.staleCursorBridgePaths()).toEqual([])
})

it('preflights symlinked imported-Claude destinations before writing any provider config', async () => {
  const root = await home(); const elsewhere = await home()
  await symlink(elsewhere, join(root, '.claude'))
  const installer = new AgentHookInstaller({ home: root })
  await expect(installer.install()).rejects.toThrow('symbolic link')
  await expect(stat(installer.paths.cursorHooksPath)).rejects.toThrow()
  await expect(stat(join(elsewhere, 'settings.json'))).rejects.toThrow()
})

it('keeps the normalized wire envelope stable and redacts credential aliases', () => {
  const raw = { ...base, hook_event_name: 'postToolUse', tool_name: 'MCP:private-api', tool_use_id: 't1', tool_input: { password: 'secret' }, tool_output: 'private-output' }
  const wire = JSON.parse(JSON.stringify(normalizeCursorHook(raw)))
  expect(JSON.parse(JSON.stringify(normalizeCursorHook(wire)))).toEqual(wire)
  const secrets = ['multiword json secret', 'multiword environment secret', 'ASIA1234567890ABCDEF', 'eyJheader123.payload123.signature123', 'basic-secret']
  const summary = normalizeCursorHook({ ...base, hook_event_name: 'afterAgentResponse', text: '"token": "multiword json secret", AWS_SECRET_ACCESS_KEY=multiword environment secret, ASIA1234567890ABCDEF eyJheader123.payload123.signature123 Basic basic-secret' })
  for (const secret of secrets) expect(JSON.stringify(summary)).not.toContain(secret)
})

it('keeps global Cursor hooks neutral outside tmux and does not inject child context or unsafe resume IDs', async () => {
  const paths = await new AgentHookInstaller({ home: await home() }).install()
  const transport = await fakeTransport(join(paths.cursorBridgePath, '..'))
  const outside = await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart' }, { ...transport.env, TMUX_PANE: '' })
  expect(outside).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
  const child = await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart', parent_conversation_id: base.conversation_id, subagent_id: 'child-1' }, transport.env)
  expect(child.stdout).toBe('{}\n')
  const unsafe = await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart', conversation_id: 'bad;id' }, transport.env)
  expect(unsafe.stdout).toBe('{}\n')
  expect(JSON.stringify(await transport.received())).not.toContain('bad;id')
})

async function realTsxInstaller(runtime: 'CLI' | 'loader') {
  const directory = await home()
  const script = resolve('scripts/install-agent-hooks.ts')
  const args = runtime === 'CLI' ? [resolve('node_modules/tsx/dist/cli.mjs'), script] : ['--import', 'tsx', script]
  const installed = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, HOME: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (data) => { stdout += data }); child.stderr.on('data', (data) => { stderr += data })
    child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  expect(installed.code, installed.stderr).toBe(0)
  expect(installed.stdout).toContain('Cursor hooks:')
  const paths = new AgentHookInstaller({ home: directory }).paths
  const transport = await fakeTransport(join(paths.cursorBridgePath, '..'))
  const result = await run(paths.cursorBridgePath, { ...base, generation_id: base.conversation_id, hook_event_name: 'sessionStart' }, transport.env)
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(result.stdout).additional_context).toContain('agent --resume=conv-abcdefgh')
  expect(await transport.received()).toHaveLength(1)
  for (const event of ['preToolUse', 'postToolUse']) {
    const activity = await run(paths.cursorBridgePath, { ...base, hook_event_name: event,
      tool_name: 'Read', tool_use_id: 'opaque fixture ID/读 +=42' }, transport.env, event)
    expect(activity).toMatchObject({ code: 0, stderr: '' })
  }
  const requests = await transport.received()
  expect(requests).toHaveLength(3)
  expect(requests[1].body.activityId).toMatch(/^cursor-tool:[a-f0-9]{64}$/)
  expect(requests[2].body.activityId).toBe(requests[1].body.activityId)
  expect(JSON.stringify(requests)).not.toContain('opaque fixture ID')
  const imported = await run(paths.claudeBridgePath, { ...base, hook_event_name: 'SessionStart', session_id: base.conversation_id }, transport.env)
  expect(imported).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
  expect(await transport.received()).toHaveLength(3)
}

it('installs through the REAL root installed TSX CLI and executes standalone native/imported bridges', async () => {
  await realTsxInstaller('CLI')
})
it('installs through the installed TSX loader and executes standalone native/imported bridges', async () => {
  await realTsxInstaller('loader')
})

it.each([401, 404])('keeps session context neutral after a %s daemon response', async (status) => {
  const paths = await new AgentHookInstaller({ home: await home() }).install()
  const transport = await fakeTransport(join(paths.cursorBridgePath, '..'), status)
  expect((await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart' }, transport.env)).stdout).toBe('{}\n')
  expect(await transport.received()).toHaveLength(1)
})
it('requires credentials, port, native foreground association and accepted POST before session context', async () => {
  const paths = await new AgentHookInstaller({ home: await home() }).install()
  const transport = await fakeTransport(join(paths.cursorBridgePath, '..'))
  for (const env of [{ TMUX: '' }, { TMUX: '/fixture/cursor.sock,91,0' }, { TMUX_PANE: '' }, { COMMANDO_PORT: '65536' }, { COMMANDO_PORT: 'oops' }]) {
    expect((await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart' }, { ...transport.env, ...env })).stdout).toBe('{}\n')
  }
  for (const token of ['tiny', '']) {
    await writeFile(paths.tokenPath, token)
    expect((await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart' }, transport.env)).stdout).toBe('{}\n')
  }
  await rm(paths.tokenPath)
  expect((await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart' }, transport.env)).stdout).toBe('{}\n')
  expect(await transport.received()).toEqual([])
})
it('drops documented background agents and emits process identities without argv or contents', async () => {
  const paths = await new AgentHookInstaller({ home: await home() }).install()
  const transport = await fakeTransport(join(paths.cursorBridgePath, '..'))
  expect((await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart', is_background_agent: true }, transport.env)).stdout).toBe('{}\n')
  expect(await transport.received()).toEqual([])
  await run(paths.cursorBridgePath, { ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'Safe intent' }, transport.env, 'beforeSubmitPrompt')
  const received = await transport.received()
  expect(received[0].body).toMatchObject({ association: { version: 1, socketPath: '/fixture/cursor.sock', serverPid: 90, panePid: 100, producerPid: 100 }, emittedAt: expect.stringMatching(/^\d+$/) })
  expect(JSON.stringify(received[0].body)).not.toContain('index.js')
})
it('selects the final explicit recap marker and redacts it before emitting bounded metadata', () => {
  expect(normalizeCursorHook({ ...base, hook_event_name: 'afterAgentResponse', text: 'Intro\n🟢 Earlier summary\nmore narrative\n🔴 Need token=secret-value' })?.finalMessage).toBe('🔴 Need token=[REDACTED]')
})
it('repairs only existing owned Cursor event entries, leaving deliberately removed coverage absent', async () => {
  const installer = new AgentHookInstaller({ home: await home() }); const paths = await installer.install()
  const settings = JSON.parse(await readFile(paths.cursorHooksPath, 'utf8'))
  delete settings.hooks.stop
  settings.hooks.preToolUse = [{ command: 'user-only' }]
  await writeFile(paths.cursorHooksPath, JSON.stringify(settings)); await rm(paths.cursorBridgePath)
  expect((await installer.repair()).repaired).toBe(true)
  const repaired = JSON.parse(await readFile(paths.cursorHooksPath, 'utf8'))
  expect(repaired.hooks.stop).toBeUndefined()
  expect(repaired.hooks.preToolUse).toEqual([{ command: 'user-only' }])
  expect(repaired.hooks.sessionStart).toHaveLength(1)
  await installer.install()
  expect(JSON.parse(await readFile(paths.cursorHooksPath, 'utf8')).hooks.stop).toHaveLength(1)
})
it.each([['malformed', 'Claude'], ['symlink', 'Claude'], ['malformed', 'Codex'], ['symlink', 'Codex']])('isolates unrelated %s Cursor config from stale %s repair', async (damage, provider) => {
  const root = await home(); const installer = new AgentHookInstaller({ home: root }); const paths = await installer.install()
  const staleBridge = provider === 'Claude' ? paths.claudeBridgePath : paths.codexBridgePath
  await rm(staleBridge)
  await rm(paths.cursorHooksPath)
  const untouched = join(root, 'untouched-cursor.json')
  if (damage === 'symlink') { await writeFile(untouched, '{"user":true}'); await symlink(untouched, paths.cursorHooksPath) }
  else await writeFile(paths.cursorHooksPath, '{broken')
  const result = await installer.repair()
  expect(result).toMatchObject({ repaired: true, staleBridgePaths: [staleBridge], warnings: [expect.stringContaining('Cursor:')] })
  expect((await stat(staleBridge)).isFile()).toBe(true)
  expect(await readFile(paths.cursorHooksPath, 'utf8')).toBe(damage === 'symlink' ? '{"user":true}' : '{broken')
})
it('reports damaged opted-in Cursor config without opting other providers in', async () => {
  const root = await home(); const installer = new AgentHookInstaller({ home: root })
  await mkdir(join(root, '.cursor'), { recursive: true })
  await writeFile(installer.paths.cursorHooksPath, '{"version":1,"hooks":{"stop":[{"command":"node \'/departed/bridge.mjs\' --commando-cursor-status-hook stop"}],"preToolUse":"broken"}}')
  const result = await installer.repair()
  expect(result).toMatchObject({ repaired: false, warnings: [expect.stringContaining('Cursor:')] })
  await expect(stat(installer.paths.claudeSettingsPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(installer.paths.codexConfigPath)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('does not select a recap marker from omitted fenced contents', () => {
  expect(normalizeCursorHook({ ...base, hook_event_name: 'afterAgentResponse', text: 'Safe summary\n```\n🔴 private file content\n```' })?.finalMessage).toBe('Safe summary')
})
it('keeps session context neutral on failed transport or an unaccepted 200 POST', async () => {
  const paths = await new AgentHookInstaller({ home: await home() }).install()
  const transport = await fakeTransport(join(paths.cursorBridgePath, '..'), true)
  expect((await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart' }, transport.env)).stdout).toBe('{}\n')
  const unaccepted = await fakeTransport(join(paths.cursorBridgePath, '..'))
  await writeFile(unaccepted.env.COMMANDO_TEST_TRANSPORT, (await readFile(unaccepted.env.COMMANDO_TEST_TRANSPORT, 'utf8')).replace('accepted: true', 'accepted: false'))
  expect((await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart' }, unaccepted.env)).stdout).toBe('{}\n')
  expect(await transport.received()).toHaveLength(2)
})

it.each(['tool/ID +=读', 'tool id\nwith control', 'token=fixture-private-id', 0, 42])('hashes bounded opaque native tool IDs without leaking raw values: %j', (id) => {
  const pre = normalizeCursorHook({ ...base, hook_event_name: 'preToolUse', tool_name: 'Read', tool_use_id: id })!
  const post = normalizeCursorHook({ ...base, hook_event_name: 'postToolUse', tool_name: 'Read', tool_use_id: id })!
  expect(pre.activityId).toMatch(/^cursor-tool:[a-f0-9]{64}$/)
  expect(post.activityId).toBe(pre.activityId)
  expect(normalizeCursorHook(pre)?.activityId).toBe(pre.activityId)
  if (typeof id === 'string') expect(JSON.stringify(pre)).not.toContain(id)
})
it('rejects uncharacterized structured/oversized activity IDs rather than truncating them into collisions', () => {
  for (const id of ['', 'x'.repeat(1025), '读'.repeat(350), {}, [], true, null, 0.5, Number.NaN]) expect(sanitizeCursorActivityId(id)).toBeUndefined()
  expect(sanitizeCursorActivityId(42)).not.toBe(sanitizeCursorActivityId('42'))
  expect(sanitizeCursorActivityId('\ud800')).not.toBe(sanitizeCursorActivityId('\ud801'))
})
it('keeps the generated hook alive for verification slower than the former one-second request lifetime', async () => {
  const paths = await new AgentHookInstaller({ home: await home() }).install()
  const transport = await fakeTransport(join(paths.cursorBridgePath, '..'))
  const preload = await readFile(transport.env.COMMANDO_TEST_TRANSPORT, 'utf8')
  await writeFile(transport.env.COMMANDO_TEST_TRANSPORT, preload.replace('return { ok: true, status: 200', "await new Promise((resolve) => setTimeout(resolve, 1200)); options.signal.throwIfAborted(); await appendFile(process.env.COMMANDO_TEST_REQUESTS + '.accepted', JSON.stringify(JSON.parse(options.body)) + '\\n'); return { ok: true, status: 200"))
  const started = await run(paths.cursorBridgePath, { ...base, hook_event_name: 'sessionStart' }, transport.env)
  expect(JSON.parse(started.stdout).additional_context).toContain('agent --resume=conv-abcdefgh')
  await run(paths.cursorBridgePath, { ...base, hook_event_name: 'stop', status: 'completed' }, transport.env, 'stop')
  expect(await transport.received()).toHaveLength(2)
  const generated = await readFile(paths.cursorBridgePath, 'utf8')
  expect(generated).toContain('AbortSignal.timeout(3000)')
  const accepted = (await readFile(transport.env.COMMANDO_TEST_REQUESTS + '.accepted', 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  expect(accepted.map((body) => body.hook_event_name)).toEqual(['sessionStart', 'stop'])
})

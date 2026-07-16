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
    expect(openCodePlugin).toContain('/api/agent-status/hooks/opencode')
    expect(openCodePlugin).toContain('const payload = { type: event.type, properties }')
    for (const event of OPENCODE_HOOK_EVENTS) expect(openCodePlugin).toContain(event)
    expect(claudeBridge).not.toContain(token)
    expect(openCodePlugin).not.toContain(token)
    expect((await stat(paths.claudeBridgePath)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.openCodePluginPath)).mode & 0o777).toBe(0o600)
  })

  it('forwards Claude stdin through the installed bridge', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const token = (await readFile(paths.tokenPath, 'utf8')).trim()
    let resolveRequest!: (request: { authorization: string | undefined; body: unknown; pane: string | undefined }) => void
    const received = new Promise<{ authorization: string | undefined; body: unknown; pane: string | undefined }>((resolve) => {
      resolveRequest = resolve
    })
    const server = createServer((request, response) => {
      void (async () => {
        let body = ''
        for await (const chunk of request) body += chunk
        resolveRequest({
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
      const child = spawn(process.execPath, [paths.claudeBridgePath], {
        env: { ...process.env, COMMANDO_PORT: String(address.port), TMUX_PANE: '%42' },
        stdio: ['pipe', 'ignore', 'inherit'],
      })
      child.stdin.end(JSON.stringify({
        hook_event_name: 'PermissionRequest',
        notification_type: 'private detail',
        prompt: 'must not be forwarded',
        session_id: 'claude-session',
      }))
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Bridge exited ${code}`)))
      })

      await expect(received).resolves.toEqual({
        authorization: `Bearer ${token}`,
        body: {
          hook_event_name: 'PermissionRequest',
          notification_type: 'private detail',
          session_id: 'claude-session',
        },
        pane: '%42',
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('forwards only the active OpenCode session', async () => {
    const home = await temporaryHome()
    const paths = await new AgentHookInstaller({ home }).install()
    const requests: Array<{ event: { type: string; properties: { sessionID?: string } } }> = []
    vi.stubEnv('TMUX_PANE', '%42')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      if (request.event.properties.status?.type === 'busy') {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      requests.push(request)
      return new Response(null, { status: 200 })
    }))
    const source = await readFile(paths.openCodePluginPath, 'utf8')
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as {
      CommandoAgentStatusPlugin: (context: { directory: string }) => Promise<{
        event: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void> | undefined
      }>
    }
    const plugin = await module.CommandoAgentStatusPlugin({ directory: '/workspace' })
    const send = (type: string, sessionID: string, properties: Record<string, unknown> = {}) =>
      plugin.event({ event: { type, properties: { sessionID, ...properties } } })

    const deliveries = [
      send('session.status', 'main', { status: { type: 'busy' } }),
      send('session.status', 'child', { status: { type: 'busy' } }),
      send('session.idle', 'child'),
      send('session.idle', 'main'),
      send('session.status', 'next', { status: { type: 'busy' } }),
    ].filter((delivery): delivery is Promise<void> => delivery !== undefined)
    await Promise.all(deliveries)

    expect(requests.map(({ event }) => [event.type, event.properties.sessionID])).toEqual([
      ['session.status', 'main'],
      ['session.idle', 'main'],
      ['session.status', 'next'],
    ])
  })
})

import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addClaudeProfile, AgentLoginProber, AgentProfilePreferences, claudeLoginCommand, handleAgentProfilesApi } from './agent-profiles.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

/** A home folder holding `.claude`, `.claudew` and `.claudep` profiles. */
async function home(names = ['', 'w', 'p']) {
  const dir = await mkdtemp(join(tmpdir(), 'commando-profiles-'))
  dirs.push(dir)
  for (const name of names) {
    await mkdir(join(dir, `.claude${name}`, 'projects'), { recursive: true })
    await writeFile(join(dir, `.claude${name}`, 'settings.json'), '{}')
  }
  return dir
}
const preferences = (dir: string) => new AgentProfilePreferences(join(dir, '.commando', 'agent-profiles.json'), dir)

describe('AgentProfilePreferences', () => {
  it('labels, defaults and hides discovered profiles, and pickers leave hidden ones out', async () => {
    const dir = await home(), prefs = preferences(dir)
    await prefs.update({ configDir: join(dir, '.claudew'), label: ' Work ', isDefault: true })
    await prefs.update({ configDir: join(dir, '.claude'), hidden: true })
    const all = await new AgentProfilePreferences(prefs.path, dir).claudeProfiles({ includeHidden: true })
    expect(all.map(({ name, label, isDefault, hidden }) => ({ name, label, isDefault, hidden }))).toEqual([
      { name: 'claude', label: undefined, isDefault: undefined, hidden: true },
      { name: 'claudep', label: undefined, isDefault: undefined, hidden: false },
      { name: 'claudew', label: 'Work', isDefault: true, hidden: false },
    ])
    expect((await prefs.claudeProfiles({ includeHidden: false })).map(({ name }) => name)).toEqual(['claudep', 'claudew'])
    expect((await stat(prefs.path)).mode & 0o777).toBe(0o600)

    await prefs.update({ configDir: join(dir, '.claudew'), label: null, isDefault: false })
    await prefs.update({ configDir: join(dir, '.claude'), hidden: false })
    expect(JSON.parse(await readFile(prefs.path, 'utf8'))).toEqual({ claude: { [join(dir, '.claudew')]: {}, [join(dir, '.claude')]: {} } })
  })

  it('rejects unknown profiles, bad labels, hiding the default, and hiding every profile', async () => {
    const dir = await home(['w', 'p']), prefs = preferences(dir)
    await expect(prefs.update({ configDir: join(dir, '.claudex'), label: 'X' })).rejects.toThrow('Unknown Claude profile')
    await expect(prefs.update({ configDir: join(dir, '.claudew'), label: '  ' })).rejects.toThrow('label must be')
    await prefs.update({ configDir: join(dir, '.claudew'), isDefault: true })
    await expect(prefs.update({ configDir: join(dir, '.claudew'), hidden: true })).rejects.toThrow('default profile cannot be hidden')
    await prefs.update({ configDir: join(dir, '.claudep'), hidden: true })
    await prefs.update({ configDir: join(dir, '.claudew'), isDefault: false })
    await expect(prefs.update({ configDir: join(dir, '.claudew'), hidden: true })).rejects.toThrow('At least one profile')
  })

  it('treats a corrupt file as empty and drops entries for folders that are not profiles', async () => {
    const dir = await home(['w']), prefs = preferences(dir)
    await mkdir(join(dir, '.commando'))
    await writeFile(prefs.path, '{not json')
    expect((await prefs.claudeProfiles({ includeHidden: false })).map(({ name }) => name)).toEqual(['claudew'])
    await writeFile(prefs.path, JSON.stringify({ claude: { '/etc': { label: 'Root' }, [join(dir, '.claudew')]: { label: 'W', hidden: 'yes' } }, defaultClaudeConfigDir: '/etc' }))
    expect(await prefs.claudeProfiles({ includeHidden: true })).toEqual([expect.objectContaining({ name: 'claudew', label: 'W', hidden: false })])
  })
})

describe('addClaudeProfile', () => {
  it('creates an empty profile folder that discovery lists, and refuses an existing one or a bad name', async () => {
    const dir = await home([])
    expect(await addClaudeProfile('y', dir)).toBe(join(dir, '.claudey'))
    expect(await readFile(join(dir, '.claudey', 'settings.json'), 'utf8')).toBe('{}\n')
    expect((await stat(join(dir, '.claudey', 'projects'))).isDirectory()).toBe(true)
    expect((await preferences(dir).claudeProfiles({ includeHidden: true })).map(({ name }) => name)).toEqual(['claudey'])
    await expect(addClaudeProfile('y', dir)).rejects.toMatchObject({ status: 409 })
    await expect(addClaudeProfile('', dir)).rejects.toThrow('Profile name')
    await expect(addClaudeProfile('../x', dir)).rejects.toThrow('Profile name')
  })
})

it('logs in with the profile set and inherited credentials cleared, then leaves a shell', () => {
  expect(claudeLoginCommand("/opt/it's/claude", '/home/u/.claudew')).toBe(
    "export CLAUDE_CONFIG_DIR=/home/u/.claudew; unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; '/opt/it'\"'\"'s/claude' auth login; "
    + "printf '\\n[commando] Login finished. Close this session when you are done.\\n'; exec \"${SHELL:-/bin/sh}\" -l")
})

describe('AgentLoginProber', () => {
  const statuses = {
    '/h/.claudew': { loggedIn: true, email: 'leo@work.test', orgName: 'Gizmo', subscriptionType: 'team' },
    '/h/.claude': { loggedIn: false },
  } as Record<string, unknown>
  const prober = (overrides: Partial<ConstructorParameters<typeof AgentLoginProber>[0]> = {}) => {
    const exec = vi.fn(async (file: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      if (file.endsWith('claude')) {
        const status = statuses[options.env.CLAUDE_CONFIG_DIR ?? '']
        return { stdout: status ? JSON.stringify(status) : 'Error: keychain locked', exitCode: status ? 0 : 1 }
      }
      if (file.endsWith('codex')) return { stdout: '', stderr: 'Logged in using ChatGPT\n', exitCode: 0 }
      if (file.endsWith('agent')) return { stdout: JSON.stringify({ isAuthenticated: true, userInfo: { email: 'leo@cursor.test' } }), exitCode: 0 }
      return { stdout: '\u001b[0m┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n', exitCode: 0 }
    })
    const resolveExecutable = vi.fn(async (command: string) => {
      if (command === 'cursor-agent') throw new Error('missing')
      return `/bin/${command}`
    })
    return { exec, resolveExecutable, prober: new AgentLoginProber({ exec, resolveExecutable, home: '/h', env: { PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/elsewhere' }, ...overrides }) }
  }

  it("reads each profile's own login, without inherited keys, and caches it until refreshed or invalidated", async () => {
    const { exec, prober: probe } = prober()
    expect(await probe.claude('/h/.claudew')).toEqual({ state: 'logged-in', email: 'leo@work.test', orgName: 'Gizmo', subscriptionType: 'team' })
    expect(await probe.claude('/h/.claude')).toEqual({ state: 'logged-out' })
    expect(await probe.claude('/h/.claudep')).toEqual({ state: 'unknown', error: 'Error: keychain locked' })
    const env = exec.mock.calls[0]![2].env
    expect(exec.mock.calls[0]!.slice(0, 2)).toEqual(['/bin/claude', ['auth', 'status', '--json']])
    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: '/h/.claudew', PATH: '/bin' })
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')

    await Promise.all([probe.claude('/h/.claudew'), probe.claude('/h/.claudew')])
    expect(exec).toHaveBeenCalledTimes(3)
    await probe.claude('/h/.claudew', true)
    expect(exec).toHaveBeenCalledTimes(4)
    probe.invalidate('claude:/h/.claudew')
    await probe.claude('/h/.claudew')
    expect(exec).toHaveBeenCalledTimes(5)
  })

  it('shares an in-flight check and retries a failed one sooner', async () => {
    let now = 0
    const { exec, prober: probe } = prober({ now: () => now })
    await Promise.all([probe.claude('/h/.claudep'), probe.claude('/h/.claudep')])
    expect(exec).toHaveBeenCalledTimes(1)
    now = 31_000
    await probe.claude('/h/.claudep')
    expect(exec).toHaveBeenCalledTimes(2)
    await probe.claude('/h/.claudew')
    now += 60_000
    await probe.claude('/h/.claudew')
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('lists the other agents read-only from their own status commands', async () => {
    const { prober: probe } = prober()
    expect(await probe.others()).toEqual([
      { provider: 'codex', label: 'Codex', configDir: '/h/.codex', installed: true, state: 'logged-in', detail: 'Logged in using ChatGPT' },
      { provider: 'cursor', label: 'Cursor', configDir: '/h/.cursor', installed: true, state: 'logged-in', detail: 'Logged in as leo@cursor.test' },
      { provider: 'opencode', label: 'OpenCode', configDir: '/h/.config/opencode', installed: true, state: 'logged-out', detail: 'Credentials ~/.local/share/opencode/auth.json · 0 credentials' },
    ])
    const { prober: missing } = prober({ resolveExecutable: async () => { throw new Error('missing') } })
    expect((await missing.others()).map(({ installed, state }) => ({ installed, state }))).toEqual(Array(3).fill({ installed: false, state: 'unknown' }))
  })
})

describe('handleAgentProfilesApi', () => {
  async function api() {
    const dir = await home(['w', 'p'])
    const prefs = preferences(dir)
    const createSession = vi.fn(async () => ({ created: { sessionId: '$9', windowId: '@9', paneId: '%9', targetId: 't' } }))
    const prober = { claude: vi.fn(async () => ({ state: 'logged-in' as const })), others: vi.fn(async () => []), invalidate: vi.fn() }
    const refreshSnapshot = vi.fn(async () => {})
    const deps = { preferences: prefs, prober: prober as unknown as AgentLoginProber, creator: { createSession } as never, sessionNames: () => ['claude-login-claudew'], refreshSnapshot, home: dir, resolveClaude: async () => '/bin/claude' }
    const call = async (method: string, path: string, body?: unknown) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage
      req.method = method
      req.headers = { 'content-type': 'application/json' }
      const res = new EventEmitter() as ServerResponse
      let code = 0, result: any
      res.setHeader = vi.fn() as never
      res.writeHead = ((status: number) => { code = status; return res }) as never
      res.end = ((value: string) => { result = JSON.parse(value); return res }) as never
      const handled = await handleAgentProfilesApi(req, res, new URL(`http://localhost${path}`), deps)
      return handled ? { code, result } : undefined
    }
    return { dir, call, createSession, prober, refreshSnapshot }
  }

  it('lists every profile with its status, and saves labels, the default and hiding', async () => {
    const { dir, call } = await api()
    const listed = await call('GET', '/api/agent-profiles?refresh=1')
    expect(listed?.code).toBe(200)
    expect(listed?.result.claude).toEqual([
      expect.objectContaining({ name: 'claudep', hidden: false, status: { state: 'logged-in' } }),
      expect.objectContaining({ name: 'claudew', hidden: false, status: { state: 'logged-in' } }),
    ])
    expect(await call('PUT', '/api/agent-profiles/claude/preferences', { configDir: join(dir, '.claudew'), label: 'Work', isDefault: true })).toEqual({ code: 200, result: { ok: true } })
    expect((await call('GET', '/api/agent-profiles'))?.result.claude[1]).toMatchObject({ label: 'Work', isDefault: true })
    expect((await call('PUT', '/api/agent-profiles/claude/preferences', { configDir: join(dir, '.claudew'), hidden: 'yes' }))?.code).toBe(400)
    expect((await call('POST', '/api/agent-profiles'))?.code).toBe(405)
    expect(await call('GET', '/api/agent-profiles/unknown')).toBeUndefined()
  })

  it('adds a labelled profile and refuses one that exists', async () => {
    const { dir, call } = await api()
    expect(await call('POST', '/api/agent-profiles/claude', { name: 'y', label: 'Spare' })).toEqual({ code: 201, result: { configDir: join(dir, '.claudey') } })
    expect((await call('GET', '/api/agent-profiles'))?.result.claude.map((profile: { label?: string; name: string }) => profile.label ?? profile.name)).toEqual(['claudep', 'claudew', 'Spare'])
    expect((await call('POST', '/api/agent-profiles/claude', { name: 'y' }))?.code).toBe(409)
  })

  it('opens a login session for a known profile under a free name and forgets its cached status', async () => {
    const { dir, call, createSession, prober, refreshSnapshot } = await api()
    expect((await call('POST', '/api/agent-profiles/claude/login', { configDir: join(dir, '.claudew') }))?.code).toBe(201)
    expect(createSession).toHaveBeenCalledWith({ name: 'claude-login-claudew-2', cwd: dir }, claudeLoginCommand('/bin/claude', join(dir, '.claudew')))
    expect(prober.invalidate).toHaveBeenCalledWith(`claude:${join(dir, '.claudew')}`)
    expect(refreshSnapshot).toHaveBeenCalled()
    expect((await call('POST', '/api/agent-profiles/claude/login', { configDir: '/etc' }))?.result).toEqual({ error: 'Unknown Claude profile' })
  })
})

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import {
  AGENT_PROFILE_ROUTES, CLAUDE_PROFILE_NAME,
  type AgentProfilesResponse, type ClaudeLoginStatus, type ClaudeProfilePreferenceChange, type ClaudeProfileSettings, type OtherAgentProfile,
} from '../shared/agent-profiles.js'
import type { ClaudeProfile, TmuxCreateResponse } from '../shared/tmux-create.js'
import { shellQuote } from './agent-resume-command.js'
import { listClaudeProfiles, resolveAgentExecutable, validClaudeConfigDir, type TmuxCreator } from './tmux-create.js'

export function defaultAgentProfilesPath(): string {
  return process.env.COMMANDO_AGENT_PROFILES_PATH ?? join(homedir(), '.commando', 'agent-profiles.json')
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u
const MAX_LABEL = 64

type StoredPreferences = { claude: Record<string, { label?: string; hidden?: boolean }>; defaultClaudeConfigDir?: string }

export function validLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : ''
  if (!label || label.length > MAX_LABEL || CONTROL_CHARACTER.test(label)) throw new Error(`label must be 1-${MAX_LABEL} characters without control characters`)
  return label
}

/** Labels, the default, and hidden flags for Claude profiles, chosen in Settings. */
export class AgentProfilePreferences {
  private writes: Promise<void> = Promise.resolve()
  constructor(
    readonly path = defaultAgentProfilesPath(),
    private readonly home = homedir(),
    private readonly discover: (home: string) => Promise<ClaudeProfile[]> = listClaudeProfiles,
  ) {}

  private async read(): Promise<StoredPreferences> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      const stored = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      const claude: StoredPreferences['claude'] = {}
      const entries = stored.claude && typeof stored.claude === 'object' && !Array.isArray(stored.claude) ? Object.entries(stored.claude) : []
      for (const [configDir, entry] of entries) {
        if (!validClaudeConfigDir(configDir, this.home) || !entry || typeof entry !== 'object') continue
        const { label, hidden } = entry as { label?: unknown; hidden?: unknown }
        let kept: { label?: string; hidden?: boolean } = {}
        try { if (label !== undefined) kept = { label: validLabel(label) } } catch { /* A bad label is dropped. */ }
        if (hidden === true) kept.hidden = true
        claude[configDir] = kept
      }
      const fallback = stored.defaultClaudeConfigDir
      return { claude, ...(typeof fallback === 'string' && validClaudeConfigDir(fallback, this.home) ? { defaultClaudeConfigDir: fallback } : {}) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return { claude: {} }
      throw error
    }
  }

  /** Discovered profiles with their Settings applied; pickers leave hidden ones out. */
  async claudeProfiles({ includeHidden }: { includeHidden: boolean }): Promise<Array<ClaudeProfile & { hidden: boolean }>> {
    await this.writes
    const [found, stored] = await Promise.all([this.discover(this.home), this.read()])
    return found.flatMap((profile) => {
      const entry = stored.claude[profile.configDir] ?? {}
      const hidden = entry.hidden === true
      if (hidden && !includeHidden) return []
      return [{
        ...profile,
        ...(entry.label ? { label: entry.label } : {}),
        ...(stored.defaultClaudeConfigDir === profile.configDir ? { isDefault: true } : {}),
        hidden,
      }]
    })
  }

  update(change: ClaudeProfilePreferenceChange): Promise<void> {
    const write = this.writes.then(async () => {
      const profiles = await this.discover(this.home)
      if (!profiles.some((profile) => profile.configDir === change.configDir)) throw new Error('Unknown Claude profile')
      const stored = await this.read()
      const entry = { ...stored.claude[change.configDir] }
      if (change.label === null) delete entry.label
      else if (change.label !== undefined) entry.label = validLabel(change.label)
      if (change.hidden === true) entry.hidden = true
      else if (change.hidden === false) delete entry.hidden
      if (change.isDefault === true) stored.defaultClaudeConfigDir = change.configDir
      else if (change.isDefault === false && stored.defaultClaudeConfigDir === change.configDir) delete stored.defaultClaudeConfigDir
      stored.claude[change.configDir] = entry
      if (entry.hidden && stored.defaultClaudeConfigDir === change.configDir) throw new Error('The default profile cannot be hidden')
      if (profiles.every((profile) => stored.claude[profile.configDir]?.hidden)) throw new Error('At least one profile must stay in the pickers')
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.path)
      } finally { await rm(temporary, { force: true }) }
    })
    this.writes = write.catch(() => {})
    return write
  }
}

/** A new, empty profile folder (`~/.claude<name>`), which discovery then lists. */
export async function addClaudeProfile(name: string, home = homedir()): Promise<string> {
  if (!CLAUDE_PROFILE_NAME.test(name)) throw new Error('Profile name must be 1-32 letters, digits, - or _')
  const configDir = join(home, `.claude${name}`)
  if (!validClaudeConfigDir(configDir, home)) throw new Error('Profile folder must be a ~/.claude… folder')
  try { await mkdir(configDir, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Object.assign(new Error(`${configDir} already exists`), { status: 409 })
    throw error
  }
  await writeFile(join(configDir, 'settings.json'), '{}\n', { mode: 0o600, flag: 'wx' })
  await mkdir(join(configDir, 'projects'), { mode: 0o700 })
  return configDir
}

/**
 * Runs `claude auth login` for one profile in a terminal, then leaves a shell open.
 * CLAUDE_CONFIG_DIR is always set, as chats launched on the profile set it, so the login
 * lands in the same Keychain item they read.
 */
export function claudeLoginCommand(claude: string, configDir: string): string {
  return [
    `export CLAUDE_CONFIG_DIR=${shellQuote(configDir)}`,
    'unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN',
    `${shellQuote(claude)} auth login`,
    "printf '\\n[commando] Login finished. Close this session when you are done.\\n'",
    'exec "${SHELL:-/bin/sh}" -l',
  ].join('; ')
}

type Exec = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<{ stdout: string; stderr?: string; exitCode: number }>

const defaultExec: Exec = (file, args, options) => new Promise((done) => {
  execFile(file, args, { ...options, maxBuffer: 64 * 1024, shell: false }, (error, stdout, stderr) => {
    // A non-zero exit still reports its status on stdout.
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0
    done({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: code })
  })
})

const STATUS_TIMEOUT_MS = 10_000
const LOGGED_IN_TTL_MS = 5 * 60_000
const FAILED_TTL_MS = 30_000
const MAX_CONCURRENT_PROBES = 3

function detail(output: string): string {
  return stripVTControlCharacters(output).split('\n').map((line) => line.replace(/^[\s│┌└●◇◆]+/u, '').trim()).filter(Boolean).join(' · ').slice(0, 300)
}

/**
 * Asks each agent CLI whether it is logged in. Every Claude probe starts Node, so results
 * are cached, shared while in flight, and at most three run at once.
 */
export class AgentLoginProber {
  private readonly cache = new Map<string, { at: number; ttl: number; result: Promise<unknown> }>()
  private running = 0
  private readonly queue: Array<() => void> = []
  constructor(
    private readonly options: {
      exec?: Exec
      resolveExecutable?: (command: string) => Promise<string>
      env?: NodeJS.ProcessEnv
      home?: string
      now?: () => number
    } = {},
  ) {}

  private get env(): NodeJS.ProcessEnv { return this.options.env ?? process.env }
  private get home(): string { return this.options.home ?? homedir() }
  private now(): number { return (this.options.now ?? Date.now)() }

  invalidate(key?: string): void {
    if (key === undefined) this.cache.clear()
    else this.cache.delete(key)
  }

  private async limited<T>(task: () => Promise<T>): Promise<T> {
    while (this.running >= MAX_CONCURRENT_PROBES) await new Promise<void>((ready) => this.queue.push(ready))
    this.running += 1
    try { return await task() } finally {
      this.running -= 1
      this.queue.shift()?.()
    }
  }

  private cached<T>(key: string, refresh: boolean, probe: () => Promise<T>, ok: (result: T) => boolean): Promise<T> {
    const entry = this.cache.get(key)
    if (!refresh && entry && this.now() - entry.at < entry.ttl) return entry.result as Promise<T>
    const result = this.limited(probe)
    const stored = { at: this.now(), ttl: LOGGED_IN_TTL_MS, result }
    this.cache.set(key, stored)
    // Only a login is kept long: a logged-out or failed answer is asked again soon, so a fresh login shows.
    void result.then((value) => { stored.ttl = ok(value) ? LOGGED_IN_TTL_MS : FAILED_TTL_MS }, () => { stored.ttl = 0 })
    return result
  }

  private resolve(command: string): Promise<string> {
    return (this.options.resolveExecutable ?? ((name) => resolveAgentExecutable(name, this.env)))(command)
  }

  private run(file: string, args: readonly string[], env: NodeJS.ProcessEnv) {
    return (this.options.exec ?? defaultExec)(file, args, { env, timeout: STATUS_TIMEOUT_MS })
  }

  claude(configDir: string, refresh = false): Promise<ClaudeLoginStatus> {
    return this.cached(`claude:${configDir}`, refresh, async () => {
      let claude: string
      try { claude = await this.resolve('claude') } catch (error) { return { state: 'unknown', error: (error as Error).message } }
      // The profile's own login, not a key or token the daemon happens to inherit.
      const { ANTHROPIC_API_KEY: _key, CLAUDE_CODE_OAUTH_TOKEN: _token, ...env } = this.env
      const { stdout } = await this.run(claude, ['auth', 'status', '--json'], { ...env, CLAUDE_CONFIG_DIR: configDir })
      try {
        const value = JSON.parse(stdout) as { loggedIn?: unknown; email?: unknown; orgName?: unknown; subscriptionType?: unknown }
        if (typeof value.loggedIn !== 'boolean') throw new Error('missing loggedIn')
        return {
          state: value.loggedIn ? 'logged-in' : 'logged-out',
          ...(typeof value.email === 'string' ? { email: value.email } : {}),
          ...(typeof value.orgName === 'string' ? { orgName: value.orgName } : {}),
          ...(typeof value.subscriptionType === 'string' ? { subscriptionType: value.subscriptionType } : {}),
        }
      } catch {
        return { state: 'unknown', error: detail(stdout) || 'claude auth status gave no answer' }
      }
    }, (status) => status.state === 'logged-in')
  }

  others(refresh = false): Promise<OtherAgentProfile[]> {
    const xdg = this.env.XDG_CONFIG_HOME ?? join(this.home, '.config')
    const agents: Array<{ provider: OtherAgentProfile['provider']; label: string; configDir: string; commands: string[]; args: string[]; parse: (stdout: string, exitCode: number) => OtherAgentProfile['state'] }> = [
      {
        provider: 'codex', label: 'Codex', configDir: this.env.CODEX_HOME ?? resolve(this.home, '.codex'),
        commands: ['codex'], args: ['login', 'status'],
        // A timeout or crash (no exit code) says nothing about the login.
        parse: (stdout, exitCode) => exitCode < 0 ? 'unknown' : /not logged in/iu.test(stdout) || exitCode !== 0 ? 'logged-out' : /logged in/iu.test(stdout) ? 'logged-in' : 'unknown',
      },
      {
        provider: 'cursor', label: 'Cursor', configDir: join(this.home, '.cursor'),
        commands: ['agent', 'cursor-agent'], args: ['status', '--format', 'json'],
        parse: (stdout) => {
          try { return (JSON.parse(stdout) as { isAuthenticated?: unknown }).isAuthenticated === true ? 'logged-in' : 'logged-out' } catch { return 'unknown' }
        },
      },
      {
        provider: 'opencode', label: 'OpenCode', configDir: join(xdg, 'opencode'),
        commands: ['opencode'], args: ['auth', 'list'],
        parse: (stdout) => {
          const count = /(\d+)\s+credentials?/iu.exec(stripVTControlCharacters(stdout))?.[1]
          return count === undefined ? 'unknown' : Number(count) > 0 ? 'logged-in' : 'logged-out'
        },
      },
    ]
    return Promise.all(agents.map((agent) => this.cached(`other:${agent.provider}`, refresh, async (): Promise<OtherAgentProfile> => {
      const base = { provider: agent.provider, label: agent.label, configDir: agent.configDir }
      let executable: string | undefined
      for (const command of agent.commands) {
        try { executable = await this.resolve(command); break } catch { /* Try the next name. */ }
      }
      if (!executable) return { ...base, installed: false, state: 'unknown', detail: 'Not installed on the daemon PATH' }
      const result = await this.run(executable, agent.args, this.env)
      // Codex reports its login on stderr.
      const output = agent.provider === 'cursor' ? result.stdout : [result.stdout, result.stderr ?? ''].join('\n')
      const state = agent.parse(output, result.exitCode)
      const text = agent.provider === 'cursor' ? cursorDetail(output) : detail(output)
      return { ...base, installed: true, state, detail: text || (state === 'unknown' ? 'No status reported' : '') }
    }, (result) => result.state === 'logged-in')))
  }
}

function cursorDetail(stdout: string): string {
  try {
    const value = JSON.parse(stdout) as { isAuthenticated?: unknown; userInfo?: { email?: unknown } }
    const email = typeof value.userInfo?.email === 'string' ? value.userInfo.email : undefined
    return value.isAuthenticated === true ? `Logged in${email ? ` as ${email}` : ''}` : 'Not logged in'
  } catch { return detail(stdout) }
}

const MAX_BODY_BYTES = 16 * 1024

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') throw new Error('Content-Type must be application/json')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Request body is not valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object')
  return value as Record<string, unknown>
}

export type AgentProfilesApiDependencies = {
  preferences: AgentProfilePreferences
  prober: AgentLoginProber
  creator: Pick<TmuxCreator, 'createSession'>
  sessionNames: () => readonly string[]
  refreshSnapshot: () => Promise<void>
  home?: string
  resolveClaude?: () => Promise<string>
}

/** Settings > Profiles. Mounted behind the daemon's owner gate. */
export async function handleAgentProfilesApi(request: IncomingMessage, response: ServerResponse, url: URL, deps: AgentProfilesApiDependencies): Promise<boolean> {
  const route = Object.values(AGENT_PROFILE_ROUTES).find((path) => path === url.pathname)
  if (!route) return false
  const home = deps.home ?? homedir()
  try {
    if (route === AGENT_PROFILE_ROUTES.list && request.method === 'GET') {
      const refresh = url.searchParams.get('refresh') === '1'
      const [profiles, others] = await Promise.all([deps.preferences.claudeProfiles({ includeHidden: true }), deps.prober.others(refresh)])
      const claude: ClaudeProfileSettings[] = await Promise.all(profiles.map(async (profile) => ({ ...profile, status: await deps.prober.claude(profile.configDir, refresh) })))
      json(response, 200, { claude, others } satisfies AgentProfilesResponse)
      return true
    }
    if (route === AGENT_PROFILE_ROUTES.claudePreferences && request.method === 'PUT') {
      const input = await body(request)
      const { configDir, label, hidden, isDefault } = input
      if (typeof configDir !== 'string') throw new Error('configDir is required')
      if (label !== undefined && label !== null && typeof label !== 'string') throw new Error('label must be a string or null')
      if (hidden !== undefined && typeof hidden !== 'boolean') throw new Error('hidden must be a boolean')
      if (isDefault !== undefined && typeof isDefault !== 'boolean') throw new Error('isDefault must be a boolean')
      await deps.preferences.update({ configDir, ...(label !== undefined ? { label } : {}), ...(hidden !== undefined ? { hidden } : {}), ...(isDefault !== undefined ? { isDefault } : {}) })
      json(response, 200, { ok: true })
      return true
    }
    if (route === AGENT_PROFILE_ROUTES.claude && request.method === 'POST') {
      const { name, label } = await body(request)
      if (typeof name !== 'string') throw new Error('name is required')
      // Checked first, so a bad label never leaves a new folder behind.
      const kept = label === undefined || (typeof label === 'string' && !label.trim()) ? undefined : validLabel(label)
      const configDir = await addClaudeProfile(name, home)
      if (kept) await deps.preferences.update({ configDir, label: kept })
      json(response, 201, { configDir })
      return true
    }
    if (route === AGENT_PROFILE_ROUTES.claudeLogin && request.method === 'POST') {
      const { configDir } = await body(request)
      if (typeof configDir !== 'string') throw new Error('configDir is required')
      const profiles = await deps.preferences.claudeProfiles({ includeHidden: true })
      const profile = profiles.find((candidate) => candidate.configDir === configDir)
      if (!profile) throw new Error('Unknown Claude profile')
      const claude = await (deps.resolveClaude ?? (() => resolveAgentExecutable('claude', process.env)))()
      const taken = new Set(deps.sessionNames())
      const base = `claude-login-${profile.name || 'default'}`
      let name = base, suffix = 2
      while (taken.has(name)) name = `${base}-${suffix++}`
      const created: TmuxCreateResponse = await deps.creator.createSession({ name, cwd: home }, claudeLoginCommand(claude, configDir))
      deps.prober.invalidate(`claude:${configDir}`)
      await deps.refreshSnapshot()
      json(response, 201, created)
      return true
    }
    response.setHeader('Allow', route === AGENT_PROFILE_ROUTES.list ? 'GET' : route === AGENT_PROFILE_ROUTES.claudePreferences ? 'PUT' : 'POST')
    json(response, 405, { error: 'Method not allowed' })
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 400
    json(response, status, { error: error instanceof Error ? error.message : 'Request failed' })
  }
  return true
}

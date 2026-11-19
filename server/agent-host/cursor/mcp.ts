import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import {
  parseChatMcpServer,
  safeAuthUrl,
  type ChatMcpRequest,
  type ChatMcpResult,
  type ChatMcpServer,
  type ChatMcpStatus,
  type ChatMcpTool,
} from '../../../shared/chat-mcp.js'
import { displayCommand, displayUrl } from '../claude-mcp.js'
import { which } from '../which.js'

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const CLI_TIMEOUT_MS = 25_000
const LIST_TOOLS_TIMEOUT_MS = 15_000
const LOGIN_URL_TIMEOUT_MS = 20_000
const LOGIN_MAX_LIFETIME_MS = 5 * 60_000
const TOOLS_CACHE_TTL_MS = 60_000
const MAX_CONCURRENT_TOOL_PROBES = 3
const MAX_LOGIN_OUTPUT_BYTES = 64 * 1024

export interface CursorConfiguredServer {
  name: string
  scope: 'project' | 'user'
  transport?: string
  target?: string
}

export interface CursorMcpListEntry {
  status: ChatMcpStatus
  error?: string
}

export interface CursorMcpLoginProcess {
  readonly authUrl: Promise<string | undefined>
  readonly done: Promise<{ ok: boolean; error?: string }>
  cancel(): void
}

export interface CursorMcpCli {
  run(args: readonly string[], options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>
  startLogin(server: string, options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }): Promise<CursorMcpLoginProcess>
}

export interface CursorMcpCallbacks {
  reloadAgent(): Promise<void>
  onAuthChanged(server: string): void
}

export interface CursorMcpControllerOptions {
  cwd: string
  env: Record<string, string | undefined>
  home?: string
  cli?: CursorMcpCli | null
  resolveCli?: () => Promise<CursorMcpCli | null>
  now?: () => number
  callbacks: CursorMcpCallbacks
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** Matches Cursor CLI / @cursor/sdk workspace slugging (`../utils/dist/workspace-paths.js`). */
export function cursorProjectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
}

/** Walks up to the enclosing `.git` directory, matching Cursor's projectRoot resolution. */
export function findCursorProjectRoot(cwd: string): string {
  let current = resolve(cwd)
  const { root } = parse(current)
  for (;;) {
    try {
      if (existsSync(join(current, '.git'))) return current
    } catch {
      // ignore unreadable ancestor
    }
    const parent = dirname(current)
    if (parent === current || parent === root) break
    current = parent
  }
  return resolve(cwd)
}

export function cursorDataDir(env: Record<string, string | undefined>, home = homedir()): string {
  const custom = env.CURSOR_DATA_DIR?.trim()
  return custom || join(home, '.cursor')
}

export function cursorProjectDir(cwd: string, env: Record<string, string | undefined>, home = homedir()): string {
  return join(cursorDataDir(env, home), 'projects', cursorProjectSlug(findCursorProjectRoot(cwd)))
}

function configuredTarget(entry: Record<string, unknown>): { transport?: string; target?: string } {
  if (typeof entry.url === 'string' && entry.url.length > 0) {
    const transport = entry.type === 'sse' ? 'sse' : 'http'
    return { transport, target: displayUrl(entry.url) }
  }
  if (typeof entry.command === 'string' && entry.command.length > 0) {
    const args = Array.isArray(entry.args) ? entry.args.filter((value): value is string => typeof value === 'string') : []
    return { transport: 'stdio', target: displayCommand(entry.command, args) }
  }
  return {}
}

/** Extracts display-safe server metadata from a `.cursor/mcp.json` file (never env, headers or auth). */
export function parseCursorMcpConfigFile(raw: string, scope: 'project' | 'user'): CursorConfiguredServer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return []
  const servers: CursorConfiguredServer[] = []
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (!name || !isRecord(value)) continue
    servers.push({ name, scope, ...configuredTarget(value) })
  }
  return servers
}

export async function readCursorMcpConfigs(cwd: string, home = homedir()): Promise<Map<string, CursorConfiguredServer>> {
  const projectRoot = findCursorProjectRoot(cwd)
  const paths: { path: string; scope: 'user' | 'project' }[] = [
    { path: join(home, '.cursor', 'mcp.json'), scope: 'user' },
    { path: join(projectRoot, '.cursor', 'mcp.json'), scope: 'project' },
  ]
  const servers = new Map<string, CursorConfiguredServer>()
  for (const { path, scope } of paths) {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    for (const server of parseCursorMcpConfigFile(raw, scope)) {
      servers.set(server.name, server)
    }
  }
  return servers
}

export async function readDisabledServers(disabledPath: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(disabledPath, 'utf8'))
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))
  } catch {
    return new Set()
  }
}

export async function writeDisabledServers(disabledPath: string, servers: Iterable<string>): Promise<void> {
  const unique = [...new Set(servers)].sort((a, b) => a.localeCompare(b))
  await mkdir(dirname(disabledPath), { recursive: true })
  await writeFile(disabledPath, `${JSON.stringify(unique, null, 2)}\n`, 'utf8')
}

/** Removes saved OAuth credentials for `serverName` from Cursor's per-project `mcp-auth.json`. */
export async function clearServerAuth(authPath: string, serverName: string): Promise<boolean> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(authPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
  if (!isRecord(parsed) || !(serverName in parsed)) return false
  delete parsed[serverName]
  await mkdir(dirname(authPath), { recursive: true })
  await writeFile(authPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return true
}

/** Parses `agent mcp list` plain-text output into per-server status entries. */
export function parseCursorMcpList(output: string): Map<string, CursorMcpListEntry> {
  const result = new Map<string, CursorMcpListEntry>()
  const clean = stripAnsi(output)
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('No MCP servers configured')) continue
    const sep = line.indexOf(': ')
    if (sep <= 0) continue
    const name = line.slice(0, sep).trim()
    const state = line.slice(sep + 2).trim()
    if (!name || !state) continue
    if (state === 'ready') result.set(name, { status: 'connected' })
    else if (state === 'requires_authentication') result.set(name, { status: 'needs-auth' })
    else if (state === 'loading') result.set(name, { status: 'pending' })
    else if (state === 'disabled') result.set(name, { status: 'disabled' })
    else if (state === 'not loaded (needs approval)') {
      result.set(name, { status: 'disabled', error: 'Needs approval in Cursor CLI — enable to approve' })
    } else if (state.startsWith('Error: ')) {
      result.set(name, { status: 'failed', error: state.slice('Error: '.length).trim() || 'Connection failed' })
    } else {
      result.set(name, { status: 'failed', error: state })
    }
  }
  return result
}

/** Parses `agent mcp list-tools <id>` plain-text output into `ChatMcpTool[]`. */
export function parseCursorMcpTools(output: string): ChatMcpTool[] {
  const tools: ChatMcpTool[] = []
  const clean = stripAnsi(output)
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = /^-\s+(\S+)(?:\s+\(([^)]*)\))?$/.exec(line)
    if (!match) continue
    const name = match[1]!
    const args = match[2]?.trim()
    tools.push(args ? { name, description: `Arguments: ${args}` } : { name })
  }
  return tools
}

/**
 * Extracts the OAuth authorization URL printed by `agent mcp login <id>`,
 * ignoring the local callback URL on `Listening on http://...` lines.
 */
export function extractCursorMcpAuthUrl(output: string): string | undefined {
  const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim())
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!line || /^listening on\b/i.test(line)) continue
    if (/^(open this url|opening your browser|keep that ssh session open)/i.test(line)) {
      for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 4); lookahead += 1) {
        const candidate = safeAuthUrl(lines[lookahead])
        if (candidate) return candidate
      }
    }
    const direct = safeAuthUrl(line)
    if (direct) return direct
  }
  return undefined
}

function cliOutputError(stdout: string, stderr: string, fallback: string): string {
  const raw = stripAnsi(`${stderr}\n${stdout}`).trim()
  if (!raw) return fallback
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const important = lines.find((line) => /^(✗|error:|failed\b)/i.test(line)) ?? lines.at(-1)
  return (important ?? fallback).replace(/^✗\s*/, '')
}

function cliEnv(env: Record<string, string | undefined>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value
  }
  return { ...merged, NO_COLOR: '1', FORCE_COLOR: '0', ...extra }
}

/** Spawns the installed Cursor CLI (`agent` or `cursor-agent`) without a shell. */
export function createCursorMcpCli(binaryPath: string): CursorMcpCli {
  return {
    run(args, { cwd, env, timeoutMs }) {
      return new Promise((resolveRun, rejectRun) => {
        execFile(binaryPath, ['--workspace', cwd, ...args], {
          cwd,
          env: cliEnv(env),
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            if (error.killed) rejectRun(new Error('Cursor CLI timed out'))
            else rejectRun(error)
            return
          }
          resolveRun({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            exitCode: error && typeof error.code === 'number' ? error.code : 0,
          })
        })
      })
    },
    async startLogin(server, { cwd, env, timeoutMs }) {
      const child = spawn(binaryPath, ['--workspace', cwd, 'mcp', 'login', '--', server], {
        cwd,
        env: cliEnv(env, { NO_OPEN_BROWSER: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let urlSettled = false
      let doneSettled = false
      let resolveUrl!: (value: string | undefined) => void
      let rejectUrl!: (error: Error) => void
      let resolveDone!: (value: { ok: boolean; error?: string }) => void

      const authUrl = new Promise<string | undefined>((res, rej) => { resolveUrl = res; rejectUrl = rej })
      const done = new Promise<{ ok: boolean; error?: string }>((res) => { resolveDone = res })

      const finishUrl = (value: string | undefined, error?: Error) => {
        if (urlSettled) return
        urlSettled = true
        clearTimeout(urlTimer)
        if (error) rejectUrl(error)
        else resolveUrl(value)
      }
      const finishDone = (result: { ok: boolean; error?: string }) => {
        if (doneSettled) return
        doneSettled = true
        clearTimeout(lifetimeTimer)
        resolveDone(result)
      }

      const killChild = () => {
        if (child.exitCode !== null || child.killed) return
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        const force = setTimeout(() => {
          if (child.exitCode === null) {
            try { child.kill('SIGKILL') } catch { /* already gone */ }
          }
        }, 500)
        force.unref?.()
      }

      const urlTimer = setTimeout(() => {
        killChild()
        finishUrl(undefined, new Error(`Timed out waiting for Cursor to start MCP login for '${server}'`))
      }, timeoutMs)
      urlTimer.unref?.()

      const lifetimeTimer = setTimeout(() => {
        killChild()
        finishDone({ ok: false, error: 'MCP login timed out waiting for browser callback' })
      }, LOGIN_MAX_LIFETIME_MS)
      lifetimeTimer.unref?.()

      const append = (current: string, chunk: Buffer) => {
        if (current.length >= MAX_LOGIN_OUTPUT_BYTES) return current
        return `${current}${chunk.toString('utf8')}`.slice(0, MAX_LOGIN_OUTPUT_BYTES)
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk)
        if (!urlSettled) {
          const url = extractCursorMcpAuthUrl(stdout)
          if (url) finishUrl(url)
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk)
      })
      child.once('error', (error) => {
        const message = errorText(error)
        finishUrl(undefined, new Error(`Couldn't start Cursor MCP login: ${message}`))
        finishDone({ ok: false, error: message })
      })
      child.once('close', (code) => {
        if (code === 0) {
          finishUrl(undefined)
          finishDone({ ok: true })
        } else {
          const message = cliOutputError(stdout, stderr, `MCP login failed (exit ${code ?? 'unknown'})`)
          finishUrl(undefined, new Error(message))
          finishDone({ ok: false, error: message })
        }
      })

      return {
        authUrl,
        done,
        cancel() {
          clearTimeout(urlTimer)
          clearTimeout(lifetimeTimer)
          killChild()
          finishUrl(undefined, new Error('MCP login cancelled'))
          finishDone({ ok: false, error: 'MCP login cancelled' })
        },
      }
    },
  }
}

export async function resolveDefaultCursorMcpCli(path?: string): Promise<CursorMcpCli | null> {
  const binary = (await which('agent', path)) ?? (await which('cursor-agent', path))
  return binary ? createCursorMcpCli(binary) : null
}

async function mapBounded<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const run = async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return results
}

/**
 * Manages MCP inspection, toggling, reconnects and OAuth sign-ins for a single
 * Cursor chat session by combining Cursor's config files, `agent mcp` CLI and
 * `SDKAgent.reload()`.
 */
export class CursorMcpController {
  private readonly home: string
  private readonly now: () => number
  private readonly resolveCli: () => Promise<CursorMcpCli | null>
  private cliPromise?: Promise<CursorMcpCli | null>
  private inFlightStatus?: Promise<ChatMcpResult>
  private readonly toolsCache = new Map<string, { tools: ChatMcpTool[]; fetchedAt: number }>()
  private readonly pendingLogins = new Map<string, CursorMcpLoginProcess>()
  private disposed = false

  constructor(private readonly options: CursorMcpControllerOptions) {
    this.home = options.home ?? homedir()
    this.now = options.now ?? Date.now
    this.resolveCli = options.resolveCli
      ?? (options.cli !== undefined ? async () => options.cli! : () => resolveDefaultCursorMcpCli(options.env.PATH))
  }

  private get projectDir(): string {
    return cursorProjectDir(this.options.cwd, this.options.env, this.home)
  }

  private get disabledPath(): string {
    return join(this.projectDir, 'mcp-disabled.json')
  }

  private get authPath(): string {
    return join(this.projectDir, 'mcp-auth.json')
  }

  private async getCli(): Promise<CursorMcpCli | null> {
    if (!this.cliPromise) {
      this.cliPromise = this.resolveCli().then((cli) => {
        // Retry lookup later if the CLI was not yet installed on PATH.
        if (!cli) this.cliPromise = undefined
        return cli
      })
    }
    return this.cliPromise
  }

  private cancelLogin(server: string): void {
    const existing = this.pendingLogins.get(server)
    if (!existing) return
    this.pendingLogins.delete(server)
    existing.cancel()
  }

  dispose(): void {
    this.disposed = true
    for (const login of this.pendingLogins.values()) login.cancel()
    this.pendingLogins.clear()
  }

  async handle(request: ChatMcpRequest): Promise<ChatMcpResult> {
    if (this.disposed) return { servers: [], error: 'Cursor chat is closed' }
    if (request.action === 'status') {
      return this.readStatusCoalesced()
    }
    let error: string | undefined
    let authUrl: string | undefined
    let authChanged = false
    try {
      const outcome = await this.act(request)
      authUrl = outcome.authUrl
      authChanged = outcome.authChanged === true
    } catch (cause) {
      error = errorText(cause)
    }
    const status = await this.readStatus()
    if (authChanged && !this.disposed) {
      this.options.callbacks.onAuthChanged(request.server)
    }
    return {
      servers: status.servers,
      ...(authUrl ? { authUrl } : {}),
      ...(error ?? status.error ? { error: error ?? status.error } : {}),
    }
  }

  private readStatusCoalesced(): Promise<ChatMcpResult> {
    if (!this.inFlightStatus) {
      this.inFlightStatus = this.readStatus().finally(() => {
        this.inFlightStatus = undefined
      })
    }
    return this.inFlightStatus
  }

  private async act(request: Exclude<ChatMcpRequest, { action: 'status' }>): Promise<{ authUrl?: string; authChanged?: boolean }> {
    switch (request.action) {
      case 'enable':
        await this.toggleServer(request.server, true)
        this.toolsCache.delete(request.server)
        await this.options.callbacks.reloadAgent()
        return {}
      case 'disable':
        this.cancelLogin(request.server)
        await this.toggleServer(request.server, false)
        this.toolsCache.delete(request.server)
        await this.options.callbacks.reloadAgent()
        return {}
      case 'reconnect':
        this.toolsCache.delete(request.server)
        await this.options.callbacks.reloadAgent()
        return {}
      case 'authenticate':
        return this.authenticate(request.server)
      case 'clear_auth':
        this.cancelLogin(request.server)
        await clearServerAuth(this.authPath, request.server)
        this.toolsCache.delete(request.server)
        return { authChanged: true }
    }
  }

  private async toggleServer(server: string, enabled: boolean): Promise<void> {
    const cli = await this.getCli()
    if (cli) {
      const subcommand = enabled ? 'enable' : 'disable'
      const result = await cli.run(['mcp', subcommand, '--', server], {
        cwd: this.options.cwd,
        env: this.options.env,
        timeoutMs: CLI_TIMEOUT_MS,
      })
      if (result.exitCode !== 0) {
        throw new Error(cliOutputError(result.stdout, result.stderr, `Couldn't ${subcommand} MCP server '${server}'`))
      }
      return
    }
    const disabled = await readDisabledServers(this.disabledPath)
    if (enabled) disabled.delete(server)
    else disabled.add(server)
    await writeDisabledServers(this.disabledPath, disabled)
  }

  private async authenticate(server: string): Promise<{ authUrl?: string }> {
    const cli = await this.getCli()
    if (!cli) throw new Error("Cursor CLI ('agent') was not found on PATH; install it to sign in to MCP servers")
    this.cancelLogin(server)
    const login = await cli.startLogin(server, {
      cwd: this.options.cwd,
      env: this.options.env,
      timeoutMs: LOGIN_URL_TIMEOUT_MS,
    })
    let url: string | undefined
    try {
      url = await login.authUrl
    } catch (error) {
      login.cancel()
      throw error
    }
    if (!url) {
      // Server was already authenticated.
      this.toolsCache.delete(server)
      await this.options.callbacks.reloadAgent()
      return {}
    }
    if (this.disposed) {
      login.cancel()
      return {}
    }
    this.pendingLogins.set(server, login)
    void login.done.then(({ ok }) => {
      if (this.pendingLogins.get(server) === login) this.pendingLogins.delete(server)
      if (ok && !this.disposed) {
        this.toolsCache.delete(server)
        this.options.callbacks.onAuthChanged(server)
      }
    })
    return { authUrl: url }
  }

  private async readStatus(): Promise<ChatMcpResult> {
    try {
      const [configured, disabled, cli] = await Promise.all([
        readCursorMcpConfigs(this.options.cwd, this.home),
        readDisabledServers(this.disabledPath),
        this.getCli(),
      ])

      let live = new Map<string, CursorMcpListEntry>()
      let readError: string | undefined
      if (cli) {
        try {
          const listed = await cli.run(['mcp', 'list'], {
            cwd: this.options.cwd,
            env: this.options.env,
            timeoutMs: CLI_TIMEOUT_MS,
          })
          if (listed.exitCode === 0) live = parseCursorMcpList(listed.stdout)
          else readError = cliOutputError(listed.stdout, listed.stderr, "Couldn't list Cursor MCP servers")
        } catch (cause) {
          readError = `Couldn't read live Cursor MCP status: ${errorText(cause)}`
        }
      } else if (configured.size > 0) {
        readError = "Cursor CLI ('agent') was not found on PATH; showing configured MCP servers without live status"
      }

      const names = new Set<string>([...configured.keys(), ...live.keys()])
      const connectedNames: string[] = []
      const draft: {
        name: string
        status: ChatMcpStatus
        scope?: string
        transport?: string
        target?: string
        error?: string
      }[] = []

      for (const name of names) {
        const config = configured.get(name)
        const probed = live.get(name)
        const status: ChatMcpStatus = probed?.status ?? (disabled.has(name) ? 'disabled' : 'pending')
        if (status === 'connected') connectedNames.push(name)
        else this.toolsCache.delete(name)
        draft.push({
          name,
          status,
          scope: config?.scope ?? 'plugin',
          transport: config?.transport,
          target: config?.target,
          error: probed?.error,
        })
      }

      const toolsByServer = cli ? await this.loadTools(cli, connectedNames) : new Map<string, ChatMcpTool[]>()
      const servers: ChatMcpServer[] = draft.flatMap((entry) => {
        const parsed = parseChatMcpServer({
          ...entry,
          tools: entry.status === 'connected' ? (toolsByServer.get(entry.name) ?? []) : [],
        })
        return parsed ? [parsed] : []
      })
      return { servers, ...(readError ? { error: readError } : {}) }
    } catch (cause) {
      return { servers: [], error: `Couldn't read Cursor MCP servers: ${errorText(cause)}` }
    }
  }

  private async loadTools(cli: CursorMcpCli, serverNames: readonly string[]): Promise<Map<string, ChatMcpTool[]>> {
    const result = new Map<string, ChatMcpTool[]>()
    const now = this.now()
    const toFetch: string[] = []
    for (const name of serverNames) {
      const cached = this.toolsCache.get(name)
      if (cached && now - cached.fetchedAt < TOOLS_CACHE_TTL_MS) {
        result.set(name, cached.tools)
      } else {
        toFetch.push(name)
      }
    }
    if (!toFetch.length) return result
    await mapBounded(toFetch, MAX_CONCURRENT_TOOL_PROBES, async (name) => {
      try {
        const listed = await cli.run(['mcp', 'list-tools', '--', name], {
          cwd: this.options.cwd,
          env: this.options.env,
          timeoutMs: LIST_TOOLS_TIMEOUT_MS,
        })
        if (listed.exitCode === 0) {
          const tools = parseCursorMcpTools(listed.stdout)
          this.toolsCache.set(name, { tools, fetchedAt: this.now() })
          result.set(name, tools)
        }
      } catch {
        // Keep the server listed even if tool discovery times out.
      }
    })
    return result
  }
}

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  defaultWorktreePath,
  SESSION_AGENT_EXECUTABLES,
  sessionAgentArgv,
  type SessionAgentLaunch,
  type CreateTmuxPaneRequest,
  type CreateTmuxSessionRequest,
  type CreateTmuxWindowRequest,
  type GitRepoInfo,
  type TmuxCreatedTarget,
  type TmuxCreateResponse,
} from '../shared/tmux-create.js'
import { GitWorktreeError, type CreateWorktreeInput, type CreateWorktreeResult } from './git-worktree.js'

const COMMAND_TIMEOUT_MS = 3_000
const COMMAND_BUFFER_BYTES = 64 * 1024
const FIELD_SEPARATOR = '\u001f'
const SOCKET_NAME = /^[A-Za-z0-9._-]{1,128}$/
const SESSION_ID = /^\$\d+$/
const WINDOW_ID = /^@\d+$/
const PANE_ID = /^%\d+$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u
const SHELL_COMMAND_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const CREATE_FORMAT = [
  '#{session_id}',
  '#{session_name}',
  '#{window_id}',
  '#{window_index}',
  '#{window_name}',
  '#{pane_id}',
  '#{pane_index}',
  '#{pane_current_path}',
  '#{pane_start_path}',
].join(FIELD_SEPARATOR)

type LaunchEnvironment = Readonly<Record<string, string | undefined>>
export const AGENT_LAUNCH_ENV_KEYS = [
  'HOME', 'SHELL', 'PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CURSOR_CONFIG_DIR', 'XDG_CONFIG_HOME',
  'COMMANDO_AGENT_HOOK_TOKEN_PATH', 'COMMANDO_PORT', 'COMMANDO_TOKEN',
  'COMMANDO_TMUX_SOCKET_NAME', 'COMMANDO_TMUX_SOCKET_PATH',
] as const
export type AgentExecutableResolver = (command: string, env: LaunchEnvironment) => Promise<string>

/** Resolve only absolute PATH entries: never execute a binary supplied by the checkout. */
export async function resolveAgentExecutable(command: string, env: LaunchEnvironment): Promise<string> {
  for (const directory of (env.PATH ?? '').split(':').filter((path) => path.startsWith('/'))) {
    const candidate = join(directory, command)
    try {
      await access(candidate, constants.X_OK)
      if ((await stat(candidate)).isFile()) return candidate
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`Cannot start ${command}: executable not found on the daemon PATH. Install the CLI on the daemon host.`)
}

function validatedAgent(value: unknown): SessionAgentLaunch | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent must be an object')
  const { provider, prompt } = value as { provider?: unknown; prompt?: unknown }
  if (typeof provider !== 'string' || !Object.hasOwn(SESSION_AGENT_EXECUTABLES, provider)) {
    throw new Error('Unsupported session agent provider')
  }
  if (prompt !== undefined && (typeof prompt !== 'string' || Buffer.byteLength(prompt, 'utf8') > 8_192 || SHELL_COMMAND_CONTROL_CHARACTER.test(prompt))) {
    throw new Error('agent prompt must be at most 8192 bytes without unsupported control characters')
  }
  return { provider: provider as SessionAgentLaunch['provider'], ...(typeof prompt === 'string' ? { prompt } : {}) }
}

/** Arguments/environment are quoted data; preparation is the user-authored shell code. */
export function agentLaunchShellCommand(prepareCommand?: string, env?: LaunchEnvironment): string {
  return [
    // tmux can supply stale global values and overrides SHELL while spawning.
    // Set/unset only these names again immediately before preparation and exec.
    ...(env ? AGENT_LAUNCH_ENV_KEYS.map((key) => env[key] === undefined ? `unset ${key}` : `export ${key}=${shellQuote(env[key]!)}`) : []),
    ...(prepareCommand ? [
      "printf '\\n[commando] Preparing worktree...\\n'",
      '(', prepareCommand, ')',
      'commando_prepare_status=$?',
      'if [ "$commando_prepare_status" -ne 0 ]; then',
      "  printf '[commando] Worktree preparation failed (exit %s); agent was not started.\\n' \"$commando_prepare_status\" >&2",
      '  exec "${SHELL:-/bin/sh}" -l',
      'fi',
      "printf '[commando] Worktree preparation complete.\\n'",
    ] : []),
    'exec "$@"',
  ].join('\n')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`
}

/** One tmux shell-command argument also protects literal `;` from tmux's command parser. */
export function agentLaunchPaneCommand(argv: readonly string[], prepareCommand?: string, env?: LaunchEnvironment): string {
  return `exec ${['/bin/sh', '-c', agentLaunchShellCommand(prepareCommand, env), 'commando-agent', ...argv].map(shellQuote).join(' ')}`
}

export type TmuxCreateCommandRunner = (args: readonly string[]) => Promise<string>

/** The slice of GitWorktreeService that session creation needs. */
export type TmuxWorktreeProvider = {
  probe: (directory: string) => Promise<GitRepoInfo>
  createWorktree: (input: CreateWorktreeInput) => Promise<CreateWorktreeResult>
}

export class TmuxCreateCommandError extends Error {
  readonly code: string | number | undefined
  readonly stderr: string

  constructor(message: string, code: string | number | undefined, stderr: string) {
    super(message)
    this.name = 'TmuxCreateCommandError'
    this.code = code
    this.stderr = stderr
  }
}

export function tmuxSocketArgsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const socketPath = env.COMMANDO_TMUX_SOCKET_PATH
  const socketName = env.COMMANDO_TMUX_SOCKET_NAME
  if (socketPath && socketName) {
    throw new Error('Set only one of COMMANDO_TMUX_SOCKET_PATH or COMMANDO_TMUX_SOCKET_NAME')
  }
  if (socketPath) {
    if (!socketPath.startsWith('/') || socketPath.includes('\0')) {
      throw new Error('COMMANDO_TMUX_SOCKET_PATH must be an absolute path')
    }
    return ['-S', socketPath]
  }
  if (socketName) {
    if (!SOCKET_NAME.test(socketName)) {
      throw new Error('COMMANDO_TMUX_SOCKET_NAME contains unsupported characters')
    }
    return ['-L', socketName]
  }
  return []
}

export function runTmuxCreateCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tmux',
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: COMMAND_BUFFER_BYTES,
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new TmuxCreateCommandError(
              error.killed ? 'tmux create command timed out' : 'tmux create command failed',
              error.code ?? undefined,
              stderr.slice(0, 2_000),
            ),
          )
          return
        }
        resolve(stdout)
      },
    )
  })
}

function validatedName(value: unknown, field: string, session = false): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${field} must be 1-128 bytes without surrounding whitespace or control characters`)
  }
  if (session && /[.:]/u.test(value)) {
    throw new Error(`${field} cannot contain a colon or period`)
  }
  return value
}

function validatedPath(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    Buffer.byteLength(value, 'utf8') > 4_096 ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error('cwd must be an absolute path of at most 4096 bytes without control characters')
  }
  return value
}

function optionalName(value: unknown, field: string): string | undefined {
  return value === undefined || value === '' ? undefined : validatedName(value, field)
}

function optionalPrepareCommand(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 8_192 ||
    SHELL_COMMAND_CONTROL_CHARACTER.test(value)
  ) {
    throw new Error('prepare command must be at most 8192 bytes without unsupported control characters')
  }
  return value.trim() ? value : undefined
}

export function worktreePreparationShellCommand(command: string): string {
  return [
    "printf '\\n[commando] Preparing worktree...\\n'",
    '(',
    command,
    ')',
    'commando_prepare_status=$?',
    'if [ "$commando_prepare_status" -eq 0 ]; then',
    "  printf '[commando] Worktree preparation complete.\\n'",
    'else',
    "  printf '[commando] Worktree preparation failed (exit %s).\\n' \"$commando_prepare_status\" >&2",
    'fi',
    'exec "${SHELL:-/bin/sh}" -l',
  ].join('\n')
}

function parseCreatedTarget(output: string, kind: TmuxCreatedTarget['kind']): TmuxCreatedTarget {
  const lines = output.split(/\r?\n/u).filter((line) => line.length > 0)
  if (lines.length !== 1) throw new Error('tmux returned an invalid create response')
  const fields = lines[0].split(FIELD_SEPARATOR)
  if (fields.length !== 9) throw new Error('tmux returned an invalid create response')

  const [
    sessionId,
    sessionName,
    windowId,
    windowIndexValue,
    windowName,
    paneId,
    paneIndexValue,
    paneCurrentPath,
    paneStartPath,
  ] = fields
  // The OS may not report the child process's cwd yet when -P formats a newly
  // created pane. tmux already knows its starting directory, even during prep.
  const panePath = paneCurrentPath || paneStartPath
  const windowIndex = /^\d+$/u.test(windowIndexValue) ? Number(windowIndexValue) : NaN
  const paneIndex = /^\d+$/u.test(paneIndexValue) ? Number(paneIndexValue) : NaN
  if (
    !SESSION_ID.test(sessionId) ||
    sessionName.length === 0 ||
    !WINDOW_ID.test(windowId) ||
    !PANE_ID.test(paneId) ||
    !Number.isSafeInteger(windowIndex) ||
    windowIndex < 0 ||
    !Number.isSafeInteger(paneIndex) ||
    paneIndex < 0 ||
    CONTROL_CHARACTER.test(sessionName) ||
    CONTROL_CHARACTER.test(windowName) ||
    CONTROL_CHARACTER.test(panePath) ||
    !panePath.startsWith('/')
  ) {
    throw new Error('tmux returned an invalid create response')
  }

  return {
    kind,
    sessionId,
    sessionName,
    windowId,
    windowIndex,
    windowName,
    paneId,
    paneIndex,
    panePath,
  }
}

export class TmuxCreator {
  constructor(
    private readonly run: TmuxCreateCommandRunner = runTmuxCreateCommand,
    private readonly socketArgs: readonly string[] = tmuxSocketArgsFromEnv(),
    private readonly worktrees?: TmuxWorktreeProvider,
    private readonly resolveExecutable: AgentExecutableResolver = resolveAgentExecutable,
    private readonly launchEnv: LaunchEnvironment = process.env,
  ) {}

  async createSession(input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> {
    const name = validatedName(input.name, 'session name', true)
    const windowName = optionalName(input.windowName, 'window name')
    const cwd = validatedPath(input.cwd)
    const agent = validatedAgent(input.agent)
    const agentArgv = agent ? sessionAgentArgv(agent) : undefined
    if (agentArgv) agentArgv[0] = await this.resolveExecutable(agentArgv[0], this.launchEnv)
    const acknowledgment = (created: TmuxCreatedTarget): Pick<TmuxCreateResponse, 'agentLaunch'> => agent
      ? { agentLaunch: { version: 1, provider: agent.provider, paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } }
      : {}
    if (input.worktree === undefined) {
      const created = await this.newSession(name, windowName, cwd, undefined, agentArgv)
      return { created, ...acknowledgment(created) }
    }

    if (!this.worktrees) throw new Error('Worktree creation is not available')
    if (!cwd) throw new Error('A working directory is required to create a worktree')
    const branch = validatedName(input.worktree.branch, 'branch name')
    const worktreePath = validatedPath(input.worktree.path)
    const prepareCommand = optionalPrepareCommand(input.worktree.prepareCommand)
    if (await this.sessionExists(name)) throw new Error(`Session ${name} already exists`)

    const repo = await this.worktrees.probe(cwd)
    if (!repo.isRepo || !repo.mainRoot) {
      throw new GitWorktreeError('not-repo', `${cwd} is not inside a git repository`)
    }
    const { worktree, rollback } = await this.worktrees.createWorktree({
      mainRoot: repo.mainRoot,
      branch,
      path: worktreePath ?? defaultWorktreePath(repo.mainRoot, branch),
      ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch, remote: repo.remote } : {}),
    })
    try {
      const created = await this.newSession(
        name,
        windowName,
        worktree.path,
        prepareCommand,
        agentArgv,
      )
      return { created, worktree, ...acknowledgment(created) }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (await this.sessionExists(name)) {
        throw new Error(`Session ${name} was created but tmux did not report it: ${detail}`, { cause: error })
      }
      try {
        await rollback()
      } catch (rollbackError) {
        const rollbackDetail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        throw new Error(`${detail}; worktree rollback failed: ${rollbackDetail}`, { cause: error })
      }
      throw error
    }
  }

  private async sessionExists(name: string): Promise<boolean> {
    try {
      await this.run([...this.socketArgs, 'has-session', '-t', `=${name}`])
      return true
    } catch {
      return false
    }
  }

  private async newSession(
    name: string,
    windowName: string | undefined,
    cwd: string | undefined,
    prepareCommand?: string,
    agentArgv?: string[],
  ): Promise<TmuxCreatedTarget> {
    const args = [
      ...this.socketArgs,
      'new-session',
      '-d',
      '-P',
      '-F',
      CREATE_FORMAT,
      '-s',
      name,
    ]
    if (windowName) args.push('-n', windowName)
    if (cwd) args.push('-c', cwd)
    if (agentArgv) {
      // An existing tmux server can have older global environment values. Scope
      // the daemon context to this session; TMUX_PANE remains assigned by tmux.
      for (const key of AGENT_LAUNCH_ENV_KEYS) {
        const value = this.launchEnv[key]
        if (value !== undefined) args.push('-e', `${key}=${value}`)
      }
      args.push(agentLaunchPaneCommand(agentArgv, prepareCommand, this.launchEnv))
    } else if (prepareCommand) args.push(worktreePreparationShellCommand(prepareCommand))
    return parseCreatedTarget(await this.run(args), 'session')
  }

  async createWindow(input: CreateTmuxWindowRequest): Promise<TmuxCreatedTarget> {
    if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) {
      throw new Error('Invalid tmux session id')
    }
    const name = optionalName(input.name, 'window name')
    const cwd = validatedPath(input.cwd)
    const args = [
      ...this.socketArgs,
      'new-window',
      '-d',
      '-P',
      '-F',
      CREATE_FORMAT,
      '-t',
      input.sessionId,
    ]
    if (name) args.push('-n', name)
    if (cwd) args.push('-c', cwd)
    return parseCreatedTarget(await this.run(args), 'window')
  }

  async createPane(
    input: CreateTmuxPaneRequest,
    beforeCreate?: () => void | Promise<void>,
  ): Promise<TmuxCreatedTarget> {
    if (
      typeof input.targetId !== 'string' ||
      (!WINDOW_ID.test(input.targetId) && !PANE_ID.test(input.targetId))
    ) {
      throw new Error('Invalid tmux window or pane id')
    }
    if (input.direction !== 'horizontal' && input.direction !== 'vertical') {
      throw new Error('Invalid tmux split direction')
    }
    if (input.placement !== undefined && input.placement !== 'before' && input.placement !== 'after') {
      throw new Error('Invalid tmux split placement')
    }
    const cwd = validatedPath(input.cwd)
    const args = [
      ...this.socketArgs,
      'split-window',
      '-d',
      input.direction === 'horizontal' ? '-h' : '-v',
      ...(input.placement === 'before' ? ['-b'] : []),
      '-P',
      '-F',
      CREATE_FORMAT,
      '-t',
      input.targetId,
    ]
    if (cwd) args.push('-c', cwd)
    await beforeCreate?.()
    return parseCreatedTarget(await this.run(args), 'pane')
  }
}

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  autoSessionName,
  CHAT_PERMISSION_MODES,
  chatPermissionModes,
  isChatLaunchProvider,
  defaultWorktreePath,
  EMPTY_PANE_OPTION,
  SESSION_AGENT_EXECUTABLES,
  sessionAgentArgv,
  type SessionAgentLaunch,
  type CreateTmuxPaneRequest,
  type CreateTmuxSessionRequest,
  type CreateTmuxWindowRequest,
  type ClaudeProfile,
  type GitRepoInfo,
  type LaunchTmuxPaneRequest,
  type TmuxCreatedTarget,
  type TmuxCreateResponse,
  type TmuxCreatedWorktree,
  type SessionAgentLaunchAcknowledgment,
} from '../shared/tmux-create.js'
import { isChatConversationSessionId } from '../shared/chat-conversations.js'
import { isModelValue, parseChatImageRefs } from '../shared/agent-chat.js'
import { SESSION_ADJECTIVES, SESSION_ANIMALS } from '../shared/session-identity.js'
import { isChatPlanDir } from './chat-plans-dir.js'
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

/** Chat panes run this checkout's agent host, so it always matches the daemon. */
export const COMMANDO_AGENT_LAUNCHER = fileURLToPath(new URL('../scripts/commando-agent', import.meta.url))

const CLAUDE_CONFIG_DIR_NAME = /^\.claude[A-Za-z0-9_-]*$/

/** Claude config dirs live directly in the home folder and are named `.claude…`. */
export function validClaudeConfigDir(value: string, home = homedir()): boolean {
  return isAbsolute(value) && !CONTROL_CHARACTER.test(value) && resolve(value) === value
    && dirname(value) === home && CLAUDE_CONFIG_DIR_NAME.test(basename(value))
}

const ACTIVITY_STAT_BATCH = 64
const ACTIVITY_TRANSCRIPT_LIMIT = 2_000

/** Modification times in parallel batches; unreadable paths come back undefined. */
async function modifiedTimes(paths: readonly string[]): Promise<Array<number | undefined>> {
  const times: Array<number | undefined> = []
  for (let start = 0; start < paths.length; start += ACTIVITY_STAT_BATCH) {
    times.push(...await Promise.all(paths.slice(start, start + ACTIVITY_STAT_BATCH)
      .map((path) => stat(path).then((info) => info.mtimeMs, () => undefined))))
  }
  return times
}

/** Transcripts directly inside each folder, listed in parallel batches until the limit. */
async function transcriptsIn(folders: readonly string[], limit: number): Promise<string[]> {
  const transcripts: string[] = []
  for (let start = 0; start < folders.length && transcripts.length < limit; start += ACTIVITY_STAT_BATCH) {
    const listings = await Promise.all(folders.slice(start, start + ACTIVITY_STAT_BATCH).map((folder) =>
      readdir(folder, { withFileTypes: true }).then((entries) => entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => join(folder, entry.name)), () => [])))
    transcripts.push(...listings.flat())
  }
  return transcripts.slice(0, limit)
}

/**
 * Newest session activity under a profile's projects/ folder. Appending to a transcript
 * changes only that file, so this checks the project folders and the transcripts directly
 * inside them. Recently changed folders are read first, and the transcript count is
 * capped so a profile with thousands of sessions stays cheap to list.
 */
async function lastClaudeActivity(projectsDir: string): Promise<number | undefined> {
  const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => [])
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => join(projectsDir, entry.name))
  const [projectsTime, ...folderTimes] = await modifiedTimes([projectsDir, ...folders])
  const recentFirst = folders
    .map((folder, index) => ({ folder, time: folderTimes[index] ?? 0 }))
    .sort((a, b) => b.time - a.time)
    .map(({ folder }) => folder)
  const transcriptTimes = await modifiedTimes(await transcriptsIn(recentFirst, ACTIVITY_TRANSCRIPT_LIMIT))
  let latest: number | undefined
  for (const time of [projectsTime, ...folderTimes, ...transcriptTimes]) {
    if (time !== undefined && (latest === undefined || time > latest)) latest = time
  }
  return latest
}

/** Claude config dirs in the home folder that have been used (they hold settings or sessions). */
export async function listClaudeProfiles(home = homedir()): Promise<ClaudeProfile[]> {
  const entries = await readdir(home, { withFileTypes: true }).catch(() => [])
  const profiles: ClaudeProfile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !CLAUDE_CONFIG_DIR_NAME.test(entry.name)) continue
    const configDir = join(home, entry.name)
    const used = await Promise.any([
      access(join(configDir, 'settings.json')),
      access(join(configDir, 'projects')),
    ].map((check) => check.then(() => true))).catch(() => false)
    if (!used) continue
    // Sessions write to projects/, so its newest transcript says which login is in use.
    const lastUsedAt = await lastClaudeActivity(join(configDir, 'projects'))
    profiles.push({ name: entry.name.slice(1), configDir, ...(lastUsedAt === undefined ? {} : { lastUsedAt }) })
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name))
}

type LaunchEnvironment = Readonly<Record<string, string | undefined>>
export const AGENT_LAUNCH_ENV_KEYS = [
  'HOME', 'SHELL', 'PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CURSOR_CONFIG_DIR', 'XDG_CONFIG_HOME',
  'COMMANDO_AGENT_HOOK_TOKEN_PATH', 'COMMANDO_PORT', 'COMMANDO_TOKEN',
  'COMMANDO_TMUX_SOCKET_NAME', 'COMMANDO_TMUX_SOCKET_PATH', 'COMMANDO_CHAT_IMAGES_DIR', 'COMMANDO_CHAT_PLANS_DIR',
  'ARGENT_SIMULATOR_NO_WINDOW',
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
  const { provider, prompt, configDir, permissionMode, readableDir, resume, fullAccess, model, images } = value as { provider?: unknown; prompt?: unknown; configDir?: unknown; permissionMode?: unknown; readableDir?: unknown; resume?: unknown; fullAccess?: unknown; model?: unknown; images?: unknown }
  if (typeof provider !== 'string' || !Object.hasOwn(SESSION_AGENT_EXECUTABLES, provider)) {
    throw new Error('Unsupported session agent provider')
  }
  if (prompt !== undefined && (typeof prompt !== 'string' || Buffer.byteLength(prompt, 'utf8') > 8_192 || SHELL_COMMAND_CONTROL_CHARACTER.test(prompt))) {
    throw new Error('agent prompt must be at most 8192 bytes without unsupported control characters')
  }
  if (!isChatLaunchProvider(provider) && (permissionMode !== undefined || readableDir !== undefined)) {
    throw new Error('Only a chat accepts a permission mode and readable folder')
  }
  if (configDir !== undefined && !isChatLaunchProvider(provider) && provider !== 'claude') throw new Error('Only Claude accepts a profile')
  if (model !== undefined && (!isModelValue(model) || (!isChatLaunchProvider(provider) && provider !== 'claude' && provider !== 'codex'))) {
    throw new Error('Only a chat, Claude or Codex accepts a model id')
  }
  if (images !== undefined && !isChatLaunchProvider(provider)) throw new Error('Only a chat accepts attached images')
  const imageRefs = images === undefined ? undefined : parseChatImageRefs(images)
  if (images !== undefined && !imageRefs) throw new Error('images must be up to 10 uploaded image or video ids')
  if (resume !== undefined && !isChatLaunchProvider(provider) && provider !== 'cursor' && provider !== 'opencode') throw new Error('This provider cannot resume a conversation')
  if (resume !== undefined && !isChatConversationSessionId(resume)) throw new Error('Invalid conversation id to resume')
  if (fullAccess !== undefined && (fullAccess !== true || provider !== 'muse-chat' || permissionMode !== 'bypassPermissions')) throw new Error('Only a Muse chat in bypassPermissions can ask for full access')
  const chatName = provider === 'codex-chat' ? 'Codex' : provider === 'muse-chat' ? 'Muse' : provider === 'cursor-chat' ? 'Cursor' : 'Claude'
  if (chatName !== 'Claude' && (configDir !== undefined || readableDir !== undefined)) throw new Error(`${chatName} chat does not accept a Claude profile or readable folder`)
  if (isChatLaunchProvider(provider) && permissionMode !== undefined && !chatPermissionModes(provider).some((mode) => mode.value === permissionMode)) throw new Error(`Unsupported ${chatName} permission mode`)
  // Only one stashed plan's own folder: a chat must not be handed any other path.
  if (readableDir !== undefined && !isChatPlanDir(readableDir)) {
    throw new Error('A chat can only be given a stashed plan folder to read')
  }
  if (configDir !== undefined && (typeof configDir !== 'string' || !validClaudeConfigDir(configDir))) {
    throw new Error('Claude profile must be a ~/.claude… folder')
  }
  if (provider !== 'cursor-chat' && permissionMode !== undefined && !CHAT_PERMISSION_MODES.some((mode) => mode.value === permissionMode)) {
    throw new Error('Unsupported permission mode')
  }
  return {
    provider: provider as SessionAgentLaunch['provider'],
    ...(typeof prompt === 'string' ? { prompt } : {}),
    ...(typeof configDir === 'string' ? { configDir } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(imageRefs?.length ? { images: imageRefs } : {}),
    ...(typeof permissionMode === 'string' ? { permissionMode: permissionMode as NonNullable<SessionAgentLaunch['permissionMode']> } : {}),
    ...(typeof readableDir === 'string' ? { readableDir } : {}),
    ...(typeof resume === 'string' ? { resume } : {}),
    ...(fullAccess === true ? { fullAccess: true as const } : {}),
  }
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

const LOGIN_SHELL_COMMAND = 'exec "${SHELL:-/bin/sh}" -l'

/**
 * An empty pane idles until something is launched into it. After preparation it marks
 * itself empty, so the preparation output stays visible while it runs.
 */
export function emptyPaneShellCommand(prepare?: { command: string; tmux: string }): string {
  return [
    ...(prepare ? [
      "printf '\\n[commando] Preparing worktree...\\n'",
      '(',
      prepare.command,
      ')',
      'commando_prepare_status=$?',
      'if [ "$commando_prepare_status" -ne 0 ]; then',
      "  printf '[commando] Worktree preparation failed (exit %s).\\n' \"$commando_prepare_status\" >&2",
      `  ${LOGIN_SHELL_COMMAND}`,
      'fi',
      "printf '[commando] Worktree preparation complete.\\n'",
      // $$ is the pane's own process: this shell later execs the idle command in place.
      `${shellQuote(prepare.tmux)} set-option -p -t "$TMUX_PANE" ${EMPTY_PANE_OPTION} "$$" || ${LOGIN_SHELL_COMMAND}`,
    ] : []),
    "printf '[commando] Nothing is running here yet. Start a shell or an agent from Commando.\\n'",
    'exec tail -f /dev/null',
  ].join('\n')
}

/** One tmux shell-command argument, as for agent launches. */
export function emptyPaneCommand(prepare?: { command: string; tmux: string }): string {
  return `exec ${['/bin/sh', '-c', emptyPaneShellCommand(prepare)].map(shellQuote).join(' ')}`
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

const AUTO_NAME_ATTEMPTS = 20

/** For a session with nothing to name it after (a screenshot alone): `amber-fox`, say. */
export function generatedSessionName(random: () => number = Math.random): string {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!
  return `${pick(SESSION_ADJECTIVES)}-${pick(SESSION_ANIMALS)}`.toLowerCase()
}

/** The names an auto-named session tries in turn: the hint or the prompt's first words, then -2, -3… */
function autoNameCandidates(hint: unknown, agent: SessionAgentLaunch | undefined): string[] {
  if (hint !== undefined && typeof hint !== 'string') throw new Error('session name must be a string')
  const base = autoSessionName(hint ?? '') || autoSessionName(agent?.prompt ?? '') || generatedSessionName()
  return [base, ...Array.from({ length: AUTO_NAME_ATTEMPTS - 1 }, (_, index) => `${base}-${index + 2}`)]
}

export class TmuxCreator {
  private readonly launching = new Set<string>()

  constructor(
    private readonly run: TmuxCreateCommandRunner = runTmuxCreateCommand,
    private readonly socketArgs: readonly string[] = tmuxSocketArgsFromEnv(),
    private readonly worktrees?: TmuxWorktreeProvider,
    private readonly resolveExecutable: AgentExecutableResolver = resolveAgentExecutable,
    private readonly launchEnv: LaunchEnvironment = process.env,
    /** The profile a Claude chat starts with when its launch names none (a phone or API caller). */
    private readonly defaultClaudeConfigDir: () => Promise<string | undefined> = async () => undefined,
  ) {}

  /** resumeCommand is server-owned; HTTP creation handlers never forward it. */
  async createSession(input: CreateTmuxSessionRequest, resumeCommand?: string): Promise<TmuxCreateResponse> {
    if (input.autoName !== undefined && typeof input.autoName !== 'boolean') throw new Error('autoName must be a boolean')
    const autoName = input.autoName === true
    const windowName = optionalName(input.windowName, 'window name')
    const cwd = validatedPath(input.cwd)
    const agent = validatedAgent(input.agent)
    const names = autoName ? autoNameCandidates(input.name, agent) : [validatedName(input.name, 'session name', true)]
    if (input.empty !== undefined && typeof input.empty !== 'boolean') throw new Error('empty must be a boolean')
    const empty = input.empty === true
    if (empty && (agent || resumeCommand !== undefined)) throw new Error('An empty session cannot also start an agent')
    const agentArgv = this.resumeArgv(resumeCommand, agent) ?? (agent ? await this.agentArgv(agent) : undefined)
    const acknowledgment = (created: TmuxCreatedTarget): Pick<TmuxCreateResponse, 'agentLaunch'> => agent
      ? { agentLaunch: { version: 1, provider: agent.provider, paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } }
      : {}
    if (input.worktree === undefined) {
      if (!autoName) {
        const created = await this.newSession(names[0]!, windowName, cwd, undefined, agentArgv, empty)
        return { created, ...acknowledgment(created) }
      }
      for (const name of names) {
        if (await this.sessionExists(name)) continue
        try {
          const created = await this.newSession(name, windowName, cwd, undefined, agentArgv, empty)
          return { created, ...acknowledgment(created) }
        } catch (error) {
          // Taken between the check and the create: the next name will do.
          if (!await this.sessionExists(name)) throw error
        }
      }
      throw new Error(`Every name tried for this session is taken (${names[0]}…)`)
    }

    if (!this.worktrees) throw new Error('Worktree creation is not available')
    if (!cwd) throw new Error('A working directory is required to create a worktree')
    // An auto-named session names its branch too, and must not borrow one that already exists.
    const branchFromName = autoName && !input.worktree.branch
    const chosenBranch = branchFromName ? undefined : validatedName(input.worktree.branch, 'branch name')
    const worktreePath = validatedPath(input.worktree.path)
    const prepareCommand = optionalPrepareCommand(input.worktree.prepareCommand)
    const repo = await this.worktrees.probe(cwd)
    if (!repo.isRepo || !repo.mainRoot) {
      throw new GitWorktreeError('not-repo', `${cwd} is not inside a git repository`)
    }
    for (const [index, name] of names.entries()) {
      if (await this.sessionExists(name)) {
        if (!autoName) throw new Error(`Session ${name} already exists`)
        continue
      }
      const branch = chosenBranch ?? name
      let created: CreateWorktreeResult
      try {
        created = await this.worktrees.createWorktree({
          mainRoot: repo.mainRoot,
          branch,
          path: worktreePath ?? defaultWorktreePath(repo.mainRoot, branch),
          ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch, remote: repo.remote } : {}),
          ...(branchFromName ? { newBranchOnly: true } : {}),
        })
      } catch (error) {
        // A path the user typed stays the same whatever the name, so it is not retried.
        const taken = error instanceof GitWorktreeError && (error.kind === 'branch-exists' || error.kind === 'branch-checked-out' || (error.kind === 'path-exists' && !worktreePath))
        if (branchFromName && taken && index < names.length - 1) continue
        throw error
      }
      const target = await this.sessionInWorktree(name, windowName, created, prepareCommand, agentArgv, empty)
      return { created: target, worktree: created.worktree, ...acknowledgment(target) }
    }
    throw new Error(`Every name tried for this session is taken (${names[0]}…)`)
  }

  /** Starts the session in a worktree just created, removing the worktree again if tmux fails. */
  private async sessionInWorktree(
    name: string,
    windowName: string | undefined,
    { worktree, rollback }: CreateWorktreeResult,
    prepareCommand: string | undefined,
    agentArgv: string[] | undefined,
    empty: boolean,
  ): Promise<TmuxCreatedTarget> {
    try {
      return await this.newSession(name, windowName, worktree.path, prepareCommand, agentArgv, empty)
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

  /** True when a pane's cwd is inside `directory`, or when tmux cannot say (so callers keep it). */
  private async paneMayUseDirectory(directory: string): Promise<boolean> {
    try {
      const output = await this.run([...this.socketArgs, 'list-panes', '-a', '-F', '#{pane_current_path}'])
      // tmux reports the real cwd; a typed path may carry a trailing slash or a symlink.
      const trimmed = directory.replace(/\/+$/u, '') || '/'
      const roots = new Set([trimmed, await realpath(trimmed).catch(() => trimmed)])
      return output.split('\n').some((path) => [...roots].some((root) => path === root || path.startsWith(`${root}/`)))
    } catch {
      return true
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

  private resumeArgv(command: string | undefined, agent?: SessionAgentLaunch): string[] | undefined {
    if (command === undefined) return undefined
    if (agent) throw new Error('A resume command cannot also start an agent')
    if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 8192 || CONTROL_CHARACTER.test(command)) {
      throw new Error('Invalid resume command: expected a bounded command without control characters')
    }
    return ['/bin/sh', '-c', command]
  }

  private async agentArgv(agent: SessionAgentLaunch): Promise<string[]> {
    // Without a profile, Claude would sign in with the bare ~/.claude login, which may not be the one in use.
    const configDir = (agent.provider === 'claude-chat' || agent.provider === 'claude') && !agent.configDir ? await this.defaultClaudeConfigDir().catch(() => undefined) : undefined
    const argv = sessionAgentArgv(configDir ? { ...agent, configDir } : agent)
    argv[0] = isChatLaunchProvider(agent.provider)
      ? COMMANDO_AGENT_LAUNCHER
      : await this.resolveExecutable(argv[0]!, this.launchEnv)
    // Terminal Claude picks its login the way `claudep`-style aliases do: from the environment.
    // The bare ~/.claude profile is Claude's own default, so the variable is cleared rather than set.
    const profile = agent.provider === 'claude' ? agent.configDir ?? configDir : undefined
    if (profile) return profile === join(homedir(), '.claude') ? ['/usr/bin/env', '-u', 'CLAUDE_CONFIG_DIR', ...argv] : ['/usr/bin/env', `CLAUDE_CONFIG_DIR=${profile}`, ...argv]
    return argv
  }

  /** tmux -e flags that scope the daemon's context to a pane that starts an agent. */
  private agentEnvironmentArgs(): string[] {
    const args: string[] = []
    for (const key of AGENT_LAUNCH_ENV_KEYS) {
      const value = this.launchEnv[key]
      if (value !== undefined) args.push('-e', `${key}=${value}`)
    }
    return args
  }

  private async newSession(
    name: string,
    windowName: string | undefined,
    cwd: string | undefined,
    prepareCommand?: string,
    agentArgv?: string[],
    empty = false,
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
      args.push(...this.agentEnvironmentArgs())
      args.push(agentLaunchPaneCommand(agentArgv, prepareCommand, this.launchEnv))
    } else if (empty) args.push(await this.emptyPaneArg(prepareCommand))
    else if (prepareCommand) args.push(worktreePreparationShellCommand(prepareCommand))
    const created = parseCreatedTarget(await this.run(args), 'session')
    if (empty && !prepareCommand) await this.markNewPaneEmpty(created.paneId, `Session ${created.sessionName}`)
    return created
  }

  private async emptyPaneArg(prepareCommand?: string): Promise<string> {
    const prepare = prepareCommand ? { command: prepareCommand, tmux: await this.resolveExecutable('tmux', this.launchEnv) } : undefined
    return emptyPaneCommand(prepare)
  }

  /** A preparing pane marks itself once preparation succeeds, so only an unprepared one is marked here. */
  private async markNewPaneEmpty(paneId: string, createdLabel: string): Promise<void> {
    try {
      await this.markPaneEmpty(paneId)
    } catch (error) {
      // The pane exists either way: hand it back as a plain shell rather than orphan it.
      console.warn('[commando] Could not mark the new pane empty; starting a shell in it', error)
      try {
        await this.run([...this.socketArgs, 'respawn-pane', '-k', '-t', paneId, LOGIN_SHELL_COMMAND])
      } catch (respawnError) {
        throw new Error(`${createdLabel} was created, but its pane could not be prepared. Close it and try again.`, { cause: respawnError })
      }
    }
  }

  /** The marker holds the idle process id, so a pane respawned outside Commando never reads as empty. */
  private async markPaneEmpty(paneId: string): Promise<void> {
    await this.run([...this.socketArgs, 'set-option', '-p', '-F', '-t', paneId, EMPTY_PANE_OPTION, '#{pane_pid}'])
  }

  private async setPaneEmptyMarker(paneId: string, idlePid: string | null): Promise<void> {
    await this.run([...this.socketArgs, 'set-option', '-p', ...(idlePid ? ['-t', paneId, EMPTY_PANE_OPTION, idlePid] : ['-u', '-t', paneId, EMPTY_PANE_OPTION])])
  }

  /** Replaces an empty pane's idle process; a pane already running something is never touched. */
  async launchInEmptyPane(input: LaunchTmuxPaneRequest): Promise<void> {
    if (typeof input.paneId !== 'string' || !PANE_ID.test(input.paneId)) throw new Error('Invalid tmux pane id')
    const agent = validatedAgent(input.agent)
    const agentArgv = agent ? await this.agentArgv(agent) : undefined
    // The daemon is the only launcher, so this keeps a second request from killing the first.
    if (this.launching.has(input.paneId)) throw new Error('This pane is already starting something')
    this.launching.add(input.paneId)
    try {
      const [marker, panePid] = (await this.run([...this.socketArgs, 'display-message', '-p', '-t', input.paneId, `#{${EMPTY_PANE_OPTION}} #{pane_pid}`])).trim().split(' ')
      if (!marker || marker !== panePid) throw new Error('This pane is already running something')
      await this.setPaneEmptyMarker(input.paneId, null)
      try {
        await this.run([
          ...this.socketArgs, 'respawn-pane', '-k', '-t', input.paneId,
          ...(agentArgv ? [...this.agentEnvironmentArgs(), agentLaunchPaneCommand(agentArgv, undefined, this.launchEnv)] : [LOGIN_SHELL_COMMAND]),
        ])
      } catch (error) {
        // Restore the idle pid itself: if a timed-out respawn did start something, its new
        // pid will not match, so the pane is never offered for another (killing) launch.
        await this.setPaneEmptyMarker(input.paneId, marker).catch((restoreError: unknown) => {
          console.warn('[commando] Could not restore the empty-pane marker', input.paneId, restoreError)
        })
        throw error
      }
    } finally {
      this.launching.delete(input.paneId)
    }
  }

  /**
   * The caller permits replacement only for a chat or an empty pane.
   * resumeCommand is server-owned, as on creation.
   */
  async respawnChatPane(paneId: string, cwd: string, launch?: SessionAgentLaunch, resumeCommand?: string): Promise<void> {
    if (!PANE_ID.test(paneId)) throw new Error('Invalid tmux pane id')
    const agent = validatedAgent(launch)
    const resumeArgv = this.resumeArgv(resumeCommand, agent)
    if (!resumeArgv && (!agent || (!isChatLaunchProvider(agent.provider) && !((agent.provider === 'cursor' || agent.provider === 'opencode') && agent.resume)))) throw new Error('Only a chat or resumed TUI can take over a chat pane')
    const directory = validatedPath(cwd)
    if (!directory) throw new Error('A folder is required')
    if (this.launching.has(paneId)) throw new Error('This pane is already starting something')
    this.launching.add(paneId)
    try {
      await this.run([
        ...this.socketArgs, 'respawn-pane', '-k', '-t', paneId, '-c', directory,
        ...this.agentEnvironmentArgs(), agentLaunchPaneCommand(resumeArgv ?? await this.agentArgv(agent!), undefined, this.launchEnv),
      ])
    } finally {
      this.launching.delete(paneId)
    }
  }

  async createWindow(input: CreateTmuxWindowRequest, resumeCommand?: string): Promise<TmuxCreatedTarget> {
    if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) {
      throw new Error('Invalid tmux session id')
    }
    const name = optionalName(input.name, 'window name')
    const cwd = validatedPath(input.cwd)
    const agent = validatedAgent(input.agent)
    const agentArgv = this.resumeArgv(resumeCommand, agent) ?? (agent ? await this.agentArgv(agent) : undefined)
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
    if (agentArgv) args.push(...this.agentEnvironmentArgs(), agentLaunchPaneCommand(agentArgv, undefined, this.launchEnv))
    return parseCreatedTarget(await this.run(args), 'window')
  }

  async createPane(
    input: CreateTmuxPaneRequest,
    beforeCreate?: () => void | Promise<void>,
    resumeCommand?: string,
  ): Promise<TmuxCreatedTarget & { worktree?: TmuxCreatedWorktree; agentLaunch?: SessionAgentLaunchAcknowledgment }> {
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
    let cwd = validatedPath(input.cwd)
    const agent = validatedAgent(input.agent)
    if (input.empty !== undefined && typeof input.empty !== 'boolean') throw new Error('empty must be a boolean')
    const empty = input.empty === true
    if (empty && (agent || resumeCommand !== undefined)) throw new Error('An empty pane cannot also start an agent')
    const agentArgv = this.resumeArgv(resumeCommand, agent) ?? (agent ? await this.agentArgv(agent) : undefined)
    if (input.worktree !== undefined && (!input.worktree || typeof input.worktree !== 'object' || Array.isArray(input.worktree))) throw new Error('worktree must be an object')
    const branch = input.worktree ? validatedName(input.worktree.branch, 'branch name') : undefined
    const path = input.worktree ? validatedPath(input.worktree.path) : undefined
    const prepareCommand = input.worktree ? optionalPrepareCommand(input.worktree.prepareCommand) : undefined
    if (input.worktree && (!this.worktrees || !cwd)) throw new Error('A working directory and worktree service are required')
    let worktree: TmuxCreatedWorktree | undefined
    let rollback: (() => Promise<void>) | undefined
    if (input.worktree) {
      const repo = await this.worktrees!.probe(cwd!)
      if (!repo.isRepo || !repo.mainRoot) throw new GitWorktreeError('not-repo', `${cwd} is not inside a git repository`)
      const result = await this.worktrees!.createWorktree({
        mainRoot: repo.mainRoot, branch: branch!, path: path ?? defaultWorktreePath(repo.mainRoot, branch!),
        ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch, remote: repo.remote } : {}),
      })
      worktree = result.worktree
      rollback = result.rollback
      cwd = worktree.path
    }
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
    if (agentArgv) args.push(...this.agentEnvironmentArgs(), agentLaunchPaneCommand(agentArgv, prepareCommand, this.launchEnv))
    else if (empty) args.push(await this.emptyPaneArg(prepareCommand))
    else if (prepareCommand) args.push(worktreePreparationShellCommand(prepareCommand))
    let output: string
    try {
      await beforeCreate?.()
      output = await this.run(args)
    } catch (error) {
      if (rollback && worktree) {
        const detail = error instanceof Error ? error.message : String(error)
        // An ambiguous failure may still have split: never delete a worktree a pane already runs in.
        if (await this.paneMayUseDirectory(worktree.path)) {
          throw new Error(`A pane in ${worktree.path} may have been created but tmux did not report it; the worktree was kept: ${detail}`, { cause: error })
        }
        try { await rollback() } catch (rollbackError) {
          throw new Error(`${detail}; worktree rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { cause: error })
        }
      }
      throw error
    }
    // A successful split with malformed output still owns its worktree.
    const created = parseCreatedTarget(output, 'pane')
    if (empty && !prepareCommand) await this.markNewPaneEmpty(created.paneId, 'The pane')
    return { ...created, ...(worktree ? { worktree } : {}), ...(agent ? {
      agentLaunch: { version: 1, provider: agent.provider, paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' },
    } : {}) }
  }

  async setChatLineage(paneId: string, parentTargetId: string, title: string): Promise<void> {
    if (!PANE_ID.test(paneId) || CONTROL_CHARACTER.test(parentTargetId) || CONTROL_CHARACTER.test(title)) throw new Error('Invalid chat lineage')
    await this.run([...this.socketArgs, 'set-option', '-p', '-t', paneId, '@commando_opened_by', parentTargetId])
    await this.run([...this.socketArgs, 'set-option', '-p', '-t', paneId, '@commando_chat_title', title])
  }
}

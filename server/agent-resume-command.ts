import { basename, dirname, join } from 'node:path'
import { isChatProvider, type ChatProvider } from '../shared/agent-chat.js'
import type { AgentProvider } from '../shared/protocol.js'

export type ResumableProvider = Exclude<AgentProvider, 'unknown'>

/** The agent process a pane was running, as `ps` reports it. */
export type AgentLaunch = {
  /** Whitespace-split argv. `ps` cannot preserve spaces inside arguments. */
  args: readonly string[]
  /** Only the provider's own configuration variables. */
  env: Readonly<Record<string, string>>
}

type FlagSpec = {
  /** Flags that take no value. */
  bare: readonly string[]
  /** Flags that take exactly one value. */
  single: readonly string[]
  /** Flags that take values until the next flag. */
  multi?: readonly string[]
  /** Flags whose single value is dropped with them: old resume targets, names, prompts. */
  dropped?: readonly string[]
}

type ProviderSpec = {
  executables: readonly string[]
  /** Other executable names, such as a versioned binary a launcher script execs. */
  executablePattern?: RegExp
  /** Arguments a launcher script inserts before the user's own. */
  launcherArgs?: (rest: readonly string[]) => number
  env: readonly string[]
  flags: FlagSpec
  resume: (executable: string[], flags: string[], sessionId: string) => string[]
}

// Only flags that shape the session are carried over. Everything else is dropped: prompts,
// old resume/continue targets, print mode, and flags whose values may contain spaces.
const MUSE_BINARY = /^muse-bin-\d[\w.-]*$/

const PROVIDERS: Record<ResumableProvider, ProviderSpec> = {
  claude: {
    executables: ['claude'],
    env: ['CLAUDE_CONFIG_DIR'],
    flags: {
      bare: [
        '--dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions',
        '--verbose',
        '--ide',
        '--chrome',
        '--no-chrome',
        '--strict-mcp-config',
        '--brief',
      ],
      single: [
        '--permission-mode',
        '--model',
        '--effort',
        '--settings',
        '--agent',
        '--setting-sources',
        '--fallback-model',
        '--autocompact',
      ],
      multi: ['--add-dir', '--mcp-config', '--plugin-dir'],
      dropped: ['-r', '--resume', '--session-id', '-n', '--name', '--append-system-prompt', '--system-prompt'],
    },
    resume: (executable, flags, id) => [...executable, ...flags, '--resume', id],
  },
  codex: {
    executables: ['codex'],
    env: ['CODEX_HOME'],
    flags: {
      bare: [
        '--dangerously-bypass-approvals-and-sandbox',
        '--approve-for-me',
        '--search',
        '--no-alt-screen',
        '--oss',
      ],
      single: [
        '-m',
        '--model',
        '-p',
        '--profile',
        '-s',
        '--sandbox',
        '-a',
        '--ask-for-approval',
        '-c',
        '--config',
        '--enable',
        '--disable',
        '--add-dir',
        '--local-provider',
      ],
    },
    resume: (executable, flags, id) => [...executable, 'resume', ...flags, id],
  },
  opencode: {
    executables: ['opencode'],
    env: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'],
    flags: {
      bare: ['--yolo', '--auto', '--pure', '--mini', '--no-replay'],
      single: ['-m', '--model', '--agent', '--log-level', '--replay-limit'],
      dropped: ['-s', '--session', '--prompt'],
    },
    resume: (executable, flags, id) => [...executable, ...flags, '-s', id],
  },
  cursor: {
    executables: ['agent', 'cursor-agent'],
    // The launcher execs `node [--use-system-ca] <dir>/index.js "$@"` under the launcher's name.
    launcherArgs: (rest) => {
      const skip = rest[0] === '--use-system-ca' ? 1 : 0
      return rest[skip]?.endsWith('/index.js') ? skip + 1 : 0
    },
    env: [],
    flags: {
      bare: ['-f', '--force', '--yolo', '--auto-review', '--approve-mcps', '--trust', '--plan'],
      single: ['--model', '--mode', '--sandbox', '--workspace'],
      multi: ['--add-dir', '--plugin-dir'],
    },
    resume: (executable, flags, id) => [...executable, ...flags, `--resume=${id}`],
  },
  muse: {
    executables: ['muse'],
    // The `muse` launcher script execs a versioned `muse-bin-<version>` beside itself.
    executablePattern: MUSE_BINARY,
    env: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME'],
    flags: {
      bare: ['--yolo', '--trust-workspace', '--disable-approval', '--disable-sandbox', '--disable-write', '--disable-shell', '--disable-request-user-input', '--parallel-tool-calls', '--no-parallel-tool-calls', '--no-session-log'],
      single: ['--provider', '--preset', '--model', '--reasoning-effort', '--effort', '--approval-mode', '--permission-profile', '--approval-judge', '--sandbox-network', '--workspace', '--contributor-mode', '--base-url'],
      dropped: ['--image', '-w', '--worktree', '--worktree-base', '--worktree-existing', '--agents'],
    },
    // Resume through the launcher so an updated binary is picked up.
    resume: (executable, flags, id) => [museLauncher(executable), ...flags, 'resume', id],
  },
}

function museLauncher(executable: readonly string[]): string {
  const first = executable[0]!
  if (!MUSE_BINARY.test(basename(first))) return first
  return first.includes('/') ? join(dirname(first), 'muse') : 'muse'
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/
const SAFE_WORD = /^[\w@%+=:,./~-]+$/
const SCRIPT_RUNTIMES = new Set(['node', 'bun', 'deno'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'login'])

export function isResumableProvider(provider: AgentProvider): provider is ResumableProvider {
  return provider !== 'unknown'
}

export function isValidAgentSessionId(sessionId: string): boolean {
  return SESSION_ID.test(sessionId)
}

/** tmux reports a login shell as `-zsh`; a version string is a running agent (Claude sets its title). */
export function isShellCommand(command: string): boolean {
  return SHELLS.has(basename(command.trim().replace(/^-/, '')))
}

export function shellQuote(word: string): string {
  // A leading ~ or = is expanded by zsh, so such words are always quoted.
  return SAFE_WORD.test(word) && !/^[~=]/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`
}

function executableOf(spec: ProviderSpec, args: readonly string[]): { executable: string[]; rest: readonly string[] } | null {
  const [first, second] = args
  if (!first) return null
  if (spec.executables.includes(basename(first)) || spec.executablePattern?.test(basename(first))) return { executable: [first], rest: args.slice(1) }
  // npm installs run the CLI script under a JavaScript runtime, from a path naming the package.
  if (SCRIPT_RUNTIMES.has(basename(first)) && second && spec.executables.some((name) => second.includes(name))) {
    return { executable: [first, second], rest: args.slice(2) }
  }
  return null
}

/**
 * `ps` joins argv with spaces, so a prompt's words look like separate arguments. Flags come
 * before the prompt, so stop at the first word that is neither a flag nor a flag's value.
 */
function carriedFlags(flags: FlagSpec, rest: readonly string[]): string[] {
  const carried: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!
    if (!arg.startsWith('-')) break
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg] : [arg, null]
    if (flags.bare.includes(name)) {
      if (inline === null) carried.push(arg)
      continue
    }
    if (flags.single.includes(name)) {
      if (inline !== null) carried.push(inline)
      else if (index + 1 < rest.length) carried.push(arg, rest[++index]!)
      continue
    }
    if (flags.dropped?.includes(name)) {
      if (inline === null) index += 1
      continue
    }
    if (flags.multi?.includes(name)) {
      if (inline !== null) {
        carried.push(inline)
        continue
      }
      const values: string[] = []
      while (index + 1 < rest.length && !rest[index + 1]!.startsWith('-')) values.push(rest[++index]!)
      if (values.length > 0) carried.push(arg, ...values)
    }
  }
  return carried
}

/** The session-shaping flags an agent was launched with, without its prompt; null when it is not this provider's CLI. */
export function launchFlags(provider: ResumableProvider, args: readonly string[]): string[] | null {
  const spec = PROVIDERS[provider]
  const found = executableOf(spec, args)
  return found ? carriedFlags(spec.flags, found.rest.slice(spec.launcherArgs?.(found.rest) ?? 0)) : null
}

/**
 * The command line that resumes `sessionId` the way the agent was launched, or null when
 * the launch does not look like this provider's CLI.
 */
export function buildResumeCommand(
  provider: ResumableProvider,
  sessionId: string,
  launch: AgentLaunch,
): string | null {
  if (!isValidAgentSessionId(sessionId)) return null
  const spec = PROVIDERS[provider]
  const found = executableOf(spec, launch.args)
  if (!found) return null
  const rest = found.rest.slice(spec.launcherArgs?.(found.rest) ?? 0)
  const words = spec.resume(found.executable, carriedFlags(spec.flags, rest), sessionId)
  const env = spec.env
    .filter((name) => launch.env[name])
    .map((name) => `${name}=${launch.env[name]}`)
  // `env` runs the binary directly, so shell aliases and functions cannot intercept it.
  const prefix = env.length > 0 || !words[0]!.startsWith('/') ? ['env', ...env] : []
  return [...prefix, ...words].map(shellQuote).join(' ')
}

export type ProcessRow = { pid: number; ppid: number; args: string }

/** Parses `ps -axo pid=,ppid=,args=`. */
export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]!.trim() })
  }
  return rows
}

/**
 * The process that runs the provider's CLI: a child of the pane's shell, or the pane's own
 * process when Commando launched the agent as the pane command.
 */
export function findAgentProcess(
  rows: readonly ProcessRow[],
  panePid: number,
  provider: ResumableProvider,
): ProcessRow | null {
  const spec = PROVIDERS[provider]
  const runsAgent = (row: ProcessRow) => executableOf(spec, row.args.split(/\s+/)) !== null
  return rows.find((row) => row.pid === panePid && runsAgent(row))
    ?? rows.find((row) => row.ppid === panePid && runsAgent(row))
    ?? null
}

/** Reads the provider's variables from `ps -E -o command=`, which appends the environment to argv. */
export function launchFromProcess(
  provider: ResumableProvider,
  args: string,
  commandWithEnvironment: string,
): AgentLaunch {
  const env: Record<string, string> = {}
  for (const name of PROVIDERS[provider].env) {
    const match = new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(commandWithEnvironment.slice(args.length))
    if (match) env[name] = match[1]!
  }
  return { args: args.split(/\s+/).filter(Boolean), env }
}

const CHAT_HOST_ENTRY = '/server/agent-host/main.ts'
const CHAT_FLAGS: FlagSpec = {
  bare: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--fast'],
  single: ['--config-dir', '--model', '--effort', '--permission-mode', '--pre-plan-permission-mode', '--claude-path', '--readable-dir'],
  dropped: ['--resume'],
}
/** Flags a chat's pickers can change while it runs; its current settings replace them. */
const CHAT_SETTING_FLAGS = new Set(['--model', '--effort', '--permission-mode', '--pre-plan-permission-mode'])
/** Picker settings with no value: the chat's current settings decide whether they stay. */
const CHAT_SETTING_SWITCHES = new Set(['--fast'])
const CHAT_BYPASS_FLAGS = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'])

/** A running chat's model, effort, speed and modes, which its resume carries instead of the launch flags. */
export type ChatResumeSettings = {
  model?: string
  effort?: string
  fast?: boolean
  permissionMode: string
  /** In plan mode, the mode Implement returns to. */
  prePlanPermissionMode?: string
  bypassAllowed?: boolean
}

function withChatSettings(flags: readonly string[], settings: ChatResumeSettings): string[] {
  const kept: string[] = []
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    const name = flag.includes('=') ? flag.slice(0, flag.indexOf('=')) : flag
    if (CHAT_BYPASS_FLAGS.has(name) || CHAT_SETTING_SWITCHES.has(name)) continue
    if (CHAT_SETTING_FLAGS.has(name)) {
      if (!flag.includes('=')) index += 1
      continue
    }
    kept.push(flag)
  }
  return [
    ...kept,
    ...(settings.model ? ['--model', settings.model] : []),
    ...(settings.effort ? ['--effort', settings.effort] : []),
    ...(settings.fast ? ['--fast'] : []),
    '--permission-mode', settings.permissionMode,
    ...(settings.permissionMode === 'plan' && settings.prePlanPermissionMode ? ['--pre-plan-permission-mode', settings.prePlanPermissionMode] : []),
    ...(settings.bypassAllowed && settings.permissionMode !== 'bypassPermissions' ? ['--allow-dangerously-skip-permissions'] : []),
  ]
}

/**
 * A Commando chat host in the pane: the pane's own process, or a child of the
 * launcher or shell. Its `claude` child must not be mistaken for a TUI.
 */
export function findChatHost(rows: readonly ProcessRow[], panePid: number): ProcessRow | null {
  const isHost = (row: ProcessRow) => row.args.split(/\s+/).some((word) => word.endsWith(CHAT_HOST_ENTRY))
  return rows.find((row) => row.pid === panePid && isHost(row))
    ?? rows.find((row) => row.ppid === panePid && isHost(row))
    ?? null
}

/**
 * Resumes a chat pane with this checkout's launcher and the host's own session
 * flags. The profile comes from `--config-dir`, or the host's CLAUDE_CONFIG_DIR.
 * When the chat's current settings are known they replace the launch's model,
 * effort and permission flags, so a resume keeps what the pickers changed.
 */
export function buildChatResumeCommand(
  sessionId: string,
  launcher: string,
  launch: AgentLaunch,
  daemonEnv: Readonly<Record<string, string>> = {},
  settings?: ChatResumeSettings,
): string | null {
  if (!isValidAgentSessionId(sessionId)) return null
  const entry = launch.args.findIndex((word) => word.endsWith(CHAT_HOST_ENTRY))
  const provider = launch.args[entry + 1]
  if (entry < 0 || !isChatProvider(provider)) return null
  // Commando puts --prompt last; everything after it is prompt text, never flags.
  const rest = launch.args.slice(entry + 2)
  const promptAt = rest.indexOf('--prompt')
  const launched = carriedFlags(CHAT_FLAGS, promptAt < 0 ? rest : rest.slice(0, promptAt))
  const flags = settings ? withChatSettings(launched, settings) : launched
  if (provider === 'claude' && !flags.includes('--config-dir') && launch.env.CLAUDE_CONFIG_DIR) flags.unshift('--config-dir', launch.env.CLAUDE_CONFIG_DIR)
  // A shell restored by tmux may not know which daemon to report to.
  const env = Object.entries(daemonEnv).map(([name, value]) => `${name}=${value}`)
  if (provider === 'codex' && launch.env.CODEX_HOME) env.push(`CODEX_HOME=${launch.env.CODEX_HOME}`)
  if (provider === 'muse') for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) if (launch.env[name]) env.push(`${name}=${launch.env[name]}`)
  return [...(env.length ? ['env', ...env] : []), launcher, provider, ...flags, '--resume', sessionId].map(shellQuote).join(' ')
}

/**
 * Brings back the chat a conversation was switched from, once Claude Code has
 * exited: this checkout's launcher with the chat's own flags (only those a chat
 * host takes), resuming the conversation.
 */
export function buildChatReturnCommand(
  sessionId: string,
  launcher: string,
  returnFlags: readonly string[],
  daemonEnv: Readonly<Record<string, string>> = {},
  provider: ChatProvider = 'claude',
): string | null {
  if (!isValidAgentSessionId(sessionId)) return null
  const flags = carriedFlags(CHAT_FLAGS, returnFlags)
  const env = Object.entries(daemonEnv).map(([name, value]) => `${name}=${value}`)
  return [...(env.length ? ['env', ...env] : []), launcher, provider, ...flags, '--resume', sessionId, '--from-claude-code'].map(shellQuote).join(' ')
}

/** Reads literal words written by shellQuote, including adjacent quotes around apostrophes. */
function shellQuotedWords(command: string): string[] | null {
  const words: string[] = []
  let word = ''
  let quote: string | undefined
  let started = false
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (/\s/u.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (quote) return null
  if (started) words.push(word)
  return words
}

/** Saved chat launchers must return through the host rather than start a second CLI. */
export function isChatResumeCommand(command: string): boolean {
  if (/\$\{?COMMANDO_CHAT_RESUME\}?/u.test(command)) return true
  const words = shellQuotedWords(command)
  if (!words) return false
  let index = 0
  if (words[index] === 'env') {
    index += 1
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? '')) index += 1
  }
  return basename(words[index] ?? '') === 'commando-agent'
    && isChatProvider(words[index + 1])
}

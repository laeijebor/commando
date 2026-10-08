import { basename } from 'node:path'
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
}

type ProviderSpec = {
  executables: readonly string[]
  env: readonly string[]
  flags: FlagSpec
  resume: (executable: string[], flags: string[], sessionId: string) => string[]
}

// Only flags that shape the session are carried over. Everything else is dropped: prompts,
// old resume/continue targets, print mode, and flags whose values may contain spaces.
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
    },
    resume: (executable, flags, id) => [...executable, ...flags, '-s', id],
  },
  cursor: {
    executables: ['agent', 'cursor-agent'],
    env: [],
    flags: {
      bare: ['-f', '--force', '--yolo', '--auto-review', '--approve-mcps', '--trust', '--plan'],
      single: ['--model', '--mode', '--sandbox', '--workspace'],
      multi: ['--add-dir', '--plugin-dir'],
    },
    resume: (executable, flags, id) => [...executable, ...flags, `--resume=${id}`],
  },
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
  return SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`
}

function executableOf(spec: ProviderSpec, args: readonly string[]): { executable: string[]; rest: readonly string[] } | null {
  const [first, second] = args
  if (!first) return null
  if (spec.executables.includes(basename(first))) return { executable: [first], rest: args.slice(1) }
  // npm installs run the CLI script under a JavaScript runtime, from a path naming the package.
  if (SCRIPT_RUNTIMES.has(basename(first)) && second && spec.executables.some((name) => second.includes(name))) {
    return { executable: [first, second], rest: args.slice(2) }
  }
  return null
}

function carriedFlags(flags: FlagSpec, rest: readonly string[]): string[] {
  const carried: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!
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
  const words = spec.resume(found.executable, carriedFlags(spec.flags, found.rest), sessionId)
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

/** The pane shell's child that runs the provider's CLI. */
export function findAgentProcess(
  rows: readonly ProcessRow[],
  panePid: number,
  provider: ResumableProvider,
): ProcessRow | null {
  const spec = PROVIDERS[provider]
  return rows.find((row) => row.ppid === panePid && executableOf(spec, row.args.split(/\s+/)) !== null) ?? null
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

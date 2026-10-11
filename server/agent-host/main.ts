import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_HOST_WS_PATH, isChatEffort, isModelValue, isPaneId, type ChatEffort, type ChatItem, type ChatSessionInfo } from '../../shared/agent-chat.js'
import { shellQuote } from '../agent-resume-command.js'
import { agentHostBuild } from './build.js'
import { AgentHost } from './host.js'
import { AgentSession } from './session.js'
import { which } from './which.js'

const USAGE = `Usage: commando-agent claude [options]

Runs a Claude session in this tmux pane and shows it as a chat in Commando.

Options:
  --config-dir DIR                 Claude config dir (default: $CLAUDE_CONFIG_DIR)
  --resume ID                      Resume an existing Claude session
  --model MODEL                    Model to use
  --effort LEVEL                   low | medium | high | xhigh | max
  --permission-mode MODE           default | acceptEdits | plan | auto | dontAsk | bypassPermissions
  --dangerously-skip-permissions   Same as --permission-mode bypassPermissions
  --allow-dangerously-skip-permissions
                                   Allow switching to bypassPermissions later in the chat
  --claude-path PATH               Claude Code executable (default: claude on PATH)
  --prompt TEXT                    Send TEXT as the first message
`

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path)
}

export interface HostArgs {
  provider: 'claude'
  configDir?: string
  resume?: string
  model?: string
  effort?: ChatEffort
  permissionMode: PermissionMode
  /** The chat may switch to bypassPermissions (it was started with it). */
  bypassAllowed?: boolean
  claudePath?: string
  prompt?: string
}

export function parseHostArgs(argv: string[], env: Record<string, string | undefined>): HostArgs | string {
  const [provider, ...rest] = argv
  if (provider !== 'claude') return USAGE
  const args: HostArgs = { provider, permissionMode: 'default' }
  if (env.CLAUDE_CONFIG_DIR) args.configDir = expandHome(env.CLAUDE_CONFIG_DIR)
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    const value = rest[index + 1]
    const needValue = (freeText = false) => {
      // A prompt is free text: it may itself start with dashes.
      if (value === undefined || (!freeText && value.startsWith('--'))) throw new Error(`${flag} needs a value`)
      index += 1
      return value
    }
    try {
      switch (flag) {
        case '--config-dir': args.configDir = expandHome(needValue()); break
        case '--resume': args.resume = needValue(); break
        case '--model': {
          // The chat reports it to the daemon, which only accepts model ids.
          const model = needValue()
          if (!isModelValue(model)) return `Invalid model: ${model}\n\n${USAGE}`
          args.model = model
          break
        }
        case '--claude-path': args.claudePath = expandHome(needValue()); break
        case '--prompt': args.prompt = needValue(true); break
        case '--dangerously-skip-permissions': args.permissionMode = 'bypassPermissions'; args.bypassAllowed = true; break
        case '--allow-dangerously-skip-permissions': args.bypassAllowed = true; break
        case '--effort': {
          const effort = needValue()
          if (!isChatEffort(effort)) return `Unknown effort: ${effort}\n\n${USAGE}`
          args.effort = effort
          break
        }
        case '--permission-mode': {
          const mode = needValue()
          if (!PERMISSION_MODES.has(mode)) return `Unknown permission mode: ${mode}\n\n${USAGE}`
          args.permissionMode = mode as PermissionMode
          if (mode === 'bypassPermissions') args.bypassAllowed = true
          break
        }
        case '-h':
        case '--help':
          return USAGE
        default:
          return `Unknown option: ${flag}\n\n${USAGE}`
      }
    } catch (error) {
      return `${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`
    }
  }
  if (args.resume && !/^[A-Za-z0-9-]{8,80}$/.test(args.resume)) return `Invalid session id: ${args.resume}`
  return args
}

/** Variables a respawned host needs to find the same daemon. */
const DAEMON_ENV_KEYS = ['COMMANDO_PORT', 'COMMANDO_AGENT_HOOK_TOKEN_PATH', 'COMMANDO_TMUX_SOCKET_NAME', 'COMMANDO_TMUX_SOCKET_PATH'] as const

/** The flags that recreate this chat pane's session settings (no prompt, no resume target). */
export function sessionFlags(args: HostArgs): string[] {
  return [
    ...(args.configDir ? ['--config-dir', args.configDir] : []),
    ...(args.model ? ['--model', args.model] : []),
    ...(args.effort ? ['--effort', args.effort] : []),
    '--permission-mode', args.permissionMode,
    ...(args.bypassAllowed && args.permissionMode !== 'bypassPermissions' ? ['--allow-dangerously-skip-permissions'] : []),
    ...(args.claudePath ? ['--claude-path', args.claudePath] : []),
  ]
}

/**
 * The launch arguments updated with what the chat's pickers changed, so a
 * restart or resume keeps this chat's model, effort and mode.
 */
export function withSessionSettings(args: HostArgs, info: ChatSessionInfo): HostArgs {
  const { model: _model, effort: _effort, ...rest } = args
  return {
    ...rest,
    ...(info.selectedModel ? { model: info.selectedModel } : {}),
    ...(info.effort ? { effort: info.effort } : {}),
    permissionMode: info.permissionMode && PERMISSION_MODES.has(info.permissionMode) ? info.permissionMode as PermissionMode : args.permissionMode,
  }
}

/** The command that resumes a conversation as a chat pane; hooks append `--resume <id>`. */
export function chatResumeCommand(launcher: string, args: HostArgs): string {
  return [launcher, 'claude', ...sessionFlags(args)].map(shellQuote).join(' ')
}

/** Sets the terminal title, which tmux reports as the pane title. */
function terminalTitle(title: string): string {
  return `\x1b]2;${title.replace(/[\x00-\x1f\x7f]/g, ' ')}\x07`
}

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`
const color = (code: number, text: string) => `\x1b[${code}m${text}\x1b[39m`

/** One readable line per finished item, so the Terminal view tells the story too. */
export function terminalLine(item: ChatItem): string | null {
  if (item.status === 'running' && item.kind !== 'request') return null
  switch (item.kind) {
    case 'user_message': return `${color(35, '›')} ${bold(item.text)}`
    case 'assistant_message': return item.text ? `${color(37, '●')} ${item.text}` : null
    case 'reasoning': return null
    case 'command': return `${dim('  $')} ${item.command}${item.isError ? color(31, ' (failed)') : ''}`
    case 'file_change': return `${dim('  ✎')} ${item.path} ${color(32, `+${item.additions}`)} ${color(31, `-${item.deletions}`)}`
    case 'tool': return `${dim(`  • ${item.title}`)}`
    case 'todo_list': return dim(`  ☐ ${item.todos.filter((todo) => todo.status === 'completed').length}/${item.todos.length} tasks`)
    case 'request':
      if (item.answer) return dim(`  ↳ ${item.answer.kind === 'approval' ? item.answer.decision : item.answer.kind === 'question' ? 'answered' : 'cancelled'}`)
      return `${color(33, '?')} ${item.title}${item.detail ? ` ${dim(item.detail.split('\n')[0] ?? '')}` : ''} ${dim('(answer in Commando)')}`
    case 'notice': return item.level === 'error' ? color(31, `! ${item.text}`) : dim(`  ${item.text}`)
  }
}

async function main(): Promise<void> {
  const parsed = parseHostArgs(process.argv.slice(2), process.env)
  if (typeof parsed === 'string') {
    process.stderr.write(parsed)
    process.exitCode = 2
    return
  }
  const paneId = process.env.TMUX_PANE
  if (!isPaneId(paneId)) {
    process.stderr.write('commando-agent must run inside a tmux pane (TMUX_PANE is not set).\n')
    process.exitCode = 2
    return
  }
  const port = process.env.COMMANDO_PORT || '4310'
  const tokenPath = process.env.COMMANDO_AGENT_HOOK_TOKEN_PATH || resolve(homedir(), '.commando', 'agent-hook-token')
  const claudePath = parsed.claudePath ?? await which('claude')
  // getSessionMessages/getSessionInfo read transcripts from the chosen profile.
  if (parsed.configDir) process.env.CLAUDE_CONFIG_DIR = parsed.configDir
  const launcher = process.env.COMMANDO_AGENT_LAUNCHER
  const resumeCommand = launcher ? chatResumeCommand(launcher, parsed) : undefined
  // Picker changes update these, so restarts and resumes carry them.
  let settings = parsed
  const write = (line: string) => process.stdout.write(`${line}\n`)
  const hostBuild = await agentHostBuild().catch((error: unknown) => {
    write(dim(`Couldn't fingerprint this host (${error instanceof Error ? error.message : String(error)}); Commando won't offer to restart it after an update.`))
    return undefined
  })

  const host = new AgentHost(
    `ws://127.0.0.1:${port}${AGENT_HOST_WS_PATH}`,
    async () => (await readFile(tokenPath, 'utf8')).trim(),
    'pane',
    { info: (message) => write(dim(message)) },
    { restart: () => requestRestart() },
  )
  const session = new AgentSession({
    paneId,
    cwd: process.cwd(),
    permissionMode: parsed.permissionMode,
    env: process.env,
    ...(parsed.configDir ? { configDir: parsed.configDir } : {}),
    ...(parsed.resume ? { resume: parsed.resume } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.effort ? { effort: parsed.effort } : {}),
    ...(parsed.bypassAllowed ? { bypassAllowed: true } : {}),
    ...(claudePath ? { claudePath } : {}),
    ...(parsed.prompt ? { initialPrompt: parsed.prompt } : {}),
    ...(resumeCommand ? { resumeCommand } : {}),
    ...(hostBuild ? { hostBuild } : {}),
    log: (message) => write(dim(message)),
  })

  const printed = new Map<string, string>()
  session.on('items', (items) => {
    for (const item of items) {
      const line = terminalLine(item)
      if (!line || printed.get(item.id) === line) continue
      printed.set(item.id, line)
      write(line)
    }
  })
  let title = ''
  session.on('session', (info) => {
    const next = info.title ? `✳ ${info.title}` : ''
    if (next && next !== title) {
      title = next
      process.stdout.write(terminalTitle(next))
    }
    settings = withSessionSettings(parsed, info)
    if (launcher) session.setResumeCommand(chatResumeCommand(launcher, settings))
  })
  session.on('closed', () => {
    const { session: info } = session.snapshot()
    write(color(31, `Session ended${info.error ? `: ${info.error}` : ''}. Press Ctrl-C twice to quit.`))
  })
  host.add(session)
  write(dim(`Commando chat · Claude${parsed.configDir ? ` (${parsed.configDir.replace(homedir(), '~')})` : ''} · ${process.cwd().replace(homedir(), '~')}`))
  write(dim('Type here or in the Commando chat. Ctrl-C interrupts a turn; press it twice to quit.'))
  void session.start()
  host.start()

  // Restart on the same conversation (to pick up new host code) once Claude is idle.
  let restarting = false
  const restartNow = async () => {
    const sessionId = session.snapshot().session.sessionId
    if (!launcher) {
      write(color(31, 'Restart needs the commando-agent launcher; quit and start it again instead.'))
      restarting = false
      return
    }
    // tmux replaces this process with a fresh host in the same pane (same pane id
    // and Commando target), continuing the same conversation. Nothing is closed
    // first: on success -k ends this process, on failure this host keeps going.
    const command = ['exec', launcher, 'claude', ...sessionFlags(settings), ...(sessionId ? ['--resume', sessionId] : [])]
      .map((word, index) => index === 0 ? word : shellQuote(word)).join(' ')
    // The tmux server's environment can differ from this host's (a dev daemon on
    // another port), so carry the variables that find the daemon.
    const env = DAEMON_ENV_KEYS.flatMap((key) => process.env[key] ? ['-e', `${key}=${process.env[key]}`] : [])
    write(dim('Restarting to update…'))
    execFile('tmux', ['respawn-pane', '-k', ...env, '-t', paneId, '-c', process.cwd(), command], (error) => {
      if (!error) return
      write(color(31, `Restart failed: ${error.message}. The chat keeps running; quit and start commando-agent again to update.`))
      restarting = false
    })
  }
  const requestRestart = () => {
    if (restarting) return
    restarting = true
    if (!session.busy) return void restartNow()
    write(dim('Will restart to update when this turn finishes.'))
    session.on('session', (info) => {
      if (restarting && info.status === 'idle') void restartNow()
    })
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
  let lastInterrupt = 0
  const quit = () => {
    session.close()
    host.remove(paneId)
    setTimeout(() => {
      host.stop()
      process.exit(0)
    }, 100)
  }
  prompt.on('line', (line) => session.send(line))
  prompt.on('SIGINT', () => {
    const now = Date.now()
    if (now - lastInterrupt < 1500) return quit()
    lastInterrupt = now
    write(dim('Interrupting… (Ctrl-C again to quit)'))
    void session.interrupt()
  })
  prompt.on('close', quit)
  process.on('SIGTERM', quit)
  process.on('SIGHUP', quit)
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  void main()
}

import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_HOST_WS_PATH, isPaneId, type ChatItem } from '../../shared/agent-chat.js'
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
  --permission-mode MODE           default | acceptEdits | plan | auto | dontAsk | bypassPermissions
  --dangerously-skip-permissions   Same as --permission-mode bypassPermissions
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
  permissionMode: PermissionMode
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
    const needValue = () => {
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      index += 1
      return value
    }
    try {
      switch (flag) {
        case '--config-dir': args.configDir = expandHome(needValue()); break
        case '--resume': args.resume = needValue(); break
        case '--model': args.model = needValue(); break
        case '--claude-path': args.claudePath = expandHome(needValue()); break
        case '--prompt': args.prompt = needValue(); break
        case '--dangerously-skip-permissions': args.permissionMode = 'bypassPermissions'; break
        case '--permission-mode': {
          const mode = needValue()
          if (!PERMISSION_MODES.has(mode)) return `Unknown permission mode: ${mode}\n\n${USAGE}`
          args.permissionMode = mode as PermissionMode
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

/** Exit code the launcher reads as "start me again with the restart file's arguments". */
const RESTART_EXIT_CODE = 75

/** The flags that recreate this chat pane's session settings (no prompt, no resume target). */
export function sessionFlags(args: HostArgs): string[] {
  return [
    ...(args.configDir ? ['--config-dir', args.configDir] : []),
    ...(args.model ? ['--model', args.model] : []),
    '--permission-mode', args.permissionMode,
    ...(args.claudePath ? ['--claude-path', args.claudePath] : []),
  ]
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
  const hostBuild = await agentHostBuild().catch(() => undefined)

  const write = (line: string) => process.stdout.write(`${line}\n`)
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
    ...(claudePath ? { claudePath } : {}),
    ...(parsed.prompt ? { initialPrompt: parsed.prompt } : {}),
    ...(resumeCommand ? { resumeCommand } : {}),
    ...(hostBuild ? { hostBuild } : {}),
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
    const restartFile = process.env.COMMANDO_AGENT_RESTART_FILE
    if (!restartFile) {
      write(color(31, 'Restart needs the commando-agent launcher; quit and start it again instead.'))
      restarting = false
      return
    }
    const argv = ['claude', ...sessionFlags(parsed), ...(sessionId ? ['--resume', sessionId] : [])]
    await writeFile(restartFile, argv.map(shellQuote).join(' '), { mode: 0o600 })
    write(dim('Restarting to update…'))
    session.close()
    host.stop()
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 100)
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

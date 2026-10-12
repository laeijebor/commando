import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { AGENT_HOST_WS_PATH, isChatEffort, isChatPermissionMode, isModelValue, isPaneId, type ChatEffort, type ChatItem, type ChatSessionInfo, type ChatSessionPermissionMode } from '../../shared/agent-chat.js'
import { shellQuote } from '../agent-resume-command.js'
import { ChatImageStore } from '../chat-images.js'
import { isChatPlanDir } from '../chat-plans-dir.js'
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
  --pre-plan-permission-mode MODE  In plan mode: the mode Implement returns to
  --dangerously-skip-permissions   Same as --permission-mode bypassPermissions
  --allow-dangerously-skip-permissions
                                   Allow switching to bypassPermissions later in the chat
  --claude-path PATH               Claude Code executable (default: claude on PATH)
  --readable-dir DIR               Let Claude read DIR without asking (a stashed plan's folder only)
  --prompt TEXT                    Send TEXT as the first message
  --from-claude-code               Claude Code just handed this conversation back (Commando's switch)
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
  /** In plan mode, the mode the chat had before it; Implement returns to it. */
  prePlanPermissionMode?: ChatSessionPermissionMode
  /** The chat may switch to bypassPermissions (it was started with it). */
  bypassAllowed?: boolean
  claudePath?: string
  /** A stashed plan's folder this chat (only) may read. */
  readableDir?: string
  prompt?: string
  /** Started by Commando's switch when Claude Code exited; never carried into restarts. */
  fromClaudeCode?: boolean
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
        case '--readable-dir': {
          const dir = needValue()
          if (!isChatPlanDir(dir, env)) return `--readable-dir must be a stashed plan's folder: ${dir}\n\n${USAGE}`
          args.readableDir = dir
          break
        }
        case '--prompt': args.prompt = needValue(true); break
        case '--from-claude-code': args.fromClaudeCode = true; break
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
        case '--pre-plan-permission-mode': {
          const mode = needValue()
          if (!isChatPermissionMode(mode) || mode === 'plan') return `Unknown pre-plan permission mode: ${mode}\n\n${USAGE}`
          args.prePlanPermissionMode = mode
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
const DAEMON_ENV_KEYS = ['COMMANDO_PORT', 'COMMANDO_AGENT_HOOK_TOKEN_PATH', 'COMMANDO_TMUX_SOCKET_NAME', 'COMMANDO_TMUX_SOCKET_PATH', 'COMMANDO_CHAT_IMAGES_DIR', 'COMMANDO_CHAT_PLANS_DIR'] as const

/** The flags that recreate this chat pane's session settings (no prompt, no resume target). */
export function sessionFlags(args: HostArgs): string[] {
  return [
    ...(args.configDir ? ['--config-dir', args.configDir] : []),
    ...(args.model ? ['--model', args.model] : []),
    ...(args.effort ? ['--effort', args.effort] : []),
    '--permission-mode', args.permissionMode,
    ...(args.bypassAllowed && args.permissionMode !== 'bypassPermissions' ? ['--allow-dangerously-skip-permissions'] : []),
    ...(args.claudePath ? ['--claude-path', args.claudePath] : []),
    // The plan it started from stays readable after a restart or resume.
    ...(args.readableDir ? ['--readable-dir', args.readableDir] : []),
    // Only plan mode returns to it; out of plan mode it is stale. Last, so a
    // daemon that doesn't know it still reads every flag before it.
    ...(args.permissionMode === 'plan' && args.prePlanPermissionMode ? ['--pre-plan-permission-mode', args.prePlanPermissionMode] : []),
  ]
}

/**
 * The launch arguments updated with what the chat's pickers changed, so a
 * restart or resume keeps this chat's model, effort and mode.
 */
export function withSessionSettings(args: HostArgs, info: ChatSessionInfo): HostArgs {
  const { model: _model, effort: _effort, prePlanPermissionMode: _prePlan, ...rest } = args
  return {
    ...rest,
    ...(info.selectedModel ? { model: info.selectedModel } : {}),
    ...(info.effort ? { effort: info.effort } : {}),
    ...(info.prePlanPermissionMode ? { prePlanPermissionMode: info.prePlanPermissionMode } : {}),
    permissionMode: info.permissionMode && PERMISSION_MODES.has(info.permissionMode) ? info.permissionMode as PermissionMode : args.permissionMode,
  }
}

/**
 * Claude Code's own flags for this chat's settings, so the TUI runs the
 * conversation with the same model, effort and permission mode.
 */
export function claudeCodeFlags(args: HostArgs): string[] {
  return [
    ...(args.model ? ['--model', args.model] : []),
    ...(args.effort ? ['--effort', args.effort] : []),
    ...(args.permissionMode === 'bypassPermissions'
      ? ['--dangerously-skip-permissions']
      : ['--permission-mode', args.permissionMode, ...(args.bypassAllowed ? ['--allow-dangerously-skip-permissions'] : [])]),
    ...(args.readableDir ? ['--add-dir', args.readableDir] : []),
  ]
}

/**
 * The pane command for a switch to Claude Code: the TUI on the same
 * conversation, then (when it exits, however it exits) this chat again.
 * bash runs it with job control, so Claude Code is the pane's foreground
 * process: tmux names the pane after it (auto-resume needs that to see an
 * agent, not a shell), and Ctrl-C reaches only Claude Code.
 */
export function claudeCodeSwitchCommand(args: HostArgs, claudePath: string, launcher: string, sessionId: string): string {
  const tui = [claudePath, ...claudeCodeFlags(args), '--resume', sessionId].map(shellQuote).join(' ')
  const back = ['exec', ...[launcher, 'claude', ...sessionFlags(args), '--resume', sessionId, '--from-claude-code'].map(shellQuote)].join(' ')
  return `exec /bin/bash -c ${shellQuote(`set -m; ${tui}; ${back}`)}`
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
    case 'user_message': {
      const images = item.images?.length ? dim(` (${item.images.length} image${item.images.length === 1 ? '' : 's'})`) : ''
      return `${color(35, '›')} ${bold(item.text)}${images}`
    }
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
    case 'plan': return `${color(36, '▤')} ${bold('Plan ready')} ${dim('(Implement or Refine in Commando)')}\n${item.text}`
    case 'subagent': return dim(`  ⑂ ${item.description}${item.subagentType ? ` (${item.subagentType})` : ''}: ${item.state}`)
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

  // A plan folder pruned since this chat started (after 30 days) isn't handed to Claude.
  const readableDir = parsed.readableDir && existsSync(parsed.readableDir) ? parsed.readableDir : undefined
  if (parsed.readableDir && !readableDir) write(dim(`The plan this chat started from is no longer saved (${parsed.readableDir}).`))
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
    ...(parsed.prePlanPermissionMode ? { prePlanPermissionMode: parsed.prePlanPermissionMode } : {}),
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
    images: new ChatImageStore(undefined, (message) => write(dim(message))),
    ...(readableDir ? { readableDirectories: [readableDir] } : {}),
    log: (message) => write(dim(message)),
    ...(parsed.fromClaudeCode ? { returnedFromClaudeCode: true } : {}),
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
  let switching = false
  session.on('closed', () => {
    if (switching) return
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
  /**
   * Hands the conversation to Claude Code in this pane. The daemon keeps the
   * queue first; then this session ends, so Claude Code is the only process
   * writing the transcript, and tmux replaces this host with the TUI. When the
   * TUI exits, the pane command brings this chat back on the same conversation.
   */
  const switchToClaudeCode = async (): Promise<void> => {
    const sessionId = session.snapshot().session.sessionId
    if (!launcher || !claudePath || !sessionId) {
      throw new Error(!sessionId
        ? 'this chat has no conversation yet'
        : "this host was started without the commando-agent launcher or can't find claude")
    }
    const saved = await host.handoff({ type: 'handoff', paneId, sessionId, cwd: process.cwd(), queue: session.queued, returnFlags: sessionFlags(settings) })
    if (!saved.ok) throw new Error(saved.error ?? "Commando couldn't keep the chat's queue and draft")
    switching = true
    write(dim('Switching to Claude Code…'))
    const ended = new Promise<boolean>((resolve) => session.on('closed', () => resolve(true)))
    session.handOver()
    // The SDK's Claude process exits before the TUI starts on the same transcript.
    if (!await Promise.race([ended, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))])) {
      write(color(31, "Claude didn't stop within 10 s; starting Claude Code anyway."))
    }
    const env = [
      ...DAEMON_ENV_KEYS.flatMap((key) => process.env[key] ? ['-e', `${key}=${process.env[key]}`] : []),
      ...(settings.configDir ? ['-e', `CLAUDE_CONFIG_DIR=${settings.configDir}`] : []),
    ]
    await new Promise<void>((resolve, reject) => {
      execFile('tmux', ['respawn-pane', '-k', ...env, '-t', paneId, '-c', process.cwd(), claudeCodeSwitchCommand(settings, claudePath, launcher, sessionId)], (error) => (error ? reject(error) : resolve()))
    })
  }
  session.on('switchReady', () => {
    switchToClaudeCode().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      // Once the session has ended, its queue and draft are kept and come back with the chat.
      const reason = switching
        ? `Couldn't start Claude Code: ${message}. Quit (Ctrl-C twice) and start commando-agent again with --resume ${session.snapshot().session.sessionId}.`
        : `Couldn't switch to Claude Code: ${message}.`
      write(color(31, reason))
      session.endSwitch(reason)
    })
  })

  const requestRestart = () => {
    if (restarting) return
    restarting = true
    if (!session.busy) return void restartNow()
    write(dim('Will restart to update when this turn finishes.'))
    session.on('session', (info) => {
      // Queued messages go out when a turn ends; wait until they have been answered too.
      if (restarting && info.status === 'idle' && !session.busy) void restartNow()
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

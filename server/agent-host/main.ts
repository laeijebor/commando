import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { AGENT_HOST_WS_PATH, isChatEffort, isChatPermissionMode, isModelValue, isPaneId, type ChatEffort, type ChatItem, type ChatProvider, type ChatSessionInfo, type ChatSessionPermissionMode } from '../../shared/agent-chat.js'
import { shellQuote } from '../agent-resume-command.js'
import { ChatImageStore } from '../chat-images.js'
import { isChatPlanDir } from '../chat-plans-dir.js'
import { agentHostBuild } from './build.js'
import { AgentHost } from './host.js'
import { createChatProviderSession } from './factory.js'
import type { ChatProviderSession } from './provider.js'
import { claudeCodeSwitchCommand as providerSwitchCommand } from './session.js'

export { claudeCodeFlags } from './session.js'

const USAGE = `Usage: commando-agent <claude|codex> [options]

Runs a provider session in this tmux pane and shows it as a chat in Commando.
Codex uses the local codex app-server and its existing login.

Options:
  --config-dir DIR                 Claude config dir (default: $CLAUDE_CONFIG_DIR)
  --resume ID                      Resume an existing provider session
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
  provider: ChatProvider
  configDir?: string
  resume?: string
  model?: string
  effort?: ChatEffort
  permissionMode: ChatSessionPermissionMode
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
  if (provider !== 'claude' && provider !== 'codex') return USAGE
  const args: HostArgs = { provider, permissionMode: 'default' }
  if (provider === 'claude' && env.CLAUDE_CONFIG_DIR) args.configDir = expandHome(env.CLAUDE_CONFIG_DIR)
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
          args.permissionMode = mode as ChatSessionPermissionMode
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
const DAEMON_ENV_KEYS = ['COMMANDO_PORT', 'COMMANDO_AGENT_HOOK_TOKEN_PATH', 'COMMANDO_TMUX_SOCKET_NAME', 'COMMANDO_TMUX_SOCKET_PATH', 'COMMANDO_CHAT_IMAGES_DIR', 'COMMANDO_CHAT_PLANS_DIR', 'ARGENT_SIMULATOR_NO_WINDOW'] as const

/** Preserve pane-local daemon settings and the Codex account/config on restart. */
export function restartEnv(provider: ChatProvider, env: Record<string, string | undefined>): string[] {
  const keys = provider === 'codex' ? [...DAEMON_ENV_KEYS, 'CODEX_HOME'] : DAEMON_ENV_KEYS
  return keys.flatMap((key) => env[key] ? ['-e', `${key}=${env[key]}`] : [])
}

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
    permissionMode: info.permissionMode && PERMISSION_MODES.has(info.permissionMode) ? info.permissionMode as ChatSessionPermissionMode : args.permissionMode,
  }
}

/** Kept for callers that build a Claude Code command from host arguments. */
export function claudeCodeSwitchCommand(args: HostArgs, claudePath: string, launcher: string, sessionId: string): string {
  return providerSwitchCommand(args, claudePath, launcher, sessionId, sessionFlags(args))
}

/** The command that resumes a conversation as a chat pane; hooks append `--resume <id>`. */
export function chatResumeCommand(launcher: string, args: HostArgs): string {
  return [launcher, args.provider, ...sessionFlags(args)].map(shellQuote).join(' ')
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
  let session: ChatProviderSession
  try {
    session = await createChatProviderSession(parsed.provider, {
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
      ...(parsed.claudePath ? { claudePath: parsed.claudePath } : {}),
      ...(parsed.prompt ? { initialPrompt: parsed.prompt } : {}),
      ...(resumeCommand ? { resumeCommand } : {}),
      ...(hostBuild ? { hostBuild } : {}),
      images: new ChatImageStore(undefined, (message) => write(dim(message))),
      ...(readableDir ? { readableDirectories: [readableDir] } : {}),
      log: (message) => write(dim(message)),
      ...(parsed.fromClaudeCode ? { returnedFromClaudeCode: true } : {}),
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }

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
  write(dim(`Commando chat · ${parsed.provider === 'claude' ? 'Claude' : 'Codex'}${parsed.configDir ? ` (${parsed.configDir.replace(homedir(), '~')})` : ''} · ${process.cwd().replace(homedir(), '~')}`))
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
    const command = ['exec', launcher, settings.provider, ...sessionFlags(settings), ...(sessionId ? ['--resume', sessionId] : [])]
      .map((word, index) => index === 0 ? word : shellQuote(word)).join(' ')
    // The tmux server's environment can differ from this host's (a dev daemon on
    // another port or Codex account), so carry the daemon and provider settings.
    const env = restartEnv(settings.provider, process.env)
    write(dim('Restarting to update…'))
    execFile('tmux', ['respawn-pane', '-k', ...env, '-t', paneId, '-c', process.cwd(), command], (error) => {
      if (!error) return
      write(color(31, `Restart failed: ${error.message}. The chat keeps running; quit and start commando-agent again to update.`))
      restarting = false
    })
  }
  /** The daemon keeps the queue before the provider hands its conversation to its TUI. */
  const tui = session.tui
  const switchToTui = async (): Promise<void> => {
    if (!tui) return
    const sessionId = session.snapshot().session.sessionId
    // Validate the provider's launch prerequisites before saving or ending anything.
    tui.command(launcher, sessionFlags(settings), sessionId)
    const saved = await host.handoff({ type: 'handoff', paneId, provider: session.snapshot().session.provider, sessionId: sessionId!, cwd: process.cwd(), queue: session.queued, returnFlags: sessionFlags(settings) })
    if (!saved.ok) throw new Error(saved.error ?? "Commando couldn't keep the chat's queue and draft")
    switching = true
    write(dim(`Switching to ${tui.label}…`))
    const ended = new Promise<boolean>((resolve) => session.on('closed', () => resolve(true)))
    tui.handOver()
    // The provider process exits before the TUI starts on the same transcript.
    if (!await Promise.race([ended, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))])) {
      write(color(31, `${parsed.provider === 'claude' ? 'Claude' : 'Codex'} didn't stop within 10 s; starting ${tui.label} anyway.`))
    }
    const env = [
      ...DAEMON_ENV_KEYS.flatMap((key) => process.env[key] ? ['-e', `${key}=${process.env[key]}`] : []),
      ...Object.entries(tui.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ]
    await new Promise<void>((resolve, reject) => {
      execFile('tmux', ['respawn-pane', '-k', ...env, '-t', paneId, '-c', process.cwd(), tui.command(launcher, sessionFlags(settings), sessionId)], (error) => (error ? reject(error) : resolve()))
    })
  }
  tui?.onReady(() => {
    switchToTui().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      // Once the session has ended, its queue and draft are kept and come back with the chat.
      const reason = switching
        ? `Couldn't start ${tui.label}: ${message}. Quit (Ctrl-C twice) and start commando-agent again with --resume ${session.snapshot().session.sessionId}.`
        : `Couldn't switch to ${tui.label}: ${message}.`
      write(color(31, reason))
      tui.endSwitch(reason)
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
  let quitting = false
  const quit = () => {
    if (quitting) return
    quitting = true
    const ended = parsed.provider === 'codex' ? new Promise<void>((resolve) => session.on('closed', resolve)) : undefined
    session.close()
    host.remove(paneId)
    const exit = () => { host.stop(); process.exit(0) }
    if (ended) void Promise.race([ended, new Promise<void>((resolve) => setTimeout(resolve, 2000))]).then(exit)
    else setTimeout(exit, 100)
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

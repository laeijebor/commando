import type { AgentStatus } from '../shared/protocol.js'
import { buildChatReturnCommand, findAgentProcess, findChatHost, isShellCommand, parseProcessTable } from './agent-resume-command.js'
import type { ChatHandoff } from './chat-handoffs.js'

/** How long Claude Code gets to exit, and then the chat to come back by itself. */
const EXIT_TIMEOUT_MS = 10_000
const CHAT_START_MS = 4_000
const POLL_MS = 100

export type ChatReturnDeps = {
  /** The pane's process id, read fresh from tmux (respawns change it). */
  panePid: (paneId: string) => Promise<number | undefined>
  /** The pane's foreground command, read fresh from tmux. */
  paneCommand: (paneId: string) => Promise<string | undefined>
  status: (paneId: string) => AgentStatus | undefined
  /** A chat conversation now in Claude Code. */
  handoff: (sessionId: string) => ChatHandoff | undefined
  /** Codex can return before its TUI has emitted its first notify hook. */
  handoffForPane?: (paneId: string) => ChatHandoff | undefined
  /** True while a chat host drives the pane. */
  chatOwnsPane: (paneId: string) => boolean
  readProcessTable: () => Promise<string>
  signal: (pid: number, signal: NodeJS.Signals | 0) => void
  /** The command that resumes the chat, for a pane left at a shell. */
  returnCommand: (handoff: ChatHandoff) => string | null
  /** Types a command into the pane's shell and presses Enter. */
  sendCommand: (paneId: string, command: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function chatReturnCommand(handoff: ChatHandoff, launcher: string, env: Readonly<Record<string, string>> = {}): string | null {
  return buildChatReturnCommand(handoff.sessionId, launcher, handoff.returnFlags, env, handoff.provider ?? 'claude')
}

/**
 * Brings back the chat a conversation was switched from. Claude Code is asked
 * to exit (SIGTERM, which it handles like /exit, whatever screen it shows) only
 * while it is idle. The pane command a switch starts runs the chat once
 * Claude Code exits; a pane left at a shell gets the chat typed in instead.
 * Returns why it can't, or null.
 */
export async function returnToChat(deps: ChatReturnDeps, paneId: string): Promise<string | null> {
  const sleep = deps.sleep ?? defaultSleep
  if (deps.chatOwnsPane(paneId)) return 'This pane already shows the chat'
  const status = deps.status(paneId)
  const sessionId = status?.provider === 'claude' || status?.provider === 'codex' ? status.agentSessionId : undefined
  const paneHandoff = deps.handoffForPane?.(paneId)
  const handoff = (paneHandoff?.provider === 'codex' ? paneHandoff : undefined) ?? (sessionId ? deps.handoff(sessionId) : undefined)
  const provider = handoff?.provider ?? 'claude'
  const label = provider === 'codex' ? 'Codex TUI' : 'Claude Code'
  if (!handoff || handoff.returnedAt !== undefined || (provider === 'claude' && status?.provider !== 'claude')) return `This pane isn't running ${label} on a chat's conversation`
  const matchingStatus = status?.provider === provider && status.agentSessionId === handoff.sessionId ? status : undefined
  if (matchingStatus?.status === 'working') return `${label} is working. Switch back to the chat once it finishes.`
  if (matchingStatus?.status === 'needs_input') return `${label} is waiting for an answer. Answer it, then switch back to the chat.`
  const panePid = await deps.panePid(paneId)
  if (!panePid) return 'The pane is gone'
  const rows = parseProcessTable(await deps.readProcessTable())
  if (findChatHost(rows, panePid)) return 'This pane already runs the chat'
  const agent = findAgentProcess(rows, panePid, provider)
  if (!agent) return `Couldn't find ${label} in this pane`
  if (provider === 'codex' && !agent.args.split(/\s+/).includes(handoff.sessionId)) return "This pane isn't running Codex TUI on a chat's conversation"
  try {
    deps.signal(agent.pid, 'SIGTERM')
  } catch (error) {
    return `Couldn't ask ${label} to exit: ${error instanceof Error ? error.message : String(error)}`
  }
  const alive = () => {
    try {
      deps.signal(agent.pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let waited = 0; alive(); waited += POLL_MS) {
    if (waited >= EXIT_TIMEOUT_MS) return `${label} didn't exit. Type /exit in the pane to return to the chat.`
    await sleep(POLL_MS)
  }
  // A switch's pane command starts the chat by itself; give it a moment.
  for (let waited = 0; waited < CHAT_START_MS; waited += POLL_MS) {
    if (deps.chatOwnsPane(paneId)) return null
    const command = await deps.paneCommand(paneId)
    if (command && !isShellCommand(command)) return null
    await sleep(POLL_MS)
  }
  const command = deps.returnCommand(handoff)
  if (!command) return `${label} exited, but Commando couldn't build the command that resumes the chat`
  // The chat may have started just now; typed into it, the command would go to Claude as a message.
  const current = await deps.paneCommand(paneId)
  if (deps.chatOwnsPane(paneId) || (current && !isShellCommand(current))) return null
  try {
    await deps.sendCommand(paneId, command)
  } catch (error) {
    return `${label} exited, but the chat didn't start: ${error instanceof Error ? error.message : String(error)}`
  }
  return null
}

import type { WebSocket } from 'ws'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  mergeChatItems,
  parseHostMessage,
  type ChatAnswer,
  type ChatItem,
  type ChatState,
  type DaemonToHostMessage,
  type HostToDaemonMessage,
} from '../shared/agent-chat.js'
import type { ServerMessage } from '../shared/protocol.js'

const MAX_HOST_MESSAGE_BYTES = 4 * 1024 * 1024
/** How long a session may wait for its pane to appear in the tmux snapshot. */
const PENDING_PANE_MS = 60_000
/** How long a chat stays after its host disconnects (a host restart or daemon blip). */
const DISCONNECTED_GRACE_MS = 60_000

type HubDependencies = {
  paneExists: (paneId: string) => boolean
  targetIdFor: (paneId: string) => string | undefined
  broadcast: (message: ServerMessage) => void
  /**
   * Confirms the host process runs inside the pane it claims, so a process
   * that merely holds the hook token cannot take over another pane's chat.
   */
  verifyHost?: (paneId: string, hostPid: number) => Promise<boolean>
  log?: (message: string) => void
  now?: () => number
}

type ChatEntry = {
  state: ChatState
  socket: WebSocket | null
  /**
   * False until the pane shows up in the tmux snapshot and the host is
   * verified. After a daemon restart a host can reconnect before the first
   * snapshot, so its session waits here instead of being dropped.
   */
  visible: boolean
  receivedAt: number
  disconnectedAt?: number
}

/**
 * Daemon side of chat panes. Agent hosts run inside tmux panes and connect
 * here; the hub keeps each pane's session and items so a browser that joins
 * late (or after a daemon restart, once the host reconnects) gets the whole
 * conversation, and routes the browser's sends, interrupts and answers back.
 */
export class AgentHostHub {
  private readonly chats = new Map<string, ChatEntry>()

  constructor(private readonly dependencies: HubDependencies) {}

  connect(socket: WebSocket): void {
    // Messages are applied in order, even while a snapshot waits on verification.
    let queue = Promise.resolve()
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      const raw = data.toString()
      if (raw.length > MAX_HOST_MESSAGE_BYTES) return
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return
      }
      const message = parseHostMessage(parsed)
      if (!message) return
      queue = queue.then(() => this.handle(socket, message)).catch((error: unknown) => {
        this.dependencies.log?.(`[agent-host] message failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    socket.on('close', () => {
      for (const [paneId, entry] of this.chats) {
        if (entry.socket !== socket) continue
        entry.socket = null
        if (!entry.visible) {
          this.chats.delete(paneId)
          continue
        }
        entry.disconnectedAt = this.now()
        entry.state = { ...entry.state, hostConnected: false }
        this.dependencies.broadcast({ type: 'chat_session', paneId, session: entry.state.session, hostConnected: false })
      }
    })
  }

  private async handle(socket: WebSocket, message: HostToDaemonMessage): Promise<void> {
    switch (message.type) {
      case 'hello':
        if (message.version !== AGENT_HOST_PROTOCOL_VERSION) {
          this.dependencies.log?.(`[agent-host] host ${message.hostId} speaks protocol ${message.version}; daemon speaks ${AGENT_HOST_PROTOCOL_VERSION}`)
        }
        this.sendTo(socket, { type: 'welcome', version: AGENT_HOST_PROTOCOL_VERSION })
        return
      case 'session_snapshot': {
        const { paneId } = message.session
        const known = this.dependencies.paneExists(paneId)
        if (known && !(await this.verified(paneId, message.session.hostPid))) {
          socket.close()
          return
        }
        if (socket.readyState !== socket.OPEN) return
        const previous = this.chats.get(paneId)
        // A newer host for the same pane replaces the old link.
        if (previous?.socket && previous.socket !== socket) previous.socket.close()
        const targetId = this.dependencies.targetIdFor(paneId)
        const state: ChatState = {
          paneId,
          ...(targetId ? { targetId } : {}),
          session: message.session,
          items: mergeChatItems([], message.items),
          hostConnected: true,
        }
        this.chats.set(paneId, { state, socket, visible: known, receivedAt: this.now() })
        if (known) this.dependencies.broadcast({ type: 'chat_state', chat: state })
        return
      }
      case 'session_update': {
        const entry = this.owned(socket, message.session.paneId)
        if (!entry || message.session.hostPid !== entry.state.session.hostPid) return
        entry.state = { ...entry.state, session: message.session }
        if (entry.visible) this.dependencies.broadcast({ type: 'chat_session', paneId: message.session.paneId, session: message.session, hostConnected: true })
        return
      }
      case 'items': {
        const entry = this.owned(socket, message.paneId)
        if (!entry || message.items.length === 0) return
        entry.state = { ...entry.state, items: mergeChatItems(entry.state.items, message.items) }
        if (entry.visible) this.dependencies.broadcast({ type: 'chat_items', paneId: message.paneId, items: message.items })
        return
      }
      case 'session_closed':
        if (!this.owned(socket, message.paneId)) return
        this.remove(message.paneId)
    }
  }

  states(): ChatState[] {
    return [...this.chats.values()].filter((entry) => entry.visible).map((entry) => entry.state)
  }

  /**
   * True while a host drives this pane's agent, including the moments after a
   * daemon restart before the pane reappears, so hooks never hold its prompts.
   */
  owns(paneId: string): boolean {
    return this.chats.get(paneId)?.socket != null
  }

  items(paneId: string): ChatItem[] {
    return this.chats.get(paneId)?.state.items ?? []
  }

  send(paneId: string, text: string, requestId: string): boolean {
    return this.toHost(paneId, { type: 'send', paneId, text, requestId })
  }

  interrupt(paneId: string, requestId: string): boolean {
    return this.toHost(paneId, { type: 'interrupt', paneId, requestId })
  }

  answer(paneId: string, chatRequestId: string, answer: ChatAnswer, requestId: string): boolean {
    const request = this.chats.get(paneId)?.state.items.find((item) => item.kind === 'request' && item.requestId === chatRequestId)
    if (!request || request.kind !== 'request' || request.answer) return false
    return this.toHost(paneId, { type: 'answer', paneId, chatRequestId, answer, requestId })
  }

  /**
   * Runs after each tmux snapshot: shows sessions whose pane has appeared,
   * drops chats whose pane or host is gone, and refreshes target ids.
   */
  async reconcile(): Promise<void> {
    const now = this.now()
    for (const [paneId, entry] of [...this.chats]) {
      if (!this.dependencies.paneExists(paneId)) {
        if (!entry.visible && now - entry.receivedAt < PENDING_PANE_MS) continue
        entry.socket?.close()
        this.remove(paneId)
        continue
      }
      if (!entry.socket && entry.disconnectedAt !== undefined && now - entry.disconnectedAt > DISCONNECTED_GRACE_MS) {
        this.remove(paneId)
        continue
      }
      if (!entry.visible) {
        if (!entry.socket) continue
        if (!(await this.verified(paneId, entry.state.session.hostPid))) {
          entry.socket.close()
          this.chats.delete(paneId)
          continue
        }
        if (this.chats.get(paneId) !== entry) continue
        entry.visible = true
      } else {
        const targetId = this.dependencies.targetIdFor(paneId)
        if (!targetId || targetId === entry.state.targetId) continue
      }
      const targetId = this.dependencies.targetIdFor(paneId)
      entry.state = { ...entry.state, ...(targetId ? { targetId } : {}) }
      this.dependencies.broadcast({ type: 'chat_state', chat: entry.state })
    }
  }

  private async verified(paneId: string, hostPid: number): Promise<boolean> {
    if (!this.dependencies.verifyHost) return true
    try {
      if (await this.dependencies.verifyHost(paneId, hostPid)) return true
    } catch {
      // fall through: an unverifiable host is refused
    }
    this.dependencies.log?.(`[agent-host] refused host pid ${hostPid}: it does not run in pane ${paneId}`)
    return false
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  /** The pane's entry, only while this socket is still its host. */
  private owned(socket: WebSocket, paneId: string): ChatEntry | undefined {
    const entry = this.chats.get(paneId)
    return entry?.socket === socket ? entry : undefined
  }

  private remove(paneId: string): void {
    const entry = this.chats.get(paneId)
    if (!entry) return
    this.chats.delete(paneId)
    if (entry.visible) this.dependencies.broadcast({ type: 'chat_removed', paneId })
  }

  private toHost(paneId: string, message: DaemonToHostMessage): boolean {
    const socket = this.chats.get(paneId)?.socket
    return socket ? this.sendTo(socket, message) : false
  }

  private sendTo(socket: WebSocket, message: DaemonToHostMessage): boolean {
    if (socket.readyState !== socket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }
}

/** True when `hostPid` is the pane's process or one of its descendants. */
export function hostRunsInPane(rows: readonly { pid: number; ppid: number }[], hostPid: number, panePid: number): boolean {
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]))
  let pid: number | undefined = hostPid
  for (let depth = 0; pid !== undefined && pid > 1 && depth < 16; depth += 1) {
    if (pid === panePid) return true
    pid = parent.get(pid)
  }
  return false
}

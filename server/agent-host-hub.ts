import type { WebSocket } from 'ws'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  mergeChatItems,
  parseHostMessage,
  type ChatAnswer,
  type ChatItem,
  type ChatState,
  type DaemonToHostMessage,
} from '../shared/agent-chat.js'
import type { ServerMessage } from '../shared/protocol.js'

const MAX_HOST_MESSAGE_BYTES = 4 * 1024 * 1024

type HubDependencies = {
  paneExists: (paneId: string) => boolean
  targetIdFor: (paneId: string) => string | undefined
  broadcast: (message: ServerMessage) => void
  log?: (message: string) => void
  now?: () => number
}

type ChatEntry = {
  state: ChatState
  socket: WebSocket | null
  /**
   * False until the pane shows up in the tmux snapshot. After a daemon restart
   * a host can reconnect before the first snapshot, so its session waits here
   * instead of being dropped.
   */
  visible: boolean
  receivedAt: number
}

const PENDING_PANE_MS = 60_000

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
    const owned = new Set<string>()
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
      switch (message.type) {
        case 'hello':
          if (message.version !== AGENT_HOST_PROTOCOL_VERSION) {
            this.dependencies.log?.(`[agent-host] host ${message.hostId} speaks protocol ${message.version}; daemon speaks ${AGENT_HOST_PROTOCOL_VERSION}`)
          }
          this.sendTo(socket, { type: 'welcome', version: AGENT_HOST_PROTOCOL_VERSION })
          return
        case 'session_snapshot': {
          const { paneId } = message.session
          const visible = this.dependencies.paneExists(paneId)
          const previous = this.chats.get(paneId)
          // A newer host for the same pane replaces the old link.
          if (previous?.socket && previous.socket !== socket) previous.socket.close()
          owned.add(paneId)
          const targetId = this.dependencies.targetIdFor(paneId)
          const state: ChatState = {
            paneId,
            ...(targetId ? { targetId } : {}),
            session: message.session,
            items: mergeChatItems([], message.items),
            hostConnected: true,
          }
          this.chats.set(paneId, { state, socket, visible, receivedAt: this.now() })
          if (visible) this.dependencies.broadcast({ type: 'chat_state', chat: state })
          return
        }
        case 'session_update': {
          const entry = this.owned(owned, message.session.paneId)
          if (!entry) return
          entry.state = { ...entry.state, session: message.session }
          if (entry.visible) this.dependencies.broadcast({ type: 'chat_session', paneId: message.session.paneId, session: message.session, hostConnected: true })
          return
        }
        case 'items': {
          const entry = this.owned(owned, message.paneId)
          if (!entry || message.items.length === 0) return
          entry.state = { ...entry.state, items: mergeChatItems(entry.state.items, message.items) }
          if (entry.visible) this.dependencies.broadcast({ type: 'chat_items', paneId: message.paneId, items: message.items })
          return
        }
        case 'session_closed':
          if (!this.owned(owned, message.paneId)) return
          owned.delete(message.paneId)
          this.remove(message.paneId)
      }
    })
    socket.on('close', () => {
      for (const paneId of owned) {
        const entry = this.chats.get(paneId)
        if (!entry || entry.socket !== socket) continue
        entry.socket = null
        entry.state = { ...entry.state, hostConnected: false }
        if (entry.visible) this.dependencies.broadcast({ type: 'chat_session', paneId, session: entry.state.session, hostConnected: false })
        else this.chats.delete(paneId)
      }
    })
  }

  states(): ChatState[] {
    return [...this.chats.values()].filter((entry) => entry.visible).map((entry) => entry.state)
  }

  /** True while a live host drives this pane's agent. */
  owns(paneId: string): boolean {
    const entry = this.chats.get(paneId)
    return entry?.visible === true && entry.socket != null
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
   * drops chats whose pane is gone, and refreshes target ids after restores.
   */
  reconcile(): void {
    for (const [paneId, entry] of this.chats) {
      if (!this.dependencies.paneExists(paneId)) {
        if (!entry.visible && this.now() - entry.receivedAt < PENDING_PANE_MS) continue
        entry.socket?.close()
        this.remove(paneId)
        continue
      }
      const targetId = this.dependencies.targetIdFor(paneId)
      if (!entry.visible || (targetId && targetId !== entry.state.targetId)) {
        entry.visible = true
        entry.state = { ...entry.state, ...(targetId ? { targetId } : {}) }
        this.dependencies.broadcast({ type: 'chat_state', chat: entry.state })
      }
    }
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private owned(owned: Set<string>, paneId: string): ChatEntry | undefined {
    return owned.has(paneId) ? this.chats.get(paneId) : undefined
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

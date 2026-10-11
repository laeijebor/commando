import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_REFUSED_CLOSE_CODE,
  parseDaemonMessage,
  type ChatItem,
  type DaemonToHostMessage,
  type HostToDaemonMessage,
} from '../../shared/agent-chat.js'
import type { AgentSession } from './session.js'

const FLUSH_MS = 50
/** Keeps snapshots well under the daemon's 4 MB frame limit. */
const MAX_SNAPSHOT_BYTES = 2_000_000

/** The newest items that fit in a snapshot frame, oldest first. */
export function snapshotItems(items: readonly ChatItem[], maxBytes = MAX_SNAPSHOT_BYTES): ChatItem[] {
  const kept: ChatItem[] = []
  let bytes = 0
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const size = JSON.stringify(items[index]).length
    if (bytes + size > maxBytes) break
    bytes += size
    kept.push(items[index]!)
  }
  return kept.reverse()
}
const MIN_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 5_000
/** A connection must last this long before reconnects go back to the quick backoff. */
const HEALTHY_CONNECTION_MS = 5_000
/** After the daemon refuses this host, retry rarely (it may be the wrong daemon). */
const REFUSED_BACKOFF_MS = 30_000

export interface HostLog {
  info(message: string): void
}

export interface HostEvents {
  /** The daemon asked to restart a session's host on the same conversation. */
  restart?: (paneId: string) => void
}

/**
 * A reconnecting link to the daemon. While disconnected nothing is queued: the
 * host resends full session snapshots on every (re)connect instead.
 */
export class DaemonLink {
  private socket: WebSocket | null = null
  private backoff = MIN_BACKOFF_MS
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private openedAt = 0
  connected = false

  constructor(
    private readonly url: string,
    private readonly token: () => Promise<string>,
    private readonly handlers: { open: () => void; message: (message: DaemonToHostMessage) => void; close: (code: number, reason: string) => void },
  ) {}

  start(): void {
    void this.connect()
  }

  send(message: HostToDaemonMessage): boolean {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.socket?.close()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    let token: string
    try {
      token = await this.token()
    } catch {
      this.retry()
      return
    }
    if (this.stopped) return
    const socket = new WebSocket(this.url, { headers: { Authorization: `Bearer ${token}` } })
    this.socket = socket
    socket.on('open', () => {
      this.connected = true
      this.openedAt = Date.now()
      this.handlers.open()
    })
    socket.on('message', (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return
      }
      const message = parseDaemonMessage(parsed)
      if (message) this.handlers.message(message)
    })
    socket.on('close', (code, reason) => {
      const wasConnected = this.connected
      this.connected = false
      if (this.socket === socket) this.socket = null
      // Only a connection that stayed up earns a quick reconnect; a daemon that
      // drops us at once must not be hammered.
      if (wasConnected && Date.now() - this.openedAt >= HEALTHY_CONNECTION_MS) this.backoff = MIN_BACKOFF_MS
      if (code === HOST_REFUSED_CLOSE_CODE) this.backoff = REFUSED_BACKOFF_MS
      if (wasConnected) this.handlers.close(code, reason.toString())
      this.retry()
    })
    socket.on('error', () => { /* close follows */ })
  }

  private retry(): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.connect(), this.backoff)
    this.backoff = Math.min(Math.max(MAX_BACKOFF_MS, this.backoff), this.backoff * 2)
  }
}

/**
 * Holds one or more sessions and relays them over a single daemon link. In
 * per-pane mode it holds exactly one; a shared host would hold many, keyed by
 * pane, with no protocol change.
 */
export class AgentHost {
  readonly hostId = randomUUID()
  private readonly sessions = new Map<string, AgentSession>()
  private readonly pendingItems = new Map<string, Map<string, ChatItem>>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly link: DaemonLink

  constructor(
    url: string,
    token: () => Promise<string>,
    private readonly mode: 'pane' | 'shared',
    private readonly log: HostLog,
    private readonly events: HostEvents = {},
  ) {
    this.link = new DaemonLink(url, token, {
      open: () => this.onOpen(),
      message: (message) => void this.onMessage(message),
      close: (code, reason) => this.log.info(code === HOST_REFUSED_CLOSE_CODE
        ? `The Commando daemon refused this host (${reason}). Is COMMANDO_PORT pointing at the daemon for this tmux server? Retrying every 30 s.`
        : `Lost the Commando daemon (${code}${reason ? `: ${reason}` : ''}); reconnecting…`),
    })
  }

  start(): void {
    this.link.start()
  }

  stop(): void {
    this.link.stop()
  }

  get daemonConnected(): boolean {
    return this.link.connected
  }

  add(session: AgentSession): void {
    this.sessions.set(session.paneId, session)
    session.on('items', (items) => this.queueItems(session.paneId, items))
    session.on('session', (info) => {
      this.flush()
      this.link.send({ type: 'session_update', session: info })
    })
    session.on('commands', (commands) => this.link.send({ type: 'commands', paneId: session.paneId, commands }))
    session.on('closed', () => {
      this.flush()
      this.link.send({ type: 'session_update', session: session.snapshot().session })
    })
    this.sendSnapshot(session)
  }

  remove(paneId: string): void {
    this.flush()
    this.sessions.delete(paneId)
    this.link.send({ type: 'session_closed', paneId })
  }

  private onOpen(): void {
    this.link.send({ type: 'hello', hostId: this.hostId, version: AGENT_HOST_PROTOCOL_VERSION, mode: this.mode, pid: process.pid })
    this.pendingItems.clear()
    for (const session of this.sessions.values()) this.sendSnapshot(session)
  }

  private sendSnapshot(session: AgentSession): void {
    const { session: info, items } = session.snapshot()
    this.link.send({ type: 'session_snapshot', session: info, items: snapshotItems(items) })
    const commands = session.commands
    if (commands) this.link.send({ type: 'commands', paneId: session.paneId, commands })
  }

  private async onMessage(message: DaemonToHostMessage): Promise<void> {
    if (message.type === 'welcome') return
    const session = this.sessions.get(message.paneId)
    if (!session) return
    if (message.type === 'send') {
      const { type: _type, paneId: _paneId, requestId: _requestId, text, images, ...options } = message
      session.send(text, images, options)
    } else if (message.type === 'file_search') {
      const result = await session.searchFiles(message.query)
      this.link.send({ type: 'file_search_result', paneId: message.paneId, requestId: message.requestId, ...result })
    } else if (message.type === 'subagent_transcript') {
      const result = await session.subagentTranscript(message.agentId)
      this.link.send({ type: 'subagent_transcript_result', paneId: message.paneId, requestId: message.requestId, items: snapshotItems(result.items), ...(result.error ? { error: result.error } : {}) })
    }
    else if (message.type === 'queue') {
      const { type: _type, paneId: _paneId, requestId: _requestId, ...change } = message
      session.updateQueue(change)
    }
    else if (message.type === 'task') await session.controlTask(message.action, message.agentId, message.toolUseId)
    else if (message.type === 'interrupt') await session.interrupt(message.dropQueued)
    else if (message.type === 'answer') session.answer(message.chatRequestId, message.answer)
    else if (message.type === 'restart') this.events.restart?.(message.paneId)
    else if (message.type === 'configure') await session.configure(message.settings)
  }

  /** Coalesces streaming updates so a long reply is not resent per token. */
  private queueItems(paneId: string, items: ChatItem[]): void {
    let pending = this.pendingItems.get(paneId)
    if (!pending) {
      pending = new Map()
      this.pendingItems.set(paneId, pending)
    }
    for (const item of items) pending.set(item.id, item)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush(): void {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    for (const [paneId, pending] of this.pendingItems) {
      if (pending.size) this.link.send({ type: 'items', paneId, items: [...pending.values()] })
    }
    this.pendingItems.clear()
  }
}

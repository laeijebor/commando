import type { ServerMessage } from '@commando/protocol'
import { DaemonClient, nextRequestId, type DaemonClientOptions, type OutgoingMessage, type ServerMessageListener } from '../daemon/client'
import { useDaemonStore } from '../daemon/store'
import { useChatStore } from '../chat/store'
import { item } from '../chat/testing'
import { demoMessages } from './seed'

/** Uses the real reducers/channel; no socket or HTTP server exists for this host. */
export class DemoDaemonClient extends DaemonClient {
  private openDemo = false
  private demoListeners = new Set<ServerMessageListener>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  constructor(options: DaemonClientOptions) {
    super(options)
    if (!__DEV__) throw new Error('Demo is only available in development')
  }
  override get isOpen(): boolean { return this.openDemo }
  override start(): void {
    if (this.openDemo) return
    this.openDemo = true
    for (const message of demoMessages()) this.emit(message)
    useDaemonStore.getState().setPhase(this.hostId, 'live', 'Live · Demo studio')
  }
  override stop(): void {
    this.openDemo = false
    this.timers.forEach(clearTimeout); this.timers.clear()
    useDaemonStore.getState().setPhase(this.hostId, 'idle', 'Demo disconnected')
  }
  override reconfigure(): void { if (!this.openDemo) this.start() }
  override subscribe(listener: ServerMessageListener): () => void {
    this.demoListeners.add(listener)
    return () => { this.demoListeners.delete(listener) }
  }
  /** Demo routes answer over HTTP, then broadcast what the daemon would (see demo/guide.ts). */
  emitDemo(message: ServerMessage): void { if (this.openDemo) this.emit(message) }
  private emit(message: ServerMessage): void {
    useDaemonStore.getState().ingest(this.hostId, message)
    useChatStore.getState().ingest(this.hostId, message)
    this.demoListeners.forEach((listener) => listener(message))
  }
  private later(callback: () => void, delay: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); if (this.openDemo) callback() }, delay)
    this.timers.add(timer)
  }
  override send(message: OutgoingMessage): string | null {
    if (!this.openDemo) return null
    const requestId = message.requestId ?? nextRequestId()
    if (message.type === 'mark_panes_seen') this.emit({ type: 'pane_seen', seen: Object.fromEntries(message.paneIds.map((id) => [id, Date.now()])) })
    const chat = 'paneId' in message ? useChatStore.getState().byHost[this.hostId]?.[message.paneId] : undefined
    if (!chat) return requestId
    if (message.type === 'chat_send') {
      this.emit({ type: 'chat_items', paneId: chat.paneId, items: [item('user_message', { text: message.text, images: message.images })] })
      this.emit({ type: 'chat_session', paneId: chat.paneId, session: { ...chat.session, status: 'running' }, hostConnected: true })
      const reply = item('assistant_message', { text: 'I’m on it.', status: 'running' })
      const chunks = ['I’m on it.', 'I’m on it. The next pass keeps the desktop hierarchy', 'I’m on it. The next pass keeps the desktop hierarchy and makes the phone layout', 'I’m on it. The next pass keeps the desktop hierarchy and makes the phone layout easier to scan.']
      chunks.forEach((text, index) => this.later(() => {
        if (reply.kind !== 'assistant_message') return
        const done = index === chunks.length - 1
        this.emit({ type: 'chat_items', paneId: chat.paneId, items: [{ ...reply, text, status: done ? 'completed' : 'running', updatedAt: Date.now() }] })
        if (done) this.emit({ type: 'chat_session', paneId: chat.paneId, session: { ...chat.session, status: 'idle' }, hostConnected: true })
      }, 250 + index * 450))
    } else if (message.type === 'chat_interrupt') {
      this.timers.forEach(clearTimeout); this.timers.clear()
      this.emit({ type: 'chat_session', paneId: chat.paneId, session: { ...chat.session, status: 'idle' }, hostConnected: true })
    } else if (message.type === 'chat_answer') {
      const request = chat.items.find((entry) => entry.kind === 'request' && entry.requestId === message.chatRequestId)
      if (request?.kind === 'request') this.emit({ type: 'chat_items', paneId: chat.paneId, items: [{ ...request, answer: message.answer }] })
      const status = useDaemonStore.getState().byHost[this.hostId]?.agentStatuses[chat.paneId]
      if (status) this.emit({ type: 'agent_status', status: { ...status, status: 'done', settledAt: Date.now(), details: { recentActivities: [], checks: [] } } })
      this.emit({ type: 'chat_session', paneId: chat.paneId, session: { ...chat.session, status: 'idle' }, hostConnected: true })
    } else if (message.type === 'answer_agent_request') {
      const status = useDaemonStore.getState().byHost[this.hostId]?.agentStatuses[chat.paneId]
      if (status) this.emit({ type: 'agent_status', status: { ...status, status: 'done', settledAt: Date.now(), details: { recentActivities: [], checks: [] } } })
      this.emit({ type: 'agent_request_answered', paneId: chat.paneId, interactionId: message.interactionId, changed: true, requestId })
    } else if (message.type === 'chat_file_search') {
      this.later(() => this.emit({ type: 'chat_file_search_result', paneId: chat.paneId, requestId, entries: [{ path: 'src/ChatView.tsx', kind: 'file' }], truncated: false }), 50)
    }
    return requestId
  }
}

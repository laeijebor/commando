import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_REFUSED_CLOSE_CODE,
  hostTakesInput,
  hostTakesMcp,
  hostTakesSettings,
  hostTakesSwitch,
  hostTakesTurnFlow,
  isChatPermissionMode,
  mergeChatItems,
  parseHostMessage,
  type ChatAnswer,
  type ChatFileSearchResult,
  type ChatImageRef,
  type ChatItem,
  type ChatQueueAction,
  type ChatSendOptions,
  type ChatSettingsChange,
  type ChatSubagentTranscript,
  type ChatSwitchAction,
  type ChatTaskAction,
  type ChatState,
  type DaemonToHostMessage,
  type HostToDaemonMessage,
} from '../shared/agent-chat.js'
import type { ChatMcpRequest, ChatMcpResult } from '../shared/chat-mcp.js'
import type { AgentInteractionAnswer, ServerMessage } from '../shared/protocol.js'
import type { ChatResumeSettings } from './agent-resume-command.js'
import type { ChatHandoffStore } from './chat-handoffs.js'
import type { ChatHostReport } from './agent-status-registry.js'
import { chatAnswerFor, chatHostReport, chatRequestOpen, type ChatRequestItem } from './chat-interactions.js'

const MAX_HOST_MESSAGE_BYTES = 4 * 1024 * 1024
/** How long a session may wait for its pane to appear in the tmux snapshot. */
const PENDING_PANE_MS = 60_000
/** How long a chat stays after its host disconnects (a host restart or daemon blip). */
const DISCONNECTED_GRACE_MS = 60_000
/** A file search the host hasn't answered by then reports an error instead. */
const FILE_SEARCH_TIMEOUT_MS = 10_000
/** Reading a long subagent transcript can take a moment. */
const SUBAGENT_TRANSCRIPT_TIMEOUT_MS = 20_000
/** Reconnecting or starting a sign-in can wait on a slow server. */
const MCP_TIMEOUT_MS = 45_000

/**
 * Where a chat's requests and status show beyond its pane: the approvals
 * broker (island, phone, push, the web HUD) and the status registry.
 */
export type ChatInteractions = {
  /**
   * The host's session status; null once the host is gone. `restored` marks
   * what a (re)connecting host already had, e.g. after a daemon restart: not
   * news, so nobody is notified about it.
   */
  status: (paneId: string, report: ChatHostReport | null, restored?: boolean) => void
  /** A request the host waits on, to list where it can be answered. */
  open: (paneId: string, item: ChatRequestItem, restored?: boolean) => void
  /** Takes a request off those lists: answered, cancelled, or its host is gone. */
  close: (paneId: string, requestId: string) => void
}

type HubDependencies = {
  paneExists: (paneId: string) => boolean
  targetIdFor: (paneId: string) => string | undefined
  broadcast: (message: ServerMessage) => void
  /**
   * Confirms the host process runs inside the pane it claims, so a process
   * that merely holds the hook token cannot take over another pane's chat.
   */
  verifyHost?: (paneId: string, hostPid: number) => Promise<boolean>
  /** Fingerprint of the agent host code in the daemon's checkout. */
  currentHostBuild?: () => Promise<string | undefined>
  interactions?: ChatInteractions
  log?: (message: string) => void
  now?: () => number
  /** Keeps what a chat holds while its conversation runs in Claude Code. */
  handoffs?: Pick<ChatHandoffStore, 'save' | 'returned' | 'take' | 'discard'>
  /** A chat switched to Claude Code, or came back. */
  onHandoffsChange?: () => void
}

/** A chat's unsent draft, sent with its switch to Claude Code. */
export type ChatSwitchDraft = { text: string; images: ChatImageRef[] }

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
  /** The host handed the conversation to Claude Code; its going away ends the chat at once. */
  handedOff?: boolean
  /** Requests listed through `ChatInteractions.open` and not closed yet. */
  openRequests: Set<string>
  /** Requests an answer went to, so a second one is refused until the host confirms. */
  answered: Set<string>
  /** Whether the chat has had a turn, so idle reads as done. */
  hadTurn: boolean
}

/**
 * Daemon side of chat panes. Agent hosts run inside tmux panes and connect
 * here; the hub keeps each pane's session and items so a browser that joins
 * late (or after a daemon restart, once the host reconnects) gets the whole
 * conversation, and routes the browser's sends, interrupts and answers back.
 */
type PendingHostRequest<T> = {
  paneId: string
  socket: WebSocket
  timer: ReturnType<typeof setTimeout>
  resolve: (result: T) => void
}

export class AgentHostHub {
  private readonly chats = new Map<string, ChatEntry>()
  private readonly fileSearches = new Map<string, PendingHostRequest<ChatFileSearchResult>>()
  private readonly transcripts = new Map<string, PendingHostRequest<ChatSubagentTranscript>>()
  private readonly mcpRequests = new Map<string, PendingHostRequest<ChatMcpResult>>()
  /** Drafts of chats waiting to switch to Claude Code, by pane, until the host hands over. */
  private readonly switchDrafts = new Map<string, ChatSwitchDraft>()

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
      if (!message) {
        const type = typeof parsed === 'object' && parsed !== null && 'type' in parsed ? String((parsed as { type: unknown }).type).slice(0, 40) : 'unknown'
        this.dependencies.log?.(`[agent-host] dropped an invalid ${type} message from a host`)
        return
      }
      queue = queue.then(() => this.handle(socket, message)).catch((error: unknown) => {
        this.dependencies.log?.(`[agent-host] message failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    socket.on('close', () => {
      for (const [requestId, search] of this.fileSearches) {
        if (search.socket === socket) this.finishFileSearch(requestId, { entries: [], truncated: false, error: 'The agent host disconnected' })
      }
      for (const [requestId, read] of this.transcripts) {
        if (read.socket === socket) this.finish(this.transcripts, requestId, { items: [], error: 'The agent host disconnected' })
      }
      for (const [requestId, request] of this.mcpRequests) {
        if (request.socket === socket) this.finish(this.mcpRequests, requestId, { servers: [], error: 'The agent host disconnected' })
      }
      for (const [paneId, entry] of this.chats) {
        if (entry.socket !== socket) continue
        entry.socket = null
        this.closeRequests(paneId, entry)
        // Hooks take the pane back meanwhile (it may run Claude Code itself now).
        if (entry.visible) this.dependencies.interactions?.status(paneId, null)
        // A host that handed its conversation to Claude Code isn't coming back as this chat.
        if (entry.handedOff) {
          this.remove(paneId)
          continue
        }
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
          socket.close(HOST_REFUSED_CLOSE_CODE, `host is not running in pane ${paneId}`)
          return
        }
        if (socket.readyState !== socket.OPEN) return
        const previous = this.chats.get(paneId)
        // A newer host for the same pane replaces the old link.
        if (previous?.socket && previous.socket !== socket) {
          this.dependencies.log?.(`[agent-host] a new host for ${paneId} replaces the previous one`)
          previous.socket.close()
        }
        const updateAvailable = await this.updateAvailable(message.session.hostBuild)
        // The socket may have closed while we waited; never register a dead host.
        if (socket.readyState !== socket.OPEN) return
        const targetId = this.dependencies.targetIdFor(paneId)
        // A chat back from Claude Code offers its draft and queue to the composer again.
        const carried = message.session.sessionId ? this.dependencies.handoffs?.returned(message.session.sessionId) : undefined
        if (message.session.sessionId && this.dependencies.handoffs) this.dependencies.onHandoffsChange?.()
        const state: ChatState = {
          paneId,
          ...(targetId ? { targetId } : {}),
          session: message.session,
          items: mergeChatItems([], message.items),
          hostConnected: true,
          ...(updateAvailable ? { updateAvailable } : {}),
          // The host resends its list straight after; keep the menu meanwhile.
          ...(previous?.state.commands ? { commands: previous.state.commands } : {}),
          ...(carried ? { carried } : {}),
        }
        const entry: ChatEntry = {
          state,
          socket,
          visible: known,
          receivedAt: this.now(),
          // The requests stay listed across a host change; the sync below drops the ones it no longer has.
          openRequests: previous?.openRequests ?? new Set(),
          // A request still open in a new host's snapshot never got its answer.
          answered: new Set(),
          hadTurn: state.items.some((item) => item.kind === 'user_message'),
        }
        this.chats.set(paneId, entry)
        if (known) {
          this.dependencies.broadcast({ type: 'chat_state', chat: state })
          this.syncInteractions(paneId, entry, state.items, true)
        }
        return
      }
      case 'session_update': {
        const entry = this.owned(socket, message.session.paneId)
        if (!entry || message.session.hostPid !== entry.state.session.hostPid) return
        // The host gave up on a switch it had handed over (it timed out waiting): it still holds its queue.
        const abandoned = entry.state.session.claudeCodeSwitch === 'switching' && !message.session.claudeCodeSwitch
          && message.session.status !== 'closed' && message.session.status !== 'error'
        if (abandoned && message.session.sessionId) {
          entry.handedOff = false
          if (this.dependencies.handoffs?.discard(message.session.sessionId)) this.dependencies.onHandoffsChange?.()
        }
        entry.state = { ...entry.state, session: message.session }
        if (entry.visible) {
          this.dependencies.broadcast({ type: 'chat_session', paneId: message.session.paneId, session: message.session, hostConnected: true })
          this.reportStatus(message.session.paneId, entry)
        }
        return
      }
      case 'items': {
        const entry = this.owned(socket, message.paneId)
        if (!entry || message.items.length === 0) return
        entry.state = { ...entry.state, items: mergeChatItems(entry.state.items, message.items) }
        const startsTurn = !entry.hadTurn && message.items.some((item) => item.kind === 'user_message')
        if (startsTurn) entry.hadTurn = true
        if (entry.visible) {
          this.dependencies.broadcast({ type: 'chat_items', paneId: message.paneId, items: message.items })
          this.syncInteractions(message.paneId, entry, message.items)
          if (startsTurn) this.reportStatus(message.paneId, entry)
        }
        return
      }
      case 'session_closed':
        if (!this.owned(socket, message.paneId)) return
        this.remove(message.paneId)
        return
      case 'commands': {
        const entry = this.owned(socket, message.paneId)
        if (!entry) return
        entry.state = { ...entry.state, commands: message.commands }
        if (entry.visible) this.dependencies.broadcast({ type: 'chat_commands', paneId: message.paneId, commands: message.commands })
        return
      }
      case 'file_search_result': {
        const search = this.fileSearches.get(message.requestId)
        if (!search || search.socket !== socket || search.paneId !== message.paneId) return
        const { type: _type, paneId: _paneId, requestId, ...result } = message
        this.finishFileSearch(requestId, result)
        return
      }
      case 'subagent_transcript_result': {
        const read = this.transcripts.get(message.requestId)
        if (!read || read.socket !== socket || read.paneId !== message.paneId) return
        this.finish(this.transcripts, message.requestId, message.error ? { items: message.items, error: message.error } : { items: message.items })
        return
      }
      case 'mcp_result': {
        const request = this.mcpRequests.get(message.requestId)
        if (!request || request.socket !== socket || request.paneId !== message.paneId) return
        const { type: _type, paneId: _paneId, requestId, ...result } = message
        this.finish(this.mcpRequests, requestId, result)
        return
      }
      case 'handoff': {
        const entry = this.owned(socket, message.paneId)
        const handoffs = this.dependencies.handoffs
        const refuse = (error: string) => {
          this.switchDrafts.delete(message.paneId)
          this.sendTo(socket, { type: 'handoff_saved', paneId: message.paneId, ok: false, error })
        }
        if (!entry || !handoffs) return void refuse("Commando can't keep this chat's draft and queue")
        if (entry.state.session.sessionId !== message.sessionId) return void refuse('The chat moved to another conversation')
        const typed = this.switchDrafts.get(message.paneId) ?? { text: '', images: [] }
        // What the chat carried back last time and no composer took yet goes across again, first.
        const untaken = entry.state.carried
        const draft = untaken
          ? { text: [untaken.text, typed.text].filter((part) => part.trim()).join('\n\n'), images: [...untaken.images, ...typed.images] }
          : typed
        try {
          await handoffs.save({
            sessionId: message.sessionId, cwd: message.cwd, returnFlags: message.returnFlags, draft, queue: message.queue,
            ...(message.provider ? { provider: message.provider, paneId: message.paneId } : {}),
          })
        } catch (error) {
          return void refuse(`Commando couldn't save the chat's draft and queue: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.switchDrafts.delete(message.paneId)
        entry.handedOff = true
        this.sendTo(socket, { type: 'handoff_saved', paneId: message.paneId, ok: true })
        this.dependencies.onHandoffsChange?.()
      }
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

  send(paneId: string, text: string, requestId: string, images: ChatImageRef[] = [], options: ChatSendOptions = {}): boolean {
    return this.toHost(paneId, { type: 'send', paneId, text, ...(images.length ? { images } : {}), ...options, requestId })
  }

  /** Hosts before protocol 4 would send a queued message straight to Claude. */
  takesTurnFlow(paneId: string): boolean {
    const session = this.chats.get(paneId)?.state.session
    return session ? hostTakesTurnFlow(session) : false
  }

  updateQueue(paneId: string, change: ChatQueueAction, requestId: string): boolean {
    return this.takesTurnFlow(paneId) && this.toHost(paneId, { type: 'queue', paneId, requestId, ...change })
  }

  /** Stops or backgrounds one of the pane's running subagents. */
  controlTask(paneId: string, action: ChatTaskAction, agentId: string, toolUseId: string, requestId: string): boolean {
    return this.takesTurnFlow(paneId) && this.toHost(paneId, { type: 'task', paneId, action, agentId, toolUseId, requestId })
  }

  /** A subagent's saved transcript, read by the pane's host. */
  subagentTranscript(paneId: string, agentId: string): Promise<ChatSubagentTranscript> {
    const entry = this.chats.get(paneId)
    if (!entry?.socket) return Promise.resolve({ items: [], error: 'No agent host is connected for this pane' })
    if (!hostTakesTurnFlow(entry.state.session)) return Promise.resolve({ items: [], error: 'Restart this chat to open subagent transcripts' })
    const socket = entry.socket
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(this.transcripts, requestId, { items: [], error: 'Reading the transcript timed out' }), SUBAGENT_TRANSCRIPT_TIMEOUT_MS)
      this.transcripts.set(requestId, { paneId, socket, timer, resolve })
      if (!this.sendTo(socket, { type: 'subagent_transcript', paneId, agentId, requestId })) {
        this.finish(this.transcripts, requestId, { items: [], error: 'No agent host is connected for this pane' })
      }
    })
  }

  /** Lists the pane agent's MCP servers, after acting on one when asked. */
  mcp(paneId: string, request: ChatMcpRequest): Promise<ChatMcpResult> {
    const entry = this.chats.get(paneId)
    if (!entry?.socket) return Promise.resolve({ servers: [], error: 'No agent host is connected for this pane' })
    if (!hostTakesMcp(entry.state.session)) return Promise.resolve({ servers: [], error: 'Restart this chat to manage its MCP servers' })
    const socket = entry.socket
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(this.mcpRequests, requestId, { servers: [], error: 'The agent took too long to answer' }), MCP_TIMEOUT_MS)
      this.mcpRequests.set(requestId, { paneId, socket, timer, resolve })
      if (!this.sendTo(socket, { type: 'mcp', paneId, request, requestId })) {
        this.finish(this.mcpRequests, requestId, { servers: [], error: 'No agent host is connected for this pane' })
      }
    })
  }

  /** Hosts started before images existed would drop them, so the daemon refuses instead. */
  takesInput(paneId: string): boolean {
    const session = this.chats.get(paneId)?.state.session
    return session ? hostTakesInput(session) : false
  }

  /** Asks the pane's host for `@` mention candidates in its session folder. */
  searchFiles(paneId: string, query: string): Promise<ChatFileSearchResult> {
    const entry = this.chats.get(paneId)
    if (!entry?.socket) return Promise.resolve({ entries: [], truncated: false, error: 'No agent host is connected for this pane' })
    if (!hostTakesInput(entry.state.session)) return Promise.resolve({ entries: [], truncated: false, error: 'Restart this chat to mention files' })
    const socket = entry.socket
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishFileSearch(requestId, { entries: [], truncated: false, error: 'The file search timed out' }), FILE_SEARCH_TIMEOUT_MS)
      this.fileSearches.set(requestId, { paneId, socket, timer, resolve })
      if (!this.sendTo(socket, { type: 'file_search', paneId, query, requestId })) {
        this.finishFileSearch(requestId, { entries: [], truncated: false, error: 'No agent host is connected for this pane' })
      }
    })
  }

  private finishFileSearch(requestId: string, result: ChatFileSearchResult): void {
    this.finish(this.fileSearches, requestId, result)
  }

  private finish<T>(pending: Map<string, PendingHostRequest<T>>, requestId: string, result: T): void {
    const request = pending.get(requestId)
    if (!request) return
    pending.delete(requestId)
    clearTimeout(request.timer)
    request.resolve(result)
  }

  interrupt(paneId: string, requestId: string, dropQueued: string[] = []): boolean {
    return this.toHost(paneId, { type: 'interrupt', paneId, requestId, ...(dropQueued.length ? { dropQueued } : {}) })
  }

  /** Switches the pane's model, effort, speed or permission mode for the rest of its session. */
  configure(paneId: string, settings: ChatSettingsChange, requestId: string): boolean {
    return this.toHost(paneId, { type: 'configure', paneId, settings, requestId })
  }

  /**
   * The settings a resume of this pane's chat should carry: what its pickers
   * show now, not the flags it was launched with.
   */
  resumeSettings(paneId: string): ChatResumeSettings | undefined {
    const session = this.chats.get(paneId)?.state.session
    // An older host reports no picks; its launch flags are still right.
    if (!session || !hostTakesSettings(session) || !isChatPermissionMode(session.permissionMode)) return undefined
    return {
      permissionMode: session.permissionMode,
      ...(session.selectedModel ? { model: session.selectedModel } : {}),
      ...(session.effort ? { effort: session.effort } : {}),
      ...(session.fast ? { fast: true } : {}),
      ...(session.prePlanPermissionMode ? { prePlanPermissionMode: session.prePlanPermissionMode } : {}),
      ...(session.bypassAllowed ? { bypassAllowed: true } : {}),
    }
  }

  /**
   * Asks the pane's host to hand its conversation to Claude Code (now, or once
   * the turn ends), keeping the client's draft for when the chat comes back.
   * Returns why it can't, or null.
   */
  switchToClaudeCode(paneId: string, action: ChatSwitchAction, draft: ChatSwitchDraft | undefined, requestId: string): string | null {
    const entry = this.chats.get(paneId)
    if (!entry?.socket) return 'No agent host is connected for this pane'
    if (!hostTakesSwitch(entry.state.session)) return 'This chat started before switching to Claude Code; restart it to switch'
    if (!this.dependencies.handoffs) return "Commando can't keep this chat's draft and queue"
    // A cancel that comes too late (the host is handing over) leaves the draft to go across.
    if (action === 'cancel') {
      if (entry.state.session.claudeCodeSwitch !== 'switching') this.switchDrafts.delete(paneId)
    } else if (draft) {
      this.switchDrafts.set(paneId, draft)
    } else {
      this.switchDrafts.delete(paneId)
    }
    return this.toHost(paneId, { type: 'switch', paneId, action, requestId }) ? null : 'No agent host is connected for this pane'
  }

  /**
   * A composer took back what the chat carried across Claude Code, with the
   * first `imagesTaken` images (all when omitted); the rest wait to be offered again.
   */
  takeCarried(paneId: string, carryId: string, imagesTaken?: number): boolean {
    const entry = this.chats.get(paneId)
    const sessionId = entry?.state.session.sessionId
    if (!entry || entry.state.carried?.id !== carryId || !sessionId) return false
    const left = this.dependencies.handoffs?.take(sessionId, carryId, imagesTaken)
    const { carried: _taken, ...rest } = entry.state
    entry.state = left ? { ...rest, carried: left } : rest
    if (entry.visible) this.dependencies.broadcast({ type: 'chat_state', chat: entry.state })
    return true
  }

  /** Asks the pane's host to restart on the same conversation, to run the current code. */
  restart(paneId: string, requestId: string): boolean {
    return this.toHost(paneId, { type: 'restart', paneId, requestId })
  }

  /**
   * Sends an answer to the host. Only the first answer to a request goes,
   * whether it came from the chat or (through the broker) the island, phone
   * or HUD; the request then leaves every list.
   */
  answer(paneId: string, chatRequestId: string, answer: ChatAnswer, requestId: string): boolean {
    const entry = this.chats.get(paneId)
    const request = entry?.state.items.find((item) => item.kind === 'request' && item.requestId === chatRequestId)
    if (!entry || !request || request.kind !== 'request' || request.answer || entry.answered.has(chatRequestId)) return false
    if (!this.toHost(paneId, { type: 'answer', paneId, chatRequestId, answer, requestId })) return false
    entry.answered.add(chatRequestId)
    if (entry.openRequests.delete(chatRequestId)) this.dependencies.interactions?.close(paneId, chatRequestId)
    return true
  }

  /** An answer from the island, phone or HUD, in their shape. */
  answerInteraction(paneId: string, chatRequestId: string, answer: AgentInteractionAnswer): boolean {
    const request = this.chats.get(paneId)?.state.items.find((item) => item.kind === 'request' && item.requestId === chatRequestId)
    const chatAnswer = request?.kind === 'request' && chatRequestOpen(request) ? chatAnswerFor(request, answer) : null
    return chatAnswer !== null && this.answer(paneId, chatRequestId, chatAnswer, randomUUID())
  }

  /** True once the request has had an answer, from anywhere. */
  answered(paneId: string, chatRequestId: string): boolean {
    const entry = this.chats.get(paneId)
    return Boolean(entry?.answered.has(chatRequestId) || entry?.state.items.some((item) => (
      item.kind === 'request' && item.requestId === chatRequestId && item.answer && item.answer.kind !== 'cancelled'
    )))
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
        if (entry.socket) this.dependencies.log?.(`[agent-host] closing the host for ${paneId}: the pane is gone`)
        entry.socket?.close()
        this.remove(paneId)
        continue
      }
      if (!entry.socket && entry.disconnectedAt !== undefined && now - entry.disconnectedAt > DISCONNECTED_GRACE_MS) {
        this.remove(paneId)
        continue
      }
      if (entry.visible && entry.socket) {
        const updateAvailable = await this.updateAvailable(entry.state.session.hostBuild)
        if (updateAvailable !== Boolean(entry.state.updateAvailable) && this.chats.get(paneId) === entry) {
          const { updateAvailable: _previous, ...rest } = entry.state
          entry.state = updateAvailable ? { ...rest, updateAvailable } : rest
          this.dependencies.broadcast({ type: 'chat_state', chat: entry.state })
        }
      }
      if (!entry.visible) {
        if (!entry.socket) continue
        if (!(await this.verified(paneId, entry.state.session.hostPid))) {
          entry.socket.close(HOST_REFUSED_CLOSE_CODE, `host is not running in pane ${paneId}`)
          this.chats.delete(paneId)
          continue
        }
        if (this.chats.get(paneId) !== entry) continue
        entry.visible = true
        this.syncInteractions(paneId, entry, entry.state.items, true)
      } else {
        const targetId = this.dependencies.targetIdFor(paneId)
        if (!targetId || targetId === entry.state.targetId) continue
      }
      const targetId = this.dependencies.targetIdFor(paneId)
      entry.state = { ...entry.state, ...(targetId ? { targetId } : {}) }
      this.dependencies.broadcast({ type: 'chat_state', chat: entry.state })
    }
  }

  private async updateAvailable(hostBuild: string | undefined): Promise<boolean> {
    if (!hostBuild || !this.dependencies.currentHostBuild) return false
    const current = await this.dependencies.currentHostBuild().catch(() => undefined)
    return current !== undefined && current !== hostBuild
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
    this.switchDrafts.delete(paneId)
    this.closeRequests(paneId, entry)
    if (entry.visible) {
      this.dependencies.broadcast({ type: 'chat_removed', paneId })
      this.dependencies.interactions?.status(paneId, null)
    }
  }

  /**
   * Lists the host's open requests among `items` where the island, phone and
   * HUD can answer them, and takes off the ones that were answered or
   * cancelled. With all the chat's items (a snapshot), it also drops listed
   * requests they no longer hold and reports the host's status.
   */
  private syncInteractions(paneId: string, entry: ChatEntry, items: readonly ChatItem[], all = false): void {
    const interactions = this.dependencies.interactions
    if (!interactions || !entry.socket) return
    if (all) {
      this.reportStatus(paneId, entry, true)
      const open = new Set(items.flatMap((item) => item.kind === 'request' && chatRequestOpen(item) ? [item.requestId] : []))
      for (const requestId of entry.openRequests) {
        if (open.has(requestId)) continue
        entry.openRequests.delete(requestId)
        interactions.close(paneId, requestId)
      }
    }
    for (const item of items) {
      if (item.kind !== 'request') continue
      if (chatRequestOpen(item)) {
        if (entry.openRequests.has(item.requestId) || entry.answered.has(item.requestId)) continue
        entry.openRequests.add(item.requestId)
        interactions.open(paneId, item, all)
      } else {
        entry.answered.delete(item.requestId)
        if (entry.openRequests.delete(item.requestId)) interactions.close(paneId, item.requestId)
      }
    }
  }

  private closeRequests(paneId: string, entry: ChatEntry): void {
    for (const requestId of entry.openRequests) this.dependencies.interactions?.close(paneId, requestId)
    entry.openRequests.clear()
  }

  private reportStatus(paneId: string, entry: ChatEntry, restored = false): void {
    this.dependencies.interactions?.status(paneId, chatHostReport(entry.state.session, entry.hadTurn), restored)
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

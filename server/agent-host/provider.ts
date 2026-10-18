import type {
  ChatAnswer,
  ChatCommand,
  ChatFileSearchResult,
  ChatImageRef,
  ChatItem,
  ChatQueueAction,
  ChatQueuedMessage,
  ChatSendOptions,
  ChatSessionInfo,
  ChatSettingsChange,
  ChatSubagentTranscript,
  ChatSwitchAction,
  ChatTaskAction,
} from '../../shared/agent-chat.js'

export interface ChatProviderSessionEvents {
  items: (items: ChatItem[]) => void
  /** Relayed to the daemon as session_update. */
  session: (info: ChatSessionInfo) => void
  commands: (commands: ChatCommand[]) => void
  closed: () => void
  /** The provider needs its host respawned (same conversation) before the next turn can run. */
  restart: () => void
}

/** Optional handoff to the provider's terminal UI on the same conversation. */
export interface ChatProviderTui {
  readonly label: string
  readonly env: Record<string, string>
  onReady(listener: () => void): void
  requestSwitch(action: ChatSwitchAction): Promise<void>
  command(launcher: string | undefined, returnFlags: readonly string[], sessionId: string | undefined): string
  handOver(): void
  endSwitch(notice?: string): void
}

/** What the host and its terminal need from a chat session. */
export interface ChatProviderSession {
  readonly paneId: string
  readonly commands: ChatCommand[] | null
  /** Includes pending answers, queued messages and sends still on their way. */
  readonly busy: boolean
  readonly queued: ChatQueuedMessage[]
  readonly tui?: ChatProviderTui
  on<K extends keyof ChatProviderSessionEvents>(event: K, listener: ChatProviderSessionEvents[K]): void
  start(): Promise<void>
  send(text: string, images?: ChatImageRef[], options?: ChatSendOptions): void
  updateQueue(change: ChatQueueAction): void
  interrupt(dropQueued?: readonly string[]): Promise<void>
  answer(requestId: string, answer: ChatAnswer): boolean
  configure(change: ChatSettingsChange): Promise<void>
  searchFiles(query: string): Promise<ChatFileSearchResult>
  controlTask(action: ChatTaskAction, agentId: string, toolUseId: string): Promise<void>
  subagentTranscript(agentId: string): Promise<ChatSubagentTranscript>
  setResumeCommand(command: string): void
  /** Shows a host-level problem (a failed restart, say) in the chat as well as the pane. */
  hostNotice?(level: 'info' | 'error', text: string): void
  snapshot(): { session: ChatSessionInfo; items: ChatItem[] }
  close(): void
}

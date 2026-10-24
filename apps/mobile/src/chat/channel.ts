import { useEffect, useMemo, useState } from 'react'

import type {
  ChatAnswer,
  ChatFileSearchResult,
  ChatImageRef,
  ChatQueueAction,
  ChatSendOptions,
  ChatSettingsChange,
  ChatSubagentTranscript,
  ChatTaskAction,
} from '@commando/agent-chat'
import type { ServerMessage } from '@commando/protocol'

import { nextRequestId, type DaemonClient, type OutgoingMessage } from '../daemon/client'

/** How long a refusal is matched to its send; the composer keeps a sent draft as long (the web's CHAT_SEND_REFUSAL_MS). */
export const CHAT_SEND_REFUSAL_MS = 30_000
const ACTION_REFUSAL_MS = 30_000
const FILE_SEARCH_TIMEOUT_MS = 15_000
/** The web's limit for reading a subagent's saved transcript. */
const TRANSCRIPT_TIMEOUT_MS = 25_000

/** Sends the daemon refused, by the request ids `send` returned (the web's ChatSendError). */
export type ChatSendError = {
  message: string
  refused: { requestId: string; code?: string }[]
}

type Listener = {
  /** Null when a new send clears the last refusal, as the web does. */
  sendRefused: (error: ChatSendError | null) => void
  actionRefused: (message: string) => void
}

const NOT_CONNECTED_SEND = "Not connected to Commando, so the message wasn't sent"
const NOT_CONNECTED_ACTION = "Not connected to Commando, so that didn't reach the chat"

/**
 * One chat pane's messages to the daemon, the same ones the web sends, and
 * the replies matched back to them by request id: a refused send, a refused
 * action, a file search's answer. No React here, so it is unit-testable.
 */
export class ChatChannel {
  private readonly sends = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly actions = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly searches = new Map<string, (result: ChatFileSearchResult) => void>()
  private readonly transcripts = new Map<string, (result: ChatSubagentTranscript) => void>()
  private refused: ChatSendError['refused'] = []

  constructor(
    private readonly transport: { send: (message: OutgoingMessage) => string | null },
    readonly paneId: string,
    private readonly listener: Listener,
  ) {}

  /** Returns the send's request id, which a refusal names. */
  send(text: string, images?: ChatImageRef[], options: ChatSendOptions = {}): string {
    const requestId = nextRequestId()
    if (this.refused.length) {
      this.refused = []
      this.listener.sendRefused(null)
    }
    const sent = this.transport.send({ type: 'chat_send', paneId: this.paneId, text, ...(images?.length ? { images } : {}), ...options, requestId })
    if (sent === null) {
      this.refuse({ requestId }, NOT_CONNECTED_SEND)
      return requestId
    }
    this.sends.set(requestId, setTimeout(() => this.sends.delete(requestId), CHAT_SEND_REFUSAL_MS))
    return requestId
  }

  /** `dropQueued`: queued messages Stop took back into the draft. */
  interrupt(dropQueued?: string[]): void {
    this.action({ type: 'chat_interrupt', paneId: this.paneId, ...(dropQueued?.length ? { dropQueued } : {}) })
  }

  answer(chatRequestId: string, answer: ChatAnswer): void {
    this.action({ type: 'chat_answer', paneId: this.paneId, chatRequestId, answer })
  }

  configure(settings: ChatSettingsChange): void {
    this.action({ type: 'chat_configure', paneId: this.paneId, settings })
  }

  queue(change: ChatQueueAction): void {
    this.action({ type: 'chat_queue', paneId: this.paneId, ...change })
  }

  /** Stop or background an SDK subagent, by its agent id and the Agent call that started it. */
  task(action: ChatTaskAction, agentId: string, toolUseId: string): void {
    this.action({ type: 'chat_task', paneId: this.paneId, action, agentId, toolUseId })
  }

  /** Stop an external run (`codex exec`, `claude -p`, …) the daemon watches. */
  stopExternal(runId: string): void {
    this.action({ type: 'chat_external_stop', paneId: this.paneId, runId })
  }

  /** A subagent's saved turns, for one whose items aren't in the chat (after a resume). Never rejects. */
  subagentTranscript(agentId: string): Promise<ChatSubagentTranscript> {
    return new Promise((resolve) => {
      const requestId = nextRequestId()
      const finish = (result: ChatSubagentTranscript): void => {
        clearTimeout(timer)
        this.transcripts.delete(requestId)
        resolve(result)
      }
      const timer = setTimeout(() => finish({ items: [], error: 'Reading the transcript timed out' }), TRANSCRIPT_TIMEOUT_MS)
      this.transcripts.set(requestId, finish)
      if (this.transport.send({ type: 'chat_subagent_transcript', paneId: this.paneId, agentId, requestId }) === null) {
        finish({ items: [], error: 'Not connected to Commando' })
      }
    })
  }

  /** The composer took back what the chat carried across Claude Code; false when the socket couldn't say so. */
  carryTaken(carryId: string, images: number): boolean {
    return this.transport.send({ type: 'chat_carry_taken', paneId: this.paneId, carryId, images }) !== null
  }

  /** The chat's whole history, for a copy the daemon bounded on connect; it comes back as a `chat_state`. */
  loadHistory(): boolean {
    return this.transport.send({ type: 'chat_history', paneId: this.paneId }) !== null
  }

  /** Files and folders for an `@` mention, searched by the chat's host. */
  searchFiles(query: string): Promise<ChatFileSearchResult> {
    return new Promise((resolve) => {
      const requestId = nextRequestId()
      const finish = (result: ChatFileSearchResult): void => {
        clearTimeout(timer)
        this.searches.delete(requestId)
        resolve(result)
      }
      const timer = setTimeout(() => finish({ entries: [], truncated: false, error: 'The file search timed out' }), FILE_SEARCH_TIMEOUT_MS)
      this.searches.set(requestId, finish)
      if (this.transport.send({ type: 'chat_file_search', paneId: this.paneId, query, requestId }) === null) {
        finish({ entries: [], truncated: false, error: 'Not connected to Commando' })
      }
    })
  }

  /** Every server message, so replies to this pane's requests reach their caller. */
  receive(message: ServerMessage): void {
    if (message.type === 'chat_file_search_result') {
      const { type: _type, paneId: _paneId, requestId, ...result } = message
      this.searches.get(requestId)?.(result)
      return
    }
    if (message.type === 'chat_subagent_transcript_result') {
      const { type: _type, paneId: _paneId, requestId, ...result } = message
      this.transcripts.get(requestId)?.(result)
      return
    }
    if (message.type !== 'error' || !message.requestId) return
    const { requestId } = message
    this.searches.get(requestId)?.({ entries: [], truncated: false, error: message.message })
    this.transcripts.get(requestId)?.({ items: [], error: message.message })
    const send = this.sends.get(requestId)
    if (send) {
      clearTimeout(send)
      this.sends.delete(requestId)
      this.refuse({ requestId, code: message.code }, message.message)
    }
    const action = this.actions.get(requestId)
    if (action) {
      clearTimeout(action)
      this.actions.delete(requestId)
      this.listener.actionRefused(message.message)
    }
  }

  /** Clears the refusals collected so far (the error was dismissed or a new send went out). */
  clearRefusals(): void {
    this.refused = []
  }

  dispose(): void {
    for (const timer of [...this.sends.values(), ...this.actions.values()]) clearTimeout(timer)
    this.sends.clear()
    this.actions.clear()
    for (const finish of [...this.searches.values()]) finish({ entries: [], truncated: false, error: 'The chat closed' })
    for (const finish of [...this.transcripts.values()]) finish({ items: [], error: 'The chat closed' })
  }

  private refuse(entry: { requestId: string; code?: string }, message: string): void {
    // Two refusals that land together each restore their draft.
    this.refused = [...this.refused, entry]
    this.listener.sendRefused({ message, refused: this.refused })
  }

  private action(message: OutgoingMessage): void {
    const requestId = nextRequestId()
    if (this.transport.send({ ...message, requestId }) === null) {
      this.listener.actionRefused(NOT_CONNECTED_ACTION)
      return
    }
    this.actions.set(requestId, setTimeout(() => this.actions.delete(requestId), ACTION_REFUSAL_MS))
  }
}

export type ChatChannelState = {
  channel: ChatChannel | null
  sendError: ChatSendError | null
  dismissSendError: () => void
  actionError: string | null
  dismissActionError: () => void
}

/** A pane's channel on the host's shared socket, with the refusals it has seen. */
export function useChatChannel(client: DaemonClient | undefined, paneId: string | undefined): ChatChannelState {
  const [sendError, setSendError] = useState<ChatSendError | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const channel = useMemo(() => (client && paneId
    ? new ChatChannel(client, paneId, { sendRefused: setSendError, actionRefused: setActionError })
    : null), [client, paneId])

  useEffect(() => {
    if (!client || !channel) return
    const unsubscribe = client.subscribe((message) => channel.receive(message))
    return () => {
      unsubscribe()
      channel.dispose()
    }
  }, [client, channel])

  useEffect(() => {
    setSendError(null)
    setActionError(null)
  }, [channel])

  return {
    channel,
    sendError,
    dismissSendError: () => {
      channel?.clearRefusals()
      setSendError(null)
    },
    actionError,
    dismissActionError: () => setActionError(null),
  }
}

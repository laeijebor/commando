import type { ChatItem, ChatState } from '../shared/agent-chat.js'
import type { ServerMessage } from '../shared/protocol.js'

/**
 * A client may ask for a bounded copy of each chat (`/ws?chatHistory=<bytes>`):
 * the companion app does, because every chat's whole history (up to 2,000
 * items each, tool output included) adds up to tens of megabytes that a phone
 * downloads again on every reconnect. The desktop cockpit asks for nothing and
 * keeps the full history. A client that wants one chat in full sends
 * `chat_history` and gets that chat's `chat_state` unbounded.
 */
export const MIN_CHAT_HISTORY_BYTES = 16 * 1024
export const MAX_CHAT_HISTORY_BYTES = 64 * 1024 * 1024

/** The per-chat budget a `/ws` URL asks for, clamped; undefined for the full history. */
export function chatHistoryBudget(url: URL): number | undefined {
  const raw = url.searchParams.get('chatHistory')
  if (raw === null || !/^\d{1,12}$/u.test(raw)) return undefined
  return Math.min(MAX_CHAT_HISTORY_BYTES, Math.max(MIN_CHAT_HISTORY_BYTES, Number(raw)))
}

function isOpenRequest(item: ChatItem): boolean {
  return item.kind === 'request' && item.status === 'running' && !item.answer
}

/**
 * The newest items that fit in `budget` bytes of JSON (at least the newest
 * one), plus any request still waiting for an answer however old, in their
 * original order. `omittedItems` counts what was left on the daemon.
 */
export function windowChatState(state: ChatState, budget: number): ChatState {
  const { items } = state
  let used = 0
  let start = items.length
  while (start > 0) {
    const size = JSON.stringify(items[start - 1]).length + 1
    if (start < items.length && used + size > budget) break
    used += size
    start -= 1
  }
  if (start === 0) return state.omittedItems ? { ...state, omittedItems: 0 } : state
  const kept = [...items.slice(0, start).filter(isOpenRequest), ...items.slice(start)]
  return { ...state, items: kept, omittedItems: items.length - kept.length }
}

/** What one client is sent: the message itself, or its chats bounded to the client's budget. */
export function chatMessageForClient(message: ServerMessage, budget: number | undefined): ServerMessage {
  if (budget === undefined) return message
  if (message.type === 'chat_snapshot') return { ...message, chats: message.chats.map((chat) => windowChatState(chat, budget)) }
  if (message.type === 'chat_state') return { ...message, chat: windowChatState(message.chat, budget) }
  return message
}

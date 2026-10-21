import type { ChatState } from '@commando/agent-chat'
import type { HostChats } from '../chat/store'

export type ChatRowMetadata = {
  session: Pick<ChatState['session'], 'provider' | 'status' | 'title'>
  pending: boolean
  updatedAt: number
}
export type ListChat = ChatState | ChatRowMetadata
export function rowUpdatedAt(chat?: ListChat): number {
  if (!chat) return 0
  if (!('items' in chat)) return chat.updatedAt
  // Streaming text is intentionally excluded: the list changes at turn boundaries.
  return chat.items.reduce((at, item) => item.kind === 'user_message' ? Math.max(at, item.createdAt) : item.status !== 'running' ? Math.max(at, item.updatedAt) : at, 0)
}
export function rowPending(chat?: ListChat): boolean {
  return Boolean(chat && ('items' in chat ? chat.items.some((item) => item.kind === 'request' && item.status === 'running' && !item.answer) : chat.pending))
}
const EMPTY: Record<string, ChatRowMetadata> = {}
/** Stable selector: an assistant's individual text chunks never invalidate list rows. */
export function createChatRowSelector(hostId: string | undefined) {
  let raw: HostChats = {}
  let previous = EMPTY
  return (store: { byHost: Record<string, HostChats> }): Record<string, ChatRowMetadata> => {
    const chats = store.byHost[hostId ?? '']
    if (!chats) return EMPTY
    if (chats === raw) return previous
    const next: Record<string, ChatRowMetadata> = {}
    let changed = Object.keys(chats).length !== Object.keys(previous).length
    for (const [id, chat] of Object.entries(chats)) {
      const old = previous[id]
      if (raw[id] === chat && old) { next[id] = old; continue }
      const value: ChatRowMetadata = { session: { provider: chat.session.provider, status: chat.session.status, title: chat.session.title }, pending: rowPending(chat), updatedAt: rowUpdatedAt(chat) }
      if (old && old.session.provider === value.session.provider && old.session.status === value.session.status && old.session.title === value.session.title && old.pending === value.pending && old.updatedAt === value.updatedAt) next[id] = old
      else { next[id] = value; changed = true }
    }
    raw = chats
    if (changed) previous = next
    return previous
  }
}

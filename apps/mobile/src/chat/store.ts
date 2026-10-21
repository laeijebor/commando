import { create } from 'zustand'

import { mergeChatItems, type ChatState } from '@commando/agent-chat'
import type { ServerMessage } from '@commando/protocol'

/** One host's chat panes by pane id, as the daemon relays them. */
export type HostChats = Record<string, ChatState>

const EMPTY: HostChats = {}

/**
 * Folds one chat message into a host's chats, as the web's `App.tsx` does.
 * Returns the same object when nothing changed, so subscribers stay put.
 */
export function applyChatMessage(chats: HostChats, message: ServerMessage): HostChats {
  switch (message.type) {
    case 'chat_snapshot':
      return Object.fromEntries(message.chats.map((chat) => [chat.paneId, chat]))
    case 'chat_state':
      return { ...chats, [message.chat.paneId]: message.chat }
    case 'chat_session': {
      const chat = chats[message.paneId]
      return chat ? { ...chats, [message.paneId]: { ...chat, session: message.session, hostConnected: message.hostConnected } } : chats
    }
    case 'chat_items': {
      const chat = chats[message.paneId]
      return chat ? { ...chats, [message.paneId]: { ...chat, items: mergeChatItems(message.replace ? [] : chat.items, message.items) } } : chats
    }
    case 'chat_commands': {
      const chat = chats[message.paneId]
      return chat ? { ...chats, [message.paneId]: { ...chat, commands: message.commands } } : chats
    }
    case 'chat_removed': {
      if (!(message.paneId in chats)) return chats
      const next = { ...chats }
      delete next[message.paneId]
      return next
    }
    default:
      return chats
  }
}

type ChatStoreState = {
  byHost: Record<string, HostChats>
  ingest: (hostId: string, message: ServerMessage) => void
}

/**
 * Chats live apart from the daemon store: a working chat streams items every
 * 50ms, and only the chat view should re-render for them.
 */
export const useChatStore = create<ChatStoreState>((set, get) => ({
  byHost: {},
  ingest: (hostId, message) => {
    const current = get().byHost[hostId] ?? EMPTY
    const next = applyChatMessage(current, message)
    if (next === current) return
    set({ byHost: { ...get().byHost, [hostId]: next } })
  },
}))

/** The chat a pane hosts, or undefined for a terminal pane (or one handed to Claude Code). */
export function useChat(hostId: string | undefined, paneId: string | undefined): ChatState | undefined {
  return useChatStore((state) => (hostId && paneId ? state.byHost[hostId]?.[paneId] : undefined))
}

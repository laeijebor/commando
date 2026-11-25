import { parseAsideKey, type ChatState } from '../shared/agent-chat.js'

/** Pane-level discovery and ask attribution exclude independent aside threads. */
export function isMainChatKey(paneId: string): boolean {
  return !parseAsideKey(paneId)
}

/** Picker exclusions include saved (even closed) asides and hosts not yet in those records. */
export function asideSessionIds(chats: readonly Pick<ChatState, 'paneId' | 'session' | 'asides'>[]): Set<string> {
  const ids = new Set<string>()
  for (const chat of chats) {
    for (const aside of chat.asides ?? []) {
      if (aside.sessionId) ids.add(aside.sessionId)
    }
    if (!isMainChatKey(chat.paneId) && chat.session.sessionId) ids.add(chat.session.sessionId)
  }
  return ids
}

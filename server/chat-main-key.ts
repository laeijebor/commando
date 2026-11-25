import { parseAsideKey } from '../shared/agent-chat.js'

/** Pane-level discovery and ask attribution exclude independent aside threads. */
export function isMainChatKey(paneId: string): boolean {
  return !parseAsideKey(paneId)
}

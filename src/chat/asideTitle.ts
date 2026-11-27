import type { ChatAsideRecord, ChatState } from '../../shared/agent-chat'

/** Forks can inherit Main's auto-title until the provider gives the aside its own. */
export function asideTitle(record: ChatAsideRecord, chat: ChatState | undefined, mainTitle: string | undefined): string {
  const title = chat?.session.title
  return title && title !== mainTitle ? title : record.title
}

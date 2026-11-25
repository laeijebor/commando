import { MAX_CHAT_ITEMS, type ChatAsideInfo, type ChatItem } from '../../shared/agent-chat.js'

/** Presentation only: provider transcripts and prompts retain all inherited context. */
export class AsideTimeline {
  private hiddenMessages?: number
  private firstUserId?: string
  private publishedNotice?: string

  constructor(private readonly aside?: ChatAsideInfo) {}

  cut<T>(history: readonly T[], id: (entry: T) => string | undefined, countMessages: (hidden: T[]) => number): readonly T[] {
    const at = this.aside?.method === 'fork' ? this.aside.forkedFrom.at : undefined
    if (!at) return history
    const index = history.findIndex((entry) => id(entry) === at)
    // A compacted or incomplete transcript must not swallow the aside's own messages.
    if (index < 0) return history
    this.hiddenMessages = countMessages(history.slice(0, index + 1))
    return history.slice(index + 1)
  }

  private notice(): ChatItem[] {
    if (!this.aside) return []
    const text = this.aside.method === 'brief' ? 'Started from a summary of Main'
      : `Forked from Main${this.hiddenMessages === undefined ? '' : ` · ${this.hiddenMessages} earlier messages hidden`}`
    return [{ id: `aside:${this.aside.id}:origin`, turnId: 'aside-origin', kind: 'notice', level: 'info', status: 'completed',
      text, createdAt: this.aside.createdAt, updatedAt: this.aside.createdAt }]
  }

  private present(items: ChatItem[]): ChatItem[] {
    if (this.aside?.method !== 'brief') return items
    return items.map((item) => {
      if (item.kind !== 'user_message') return item
      this.firstUserId ??= item.id
      if (item.id !== this.firstUserId) return item
      // Cursor includes its per-send guidance in saved user text; Muse may use displayText.
      const heading = /^(?:You are an aside,[^\n]*\n\n)?Context from the main conversation \([^\n]*\)\n/.exec(item.text)
      const separator = heading ? item.text.indexOf('\n---\n', heading[0].length) : -1
      return separator < 0 ? item : { ...item, text: item.text.slice(separator + '\n---\n'.length) }
    })
  }

  updates(items: ChatItem[], replace = false): ChatItem[] {
    const notice = this.notice()
    const text = notice[0]?.kind === 'notice' ? notice[0].text : undefined
    const include = replace || text !== this.publishedNotice
    this.publishedNotice = text
    return [...(include ? notice : []), ...this.present(items)]
  }

  snapshot(items: ChatItem[]): ChatItem[] {
    if (!this.aside) return items
    const notice = this.notice()
    return [...notice, ...this.present(items).slice(-(MAX_CHAT_ITEMS - notice.length))]
  }
}

export function countTimelineMessages(items: ChatItem[]): number {
  return items.filter((item) => item.kind === 'user_message' || item.kind === 'assistant_message').length
}

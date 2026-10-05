import type { PrConversationEntry } from '../shared/pr-quick-look'

export type PrConversationThread = {
  entry: PrConversationEntry
  replies: PrConversationEntry[]
  detachedReply: boolean
}

function commentId(entry: PrConversationEntry): number | undefined {
  if (entry.kind !== 'inline comment') return undefined
  const id = entry.commentId ?? (entry.id.startsWith('2:') ? Number(entry.id.slice(2)) : undefined)
  return id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** GitHub review-comment parent IDs, not paths or review IDs, own reply placement. */
export function groupPrConversation(entries: readonly PrConversationEntry[]): PrConversationThread[] {
  const ordered = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const comments = new Map<number, PrConversationEntry>()
  const inlineReviews = new Set<number>()
  for (const entry of ordered) {
    const id = commentId(entry)
    if (id !== undefined) comments.set(id, entry)
    if (entry.kind === 'inline comment' && entry.reviewId !== undefined) inlineReviews.add(entry.reviewId)
  }
  const groups = new Map<string, PrConversationThread>()
  for (const entry of ordered) {
    // A reply submission often creates an empty COMMENTED review as well as the real comment.
    // Retain approval/change-request events and any review with a body.
    if (
      entry.kind === 'commented' &&
      !entry.body.trim() &&
      entry.reviewId !== undefined &&
      inlineReviews.has(entry.reviewId)
    )
      continue
    let root = entry
    const visited = new Set<string>([entry.id])
    while (root.kind === 'inline comment' && root.replyTo !== undefined) {
      const parent = comments.get(root.replyTo)
      if (!parent) break
      if (visited.has(parent.id)) {
        root = entry
        break
      }
      visited.add(parent.id)
      root = parent
    }
    let group = groups.get(root.id)
    if (!group) {
      group = {
        entry: root,
        replies: [],
        detachedReply: root.kind === 'inline comment' && root.replyTo !== undefined,
      }
      groups.set(root.id, group)
    }
    if (entry.id !== root.id) group.replies.push(entry)
  }
  return [...groups.values()].sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt))
}

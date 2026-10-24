import { groupPrConversation } from '@commando/pr-conversation'
import type { PrConversationEntry, PrDetails } from '@commando/pr-quick-look'

/**
 * `PrDetails.conversation` as the phone's Conversation tab draws it. Grouping
 * (replies under the comment they answer, the empty review GitHub records next
 * to a reply dropped) is the desktop's own `groupPrConversation`; this only
 * sorts each group into what it is — a top-level comment, a review, or an
 * inline review thread with its file, line, state and code.
 */

export type PrReviewState = 'approved' | 'changes requested' | 'commented' | 'dismissed' | 'pending'

export type PrTimelineItem =
  | { type: 'comment'; id: string; entry: PrConversationEntry }
  | { type: 'review'; id: string; entry: PrConversationEntry; state: PrReviewState }
  | {
      type: 'thread'
      id: string
      entry: PrConversationEntry
      replies: PrConversationEntry[]
      /** A reply whose original comment GitHub no longer returns. */
      detached: boolean
      path: string | null
      /** The current line, or for an outdated thread the line it was written on. */
      line: number | null
      resolved: boolean
      outdated: boolean
      diffHunk: string | null
    }

export type PrTimelineSummary = {
  comments: number
  reviews: number
  threads: number
  unresolved: number
  replies: number
}

const REVIEW_STATES = new Set<string>(['approved', 'changes requested', 'commented', 'dismissed', 'pending'])

export function prTimeline(conversation: readonly PrConversationEntry[]): PrTimelineItem[] {
  return groupPrConversation(conversation).flatMap(({ entry, replies, detachedReply }): PrTimelineItem[] => {
    if (entry.kind === 'inline comment') {
      return [{
        type: 'thread',
        id: entry.id,
        entry,
        replies,
        detached: detachedReply,
        path: entry.path ?? null,
        line: entry.line ?? entry.originalLine ?? null,
        resolved: entry.thread?.isResolved ?? false,
        // Older daemons don't say; a comment with no current line has moved off the diff.
        outdated: entry.thread?.isOutdated ?? (entry.line === undefined && entry.originalLine !== undefined),
        diffHunk: entry.diffHunk ?? null,
      }]
    }
    if (REVIEW_STATES.has(entry.kind)) {
      // A bare "commented" review with nothing to say is GitHub bookkeeping, not conversation.
      if (entry.kind === 'commented' && !entry.body.trim()) return []
      return [{ type: 'review', id: entry.id, entry, state: entry.kind as PrReviewState }]
    }
    return [{ type: 'comment', id: entry.id, entry }]
  })
}

export function prTimelineSummary(items: readonly PrTimelineItem[], details?: Pick<PrDetails, 'unresolvedThreads'> | null): PrTimelineSummary {
  const threads = items.filter((item) => item.type === 'thread')
  return {
    comments: items.filter((item) => item.type === 'comment').length,
    reviews: items.filter((item) => item.type === 'review').length,
    threads: threads.length,
    unresolved: details?.unresolvedThreads ?? threads.filter((thread) => !thread.resolved).length,
    replies: threads.reduce((count, thread) => count + thread.replies.length, 0),
  }
}

/** `3 comments · 2 reviews · 4 threads, 1 unresolved` */
export function prTimelineHeadline(summary: PrTimelineSummary): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  const parts = [plural(summary.comments, 'comment'), plural(summary.reviews, 'review'), plural(summary.threads, 'thread')]
  return `${parts.join(' · ')}${summary.threads ? `, ${summary.unresolved} unresolved` : ''}`
}

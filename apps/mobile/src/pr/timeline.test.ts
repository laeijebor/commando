import type { PrConversationEntry } from '@commando/pr-quick-look'

import { prTimeline, prTimelineHeadline, prTimelineSummary } from './timeline'

const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00Z`
const thread = (id: number, resolved: boolean, outdated?: boolean) => ({ id: `PRRT_${id}`, commentId: id, isResolved: resolved, ...(outdated === undefined ? {} : { isOutdated: outdated }), viewerCanReply: true, viewerCanResolve: !resolved, viewerCanUnresolve: resolved })

const CONVERSATION: PrConversationEntry[] = [
  { id: '0:1', kind: 'comment', author: 'leo', body: 'Opening', url: '', createdAt: at(1) },
  { id: '1:10', kind: 'changes requested', reviewId: 10, author: 'otter', body: 'Two things', url: '', createdAt: at(2) },
  { id: '2:100', kind: 'inline comment', commentId: 100, reviewId: 10, author: 'otter', body: 'Here', url: '', createdAt: at(2), path: 'a.ts', line: 4, diffHunk: '@@ -1 +1 @@\n+x', thread: thread(100, false) },
  { id: '1:11', kind: 'commented', reviewId: 11, author: 'crab', body: '', url: '', createdAt: at(3) },
  { id: '2:101', kind: 'inline comment', commentId: 101, replyTo: 100, reviewId: 11, author: 'crab', body: 'Fixed', url: '', createdAt: at(3), path: 'a.ts', line: 4 },
  { id: '2:102', kind: 'inline comment', commentId: 102, reviewId: 10, author: 'otter', body: 'Old', url: '', createdAt: at(2), path: 'b.ts', originalLine: 9, thread: thread(102, true, true) },
  { id: '2:103', kind: 'inline comment', commentId: 103, reviewId: 12, author: 'otter', body: 'Moved', url: '', createdAt: at(4), path: 'c.ts', originalLine: 2 },
  { id: '1:13', kind: 'commented', reviewId: 13, author: 'amber', body: '', url: '', createdAt: at(5) },
  { id: '1:14', kind: 'approved', reviewId: 14, author: 'amber', body: '', url: '', createdAt: at(6) },
]

it('sorts the conversation into comments, reviews and threads with their replies', () => {
  const items = prTimeline(CONVERSATION)
  expect(items.map((item) => [item.type, item.id])).toEqual([
    ['comment', '0:1'],
    ['review', '1:10'],
    ['thread', '2:100'],
    ['thread', '2:102'],
    ['thread', '2:103'],
    ['review', '1:14'],
  ])
  const first = items[2]
  expect(first).toMatchObject({ type: 'thread', path: 'a.ts', line: 4, resolved: false, outdated: false, diffHunk: '@@ -1 +1 @@\n+x' })
  expect(first?.type === 'thread' && first.replies.map((reply) => reply.id)).toEqual(['2:101'])
  expect(items[1]).toMatchObject({ type: 'review', state: 'changes requested' })
})

it('marks outdated threads from the daemon, or from a missing current line on older daemons', () => {
  const items = prTimeline(CONVERSATION)
  expect(items[3]).toMatchObject({ resolved: true, outdated: true, line: 9 })
  expect(items[4]).toMatchObject({ resolved: false, outdated: true, line: 2 })
})

it('summarises counts, preferring the daemon’s unresolved count', () => {
  const items = prTimeline(CONVERSATION)
  const summary = prTimelineSummary(items)
  expect(summary).toEqual({ comments: 1, reviews: 2, threads: 3, unresolved: 2, replies: 1 })
  expect(prTimelineSummary(items, { unresolvedThreads: 5 }).unresolved).toBe(5)
  expect(prTimelineHeadline(summary)).toBe('1 comment · 2 reviews · 3 threads, 2 unresolved')
  expect(prTimelineHeadline(prTimelineSummary([]))).toBe('0 comments · 0 reviews · 0 threads')
})

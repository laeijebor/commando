import { describe, expect, it } from 'vitest'
import type { PrConversationEntry } from '../shared/pr-quick-look'
import { groupPrConversation } from './prConversation'

function comment(id: number, overrides: Partial<PrConversationEntry> = {}): PrConversationEntry {
  return {
    id: `2:${id}`,
    commentId: id,
    kind: 'inline comment',
    author: 'reviewer',
    body: `Comment ${id}`,
    path: 'same-file.ts',
    url: `https://example.com/comment/${id}`,
    createdAt: new Date(Date.UTC(2026, 0, id, 9)).toISOString(),
    ...overrides,
  }
}

describe('PR conversation threading', () => {
  it('attaches replies to explicit parent IDs, including reply chains, rather than matching file paths', () => {
    const entries = [
      comment(1),
      comment(2),
      comment(3, { replyTo: 1 }),
      comment(4, { replyTo: 2 }),
      comment(5, { replyTo: 3 }),
      { ...comment(1), id: '0:1', kind: 'comment', body: 'Issue comment with a colliding numeric ID' },
    ]
    const result = groupPrConversation(entries.reverse())
    expect(result.find((thread) => thread.entry.id === '2:1')?.replies.map((reply) => reply.id)).toEqual([
      '2:3',
      '2:5',
    ])
    expect(result.find((thread) => thread.entry.id === '2:2')?.replies.map((reply) => reply.id)).toEqual([
      '2:4',
    ])
    expect(result.find((thread) => thread.entry.id === '0:1')?.replies).toEqual([])
  })

  it('hides only empty commented reviews attached to inline submissions, preserving meaningful review states', () => {
    const review = (id: number, kind: string, body = ''): PrConversationEntry => ({
      ...comment(id),
      id: `1:${id}`,
      commentId: undefined,
      reviewId: id,
      kind,
      body,
    })
    const entries = [
      comment(1, { reviewId: 10 }),
      comment(2, { replyTo: 1, reviewId: 11 }),
      review(10, 'commented', 'Review with a body'),
      review(11, 'commented'),
      review(12, 'approved'),
      review(13, 'changes requested'),
    ]
    expect(groupPrConversation(entries).map((thread) => thread.entry.id)).toEqual([
      '2:1',
      '1:10',
      '1:12',
      '1:13',
    ])
  })

  it('keeps replies visible when the original is missing and handles malformed cycles without losing entries', () => {
    expect(groupPrConversation([comment(1, { replyTo: 999 }), comment(2, { replyTo: 1 })])).toMatchObject([
      { entry: { id: '2:1' }, detachedReply: true, replies: [{ id: '2:2' }] },
    ])
    const cyclic = groupPrConversation([comment(1, { replyTo: 2 }), comment(2, { replyTo: 1 })])
    expect(cyclic.map((thread) => thread.entry.id)).toEqual(['2:1', '2:2'])
    expect(cyclic.every((thread) => thread.detachedReply)).toBe(true)
  })

  it('supports earlier API records with prefixed IDs and no separate commentId field', () => {
    const root = comment(1, { commentId: undefined })
    const reply = comment(2, { commentId: undefined, replyTo: 1 })
    expect(groupPrConversation([reply, root])).toMatchObject([
      { entry: { id: '2:1' }, replies: [{ id: '2:2' }] },
    ])
  })
})

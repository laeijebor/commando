import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../shared/agent-chat'
import type { SessionAsk, SessionBrief } from '../../shared/protocol'
import { askAnchors, askMarkerCounts, paneAsks } from './sessionAsks'

const item = (id: string, kind: 'user_message' | 'assistant_message', turnId: string, createdAt: number, parentToolUseId?: string) =>
  ({ id, kind, text: id, turnId, status: 'completed', createdAt, updatedAt: createdAt, ...(parentToolUseId ? { parentToolUseId } : {}) }) as ChatItem
const ask = (key: string, askedAt: number): SessionAsk => ({ key, question: `${key}?`, options: [], askedAt })

describe('askAnchors', () => {
  const items = [
    item('u1', 'user_message', 't1', 10),
    item('a1', 'assistant_message', 't1', 20),
    item('u2', 'user_message', 't2', 30),
    item('a2-early', 'assistant_message', 't2', 35),
    item('sub', 'assistant_message', 't2', 45, 'tool-1'),
    // The turn's last reply, written after the agent raised its asks.
    item('a2', 'assistant_message', 't2', 50),
  ]

  it('anchors each ask to the last reply of the turn it was raised in', () => {
    const anchors = askAnchors(items, [ask('one', 40), ask('two', 41), ask('old', 25)])
    expect(Object.fromEntries(anchors)).toEqual({ one: 'a2', two: 'a2', old: 'a1' })
    expect(Object.fromEntries(askMarkerCounts(anchors))).toEqual({ a2: 2, a1: 1 })
  })

  it('leaves an ask raised before the conversation began unanchored', () => {
    expect(askAnchors(items, [ask('before', 5)]).size).toBe(0)
  })
})

describe('paneAsks', () => {
  it('ignores asks on a brief that belongs to an earlier pane', () => {
    const brief = { targetId: 'target-a', asks: [ask('one', 1)] } as SessionBrief
    expect(paneAsks(brief, { targetId: 'target-a' })).toHaveLength(1)
    expect(paneAsks(brief, { targetId: 'target-b' })).toHaveLength(0)
    expect(paneAsks(undefined, { targetId: 'target-a' })).toHaveLength(0)
  })
})

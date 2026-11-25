import { describe, expect, it } from 'vitest'
import { MAX_CHAT_ITEMS, type ChatAsideInfo, type ChatItem } from '../../shared/agent-chat.js'
import { AsideTimeline } from './aside-timeline.js'

const aside: ChatAsideInfo = { parentPaneId: '%3', id: 'abcd1234', title: 'Side', mode: 'read-only', method: 'fork', readOnlyEnforced: true, forkedFrom: { sessionId: 'main', at: 'finished' }, createdAt: 1 }
const message = (id: string, text: string): ChatItem => ({ id, text, kind: 'user_message', turnId: id, status: 'completed', createdAt: 2, updatedAt: 2 })

describe('aside timeline delivery', () => {
  it('updates one origin notice and includes it again when the timeline is replaced', () => {
    const timeline = new AsideTimeline(aside)
    const initial = timeline.updates([])
    expect(initial).toHaveLength(1)
    timeline.cut([{ id: 'finished' }], (item) => item.id, () => 2)
    const changed = timeline.updates([message('own', 'Question')])
    expect(changed[0]).toMatchObject({ id: initial[0].id, text: 'Forked from Main · 2 earlier messages hidden' })
    expect(timeline.updates([])).toEqual([])
    expect(timeline.updates([], true)).toEqual([changed[0]])
    expect(timeline.snapshot([])).toEqual([changed[0]])
  })

  it('keeps the origin first in bounded snapshots without retaining old messages', () => {
    const timeline = new AsideTimeline(aside)
    const items = Array.from({ length: MAX_CHAT_ITEMS }, (_, index) => message(String(index), 'Question'))
    const snapshot = timeline.snapshot(items)
    expect(snapshot).toHaveLength(MAX_CHAT_ITEMS)
    expect(snapshot[0]).toMatchObject({ kind: 'notice' })
    expect(snapshot[1].id).toBe('1')
    expect(snapshot.at(-1)).toBe(items.at(-1))
  })

  it('leaves main history and message text untouched', () => {
    const timeline = new AsideTimeline()
    const items = [message('main', 'Context from the main conversation (instructions)\nMain\n---\nQuestion')]
    expect(timeline.cut(items, (item) => item.id, () => 2)).toBe(items)
    expect(timeline.updates(items)).toEqual(items)
    expect(timeline.snapshot(items)).toEqual(items)
  })
})

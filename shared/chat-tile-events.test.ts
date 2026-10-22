import { describe, expect, it } from 'vitest'

import type { ChatItem } from './agent-chat.js'
import { isRedlineArtifactUrl, parseTileEventIds, tileEventMarker, tileEventSummary, tileEventTitle, tileSource, withTileEvents, type ChatTileEvent } from './chat-tile-events.js'

const base = { status: 'completed' as const, updatedAt: 0 }
const user = (id: string, text: string, createdAt: number): ChatItem => ({ ...base, id, kind: 'user_message', text, turnId: `turn-${id}`, createdAt })
const reply = (id: string, createdAt: number, parentToolUseId?: string): ChatItem => ({ ...base, id, kind: 'assistant_message', text: 'ok', turnId: 'turn-a', createdAt, ...(parentToolUseId ? { parentToolUseId } : {}) })
const event = (id: string, at: number): ChatTileEvent => ({ id, kind: 'sent', paneId: '%1', webPaneId: 'w-1', source: 'redline', fileName: 'plan.html', at, items: [], status: 'sent' })

describe('tile event markers', () => {
  it('round-trips ids on the last line only', () => {
    expect(parseTileEventIds(`Redline feedback…\n${tileEventMarker(['te-1', 'te-2'])}`)).toEqual(['te-1', 'te-2'])
    expect(parseTileEventIds(`${tileEventMarker(['te-1'])}\nmore text`)).toEqual([])
    expect(parseTileEventIds('commando-tile-event: bad id!')).toEqual([])
  })
})

describe('withTileEvents', () => {
  it('places cards by time among the main conversation, skipping subagent items', () => {
    const items = [user('u1', 'hi', 100), reply('sub', 250, 'tool-1'), reply('a1', 300)]
    const merged = withTileEvents(items, [event('te-2', 400), event('te-1', 200)])
    expect(merged.map((item) => item.id)).toEqual(['u1', 'sub', 'tile-event-te-1', 'a1', 'tile-event-te-2'])
    const card = merged[2] as Extract<ChatItem, { kind: 'user_message' }>
    expect(card.tileEvents?.[0]!.id).toBe('te-1')
    expect(card.turnId).toBe('turn-u1')
  })

  it('turns a pushed prompt into its cards instead of adding them again', () => {
    const pushed = user('u2', `Redline feedback on "Plan"…\n${tileEventMarker(['te-1'])}`, 500)
    const merged = withTileEvents([pushed], [event('te-1', 450)])
    expect(merged).toHaveLength(1)
    expect((merged[0] as Extract<ChatItem, { kind: 'user_message' }>).tileEvents?.map((item) => item.id)).toEqual(['te-1'])
  })

  it('leaves a pushed prompt as text when its events are gone', () => {
    const pushed = user('u2', `Redline feedback…\n${tileEventMarker(['te-9'])}`, 500)
    expect(withTileEvents([pushed], [event('te-1', 600)])[0]).toBe(pushed)
  })

  it('shows only this conversation’s cards, and unscoped ones only within its items', () => {
    const items = [user('u1', 'hi', 100)]
    const events = [
      event('te-old', 50), { ...event('te-other', 200), sessionId: 'other' },
      { ...event('te-early', 40), sessionId: 'mine' }, { ...event('te-mine', 300), sessionId: 'mine' },
    ]
    // A resumed chat restamps its items, so a scoped card older than them still shows.
    expect(withTileEvents(items, events, 'mine').map((item) => item.id)).toEqual(['tile-event-te-early', 'u1', 'tile-event-te-mine'])
    // A new chat in a reused pane has no id yet and an empty timeline: no old cards.
    expect(withTileEvents([], events, undefined)).toEqual([])
  })
})

describe('labels', () => {
  it('summarises and names events', () => {
    expect(tileEventSummary([
      { kind: 'answer', question: 'a', answer: 'b' }, { kind: 'answer', question: 'c', answer: 'd' },
      { kind: 'comment', target: 'x', comment: 'y' }, { kind: 'answer', question: 'e', answer: '(skipped)', skipped: true },
    ])).toBe('2 answers, 1 comment, 1 skipped')
    expect(tileEventTitle({ title: '  ', fileName: 'plan.html' })).toBe('plan.html')
    expect(tileSource({})).toBe('redline')
    expect(tileSource({ content: { kind: 'canvas' } })).toBe('canvas')
    expect(tileSource({ content: { kind: 'guide' } })).toBeUndefined()
    expect(isRedlineArtifactUrl('http://127.0.0.1:4310/redline/artifacts/abc/plan.html')).toBe(true)
    expect(isRedlineArtifactUrl('http://localhost:5173/')).toBe(false)
  })
})

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WebPane, WebPaneFeedbackNote } from '../shared/protocol.js'
import { ChatTileEvents, TILE_EVENTS_PER_PANE } from './chat-tile-events.js'

const pane = { id: 'w-1', anchorPaneId: '%5', url: 'http://127.0.0.1:4310/redline/artifacts/abc/settings.html', title: '' } as WebPane
const answer = (key: string, extra: Partial<WebPaneFeedbackNote> = {}): WebPaneFeedbackNote => ({
  deliveryKey: key, selector: '#q', tag: 'redline-choice', rect: { x: 0, y: 0, width: 1, height: 1 }, comment: 'Plan?: Pro',
  pageUrl: pane.url, capturedAt: 1, response: { question: 'Plan?', answer: 'Pro', note: 'cheaper' }, ...extra,
})
const comment = (key: string): WebPaneFeedbackNote => ({
  deliveryKey: key, selector: '#save', tag: 'button', text: 'Save changes', rect: { x: 0, y: 0, width: 1, height: 1 }, comment: 'Make it sticky',
  pageUrl: pane.url, capturedAt: 1, attachments: [{ id: 'a', name: 'x.png', contentType: 'image/png', size: 1, path: '/x' }],
})

let dir: string
let path: string
let clock = 1_000
let ids = 0
const store = (publish = vi.fn()) => new ChatTileEvents({ path, publish, now: () => clock, newId: () => `te-${++ids}` })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tile-events-')); path = join(dir, 'events.json'); clock = 1_000; ids = 0 })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ChatTileEvents', () => {
  it('records a Send for the tile’s chat and publishes it', () => {
    const publish = vi.fn()
    const events = store(publish)
    const event = events.sent(pane, 'redline', [answer('k1'), comment('k2')])
    expect(event).toMatchObject({
      id: 'te-1', kind: 'sent', paneId: '%5', webPaneId: 'w-1', source: 'redline', fileName: 'settings.html', at: 1_000, status: 'sent',
      items: [
        { kind: 'answer', question: 'Plan?', answer: 'Pro', note: 'cheaper' },
        { kind: 'comment', target: 'button “Save changes”', comment: 'Make it sticky', attachments: 1 },
      ],
    })
    expect(event).not.toHaveProperty('deliveryKeys')
    expect(publish).toHaveBeenCalledWith('%5', [event])
  })

  it('ignores a retried Send and marks skipped answers and build intent', () => {
    const events = store()
    events.sent(pane, 'redline', [answer('k1')])
    expect(events.sent(pane, 'redline', [answer('k1')])).toBeUndefined()
    const next = events.sent(pane, 'redline', [answer('k3', { response: { question: 'Q', answer: '(skipped)', data: { skipped: true } }, handoff: { kind: 'build', instruction: 'go' } })])
    expect(next).toMatchObject({ build: true, items: [{ kind: 'answer', skipped: true }] })
  })

  it('moves waiting → sent → collected, and finds events by delivery key', () => {
    const events = store()
    const event = events.sent(pane, 'redline', [answer('k1'), answer('k2')], { waiting: true })!
    expect(event.status).toBe('waiting')
    expect(events.idsFor('w-1', ['k2'])).toEqual([event.id])
    events.delivered([event.id])
    expect(events.forPane('%5')[0]!.status).toBe('sent')
    clock = 2_000
    events.collected('w-1', ['k1'])
    expect(events.forPane('%5')[0]).toMatchObject({ status: 'collected', collectedAt: 2_000 })
  })

  it('stops waiting once a poll drains the tile, and keeps the chat session', () => {
    const events = store()
    events.sent(pane, 'redline', [answer('k1')], { waiting: true, sessionId: 's-1' })
    events.drained('w-other')
    expect(events.forPane('%5')[0]).toMatchObject({ status: 'waiting', sessionId: 's-1' })
    events.drained('w-1')
    expect(events.forPane('%5')[0]!.status).toBe('sent')
  })

  it('fills a missing title later and survives a restart', () => {
    const events = store()
    events.opened(pane, 'redline')
    events.retitle('w-1', 'Notification settings')
    expect(events.forPane('%5')[0]!.title).toBe('Notification settings')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1)
    expect(store().forPane('%5')).toEqual(events.forPane('%5'))
  })

  it('keeps the newest events per chat', () => {
    const events = store()
    for (let index = 0; index < TILE_EVENTS_PER_PANE + 5; index += 1) events.opened(pane, 'redline')
    const kept = events.forPane('%5')
    expect(kept).toHaveLength(TILE_EVENTS_PER_PANE)
    expect(kept[0]!.id).toBe('te-6')
  })
})

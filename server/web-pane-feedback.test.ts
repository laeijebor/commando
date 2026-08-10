import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPaneFeedbackNote } from '../shared/protocol.js'
import { DELIVERY_DEDUPE_TTL_MS, FeedbackJournal } from './web-pane-feedback-journal.js'
import { MAX_QUEUED_FEEDBACK_NOTES, WebPaneFeedbackStore } from './web-pane-feedback.js'
import { PendingNotesJournal, WebPanePendingStore } from './web-pane-pending.js'
import { WebPaneError } from './web-panes.js'

const dirs: string[] = []

function makeStore(options: {
  onDrain?: (id: string) => void
  now?: () => number
  dir?: string
  releaseAttachment?: (id: string) => void
} = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'commando-feedback-store-'))
  if (!options.dir) dirs.push(dir)
  return {
    dir,
    store: new WebPaneFeedbackStore(
      new FeedbackJournal({ dir, now: options.now }),
      options.onDrain,
      options.now,
      options.releaseAttachment,
    ),
  }
}

afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function note(comment = 'too cramped', deliveryKey?: string): WebPaneFeedbackNote {
  return {
    ...(deliveryKey !== undefined ? { deliveryKey } : {}),
    selector: '#root > button',
    tag: 'button',
    rect: { x: 1, y: 2, width: 30, height: 10 },
    comment,
    pageUrl: 'http://127.0.0.1:5173/',
    capturedAt: 1_000,
  }
}

describe('WebPaneFeedbackStore', () => {
  it('drains queued notes immediately with ids and a cursor, and records the drain', async () => {
    const onDrain = vi.fn()
    const { store } = makeStore({ onDrain, now: () => 42 })
    store.enqueue('w-11111111', [note('a'), note('b')])
    const result = await store.drain('w-11111111', 0)
    expect(result.notes.map((entry) => entry.comment)).toEqual(['a', 'b'])
    expect(result.notes.map((entry) => entry.id)).toEqual([1, 2])
    expect(result.cursor).toBe(2)
    expect(onDrain).toHaveBeenCalledWith('w-11111111')
    expect(store.info()['w-11111111']).toEqual({ queued: 0, lastDrainCount: 2, lastDrainAt: 42 })
  })

  it('redelivers unacked notes to a retry (the lost-response case)', async () => {
    const { store } = makeStore()
    store.enqueue('w-11111111', [note('a')])
    const first = await store.drain('w-11111111', 0)
    // The response never reached the agent; its retry has no new cursor.
    const retry = await store.drain('w-11111111', 0)
    expect(retry.notes.map((entry) => entry.comment)).toEqual(['a'])
    expect(retry.cursor).toBe(first.cursor)
  })

  it('drops notes once the cursor comes back, then waits for new ones', async () => {
    vi.useFakeTimers()
    const { store } = makeStore()
    store.enqueue('w-11111111', [note('a')])
    const { cursor } = await store.drain('w-11111111', 0)
    const pending = store.drain('w-11111111', 5_000, { cursor })
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).notes).toEqual([])
  })

  it('retains sent attachments until their delivered feedback is acknowledged', async () => {
    const releaseAttachment = vi.fn()
    const { store } = makeStore({ releaseAttachment })
    const attached = {
      ...note('with image'),
      attachments: [{
        id: '11111111-1111-4111-8111-111111111111.png',
        name: 'screen.png',
        contentType: 'image/png',
        size: 8,
        path: '/api/web-panes/w-11111111/attachments/11111111-1111-4111-8111-111111111111.png',
      }],
    }
    store.enqueue('w-11111111', [attached])
    expect(store.referencesAttachment('w-11111111', attached.attachments[0].id)).toBe(true)
    expect(store.referencedAttachmentIds()).toEqual(new Set([attached.attachments[0].id]))
    expect(releaseAttachment).not.toHaveBeenCalled()

    const { cursor } = await store.drain('w-11111111', 0)
    expect(releaseAttachment).not.toHaveBeenCalled()
    await store.drain('w-11111111', 0, { cursor })
    expect(releaseAttachment).toHaveBeenCalledWith(attached.attachments[0].id)
    expect(store.referencesAttachment('w-11111111', attached.attachments[0].id)).toBe(false)
  })

  it('clamps acks to what was delivered — a wild cursor cannot discard unseen answers', async () => {
    const { store } = makeStore()
    store.enqueue('w-11111111', [note('a')])
    await store.drain('w-11111111', 0)
    store.enqueue('w-11111111', [note('b')])
    const result = await store.drain('w-11111111', 0, { cursor: 999 })
    expect(result.notes.map((entry) => entry.comment)).toEqual(['b'])
  })

  it('survives a restart: a fresh store over the same journal re-offers the backlog', async () => {
    const { store, dir } = makeStore()
    store.enqueue('w-11111111', [note('kept')])
    await store.drain('w-11111111', 0)
    const { store: reborn } = makeStore({ dir })
    const result = await reborn.drain('w-11111111', 0)
    expect(result.notes.map((entry) => entry.comment)).toEqual(['kept'])
    expect(result.notes[0]?.id).toBe(1)
  })

  it('deduplicates an acknowledged pending resend after restart without changing feedback ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commando-feedback-retry-'))
    dirs.push(dir)
    const paneId = 'w-11111111'
    const firstFeedback = new WebPaneFeedbackStore(new FeedbackJournal({ dir }))
    const firstPending = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    firstPending.addNote(paneId, 'http://127.0.0.1:5173/', {
      selector: '#root',
      tag: 'div',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      comment: 'survives transfer crash',
    })
    expect(() => firstPending.send(paneId, 'http://127.0.0.1:5173/', 1, (notes) => {
      firstFeedback.enqueue(paneId, notes)
      throw new Error('simulated crash before pending removal')
    })).toThrow('simulated crash')

    const rebornJournal = new FeedbackJournal({ dir })
    const rebornFeedback = new WebPaneFeedbackStore(rebornJournal)
    const rebornPending = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    const drained = await rebornFeedback.drain(paneId, 0)
    const deliveryKey = drained.notes[0]?.deliveryKey
    await rebornFeedback.drain(paneId, 0, { cursor: drained.cursor })
    rebornPending.send(paneId, 'http://127.0.0.1:5173/', 2, (notes) => rebornFeedback.enqueue(paneId, notes))

    expect(drained.notes.map((entry) => ({ id: entry.id, comment: entry.comment })))
      .toEqual([{ id: 1, comment: 'survives transfer crash' }])
    expect(await rebornFeedback.drain(paneId, 0)).toEqual({ notes: [], cursor: 1 })
    expect(rebornJournal.load(paneId)).toMatchObject({
      notes: [],
      deliveryKeys: [deliveryKey],
      nextId: 2,
    })
    expect(rebornPending.list(paneId)).toEqual([])
  })

  it('deduplicates a crash-left pending note after it is acknowledged in one pane and adopted into another', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commando-feedback-cross-pane-retry-'))
    dirs.push(dir)
    const paneA = 'w-11111111'
    const paneB = 'w-22222222'
    const url = 'http://127.0.0.1:5173/'
    const firstFeedback = new WebPaneFeedbackStore(new FeedbackJournal({ dir }))
    const firstPending = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    firstPending.addNote(paneA, url, {
      selector: '#root',
      tag: 'div',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      comment: 'survives cross-pane transfer crash',
    })
    expect(() => firstPending.send(paneA, url, 1, (notes) => {
      firstFeedback.enqueue(paneA, notes)
      throw new Error('simulated crash before pending removal')
    })).toThrow('simulated crash')

    const rebornFeedback = new WebPaneFeedbackStore(new FeedbackJournal({ dir }))
    const rebornPending = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    const deliveredA = await rebornFeedback.drain(paneA, 0)
    await rebornFeedback.drain(paneA, 0, { cursor: deliveredA.cursor })
    const adopted = rebornPending.adopt(paneB, url, new Set([paneB]))
    rebornPending.send(paneB, url, adopted.revision ?? 0, (notes) => rebornFeedback.enqueue(paneB, notes))

    expect(deliveredA.notes.map((entry) => entry.comment)).toEqual(['survives cross-pane transfer crash'])
    expect(await rebornFeedback.drain(paneB, 0)).toEqual({ notes: [], cursor: 0 })
    expect(rebornPending.list(paneB)).toEqual([])
  })

  it('expires historical cross-pane dedupe but retains an old key while its note is live', async () => {
    let now = 1_000
    const { store } = makeStore({ now: () => now })
    const key = 'pending:w-11111111:1'
    store.enqueue('w-11111111', [note('old live note', key)])
    const delivered = await store.drain('w-11111111', 0)
    now += DELIVERY_DEDUPE_TTL_MS

    store.enqueue('w-22222222', [note('suppressed while live', key)])
    expect(await store.drain('w-22222222', 0)).toEqual({ notes: [], cursor: 0 })

    await store.drain('w-11111111', 0, { cursor: delivered.cursor })
    store.enqueue('w-22222222', [note('accepted after expiry', key)])
    expect((await store.drain('w-22222222', 0)).notes.map((entry) => entry.comment))
      .toEqual(['accepted after expiry'])
  })

  it('keeps direct keyless notes append-only while distinct delivery keys both deliver', async () => {
    const { store } = makeStore()
    store.enqueue('w-11111111', [note('direct'), note('direct')])
    store.enqueue('w-11111111', [
      note('revision one', 'pending:w-11111111:1'),
      note('duplicate revision', 'pending:w-11111111:1'),
      note('later item', 'pending:w-11111111:2'),
    ])

    const result = await store.drain('w-11111111', 0)
    expect(result.notes.map((entry) => entry.comment)).toEqual([
      'direct',
      'direct',
      'revision one',
      'later item',
    ])
  })

  it('keeps answers for closed tiles: retain() drops memory, not the journal', async () => {
    const { store } = makeStore()
    store.enqueue('w-22222222', [note('after close')])
    store.retain(new Set(['w-33333333']))
    expect(store.info()).toEqual({})
    expect(store.hasUnacked('w-22222222')).toBe(true)
    const result = await store.drain('w-22222222', 0)
    expect(result.notes.map((entry) => entry.comment)).toEqual(['after close'])
    await store.drain('w-22222222', 0, { cursor: result.cursor })
    expect(store.hasUnacked('w-22222222')).toBe(false)
  })

  it('returns empty (and records nothing) when the wait times out', async () => {
    vi.useFakeTimers()
    const onDrain = vi.fn()
    const { store } = makeStore({ onDrain })
    const pending = store.drain('w-11111111', 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).notes).toEqual([])
    expect(onDrain).not.toHaveBeenCalled()
    expect(store.info()['w-11111111']).toBeUndefined()
  })

  it('wakes a waiting drain when notes arrive', async () => {
    vi.useFakeTimers()
    const { store } = makeStore()
    const pending = store.drain('w-11111111', 30_000)
    store.enqueue('w-11111111', [note()])
    expect((await pending).notes.length).toBe(1)
    expect(store.info()['w-11111111']?.queued).toBe(0)
  })

  it('hands a batch to only the first of two concurrent waiters', async () => {
    vi.useFakeTimers()
    const { store } = makeStore()
    const first = store.drain('w-11111111', 30_000)
    const second = store.drain('w-11111111', 30_000)
    store.enqueue('w-11111111', [note()])
    expect((await first).notes.length).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await second).notes).toEqual([])
  })

  it('throws 429 when undelivered notes pass the cap, but delivered-unacked notes do not count', async () => {
    const { store } = makeStore()
    for (let i = 0; i < MAX_QUEUED_FEEDBACK_NOTES; i += 1) store.enqueue('w-11111111', [note()])
    expect(() => store.enqueue('w-11111111', [note()])).toThrowError(WebPaneError)
    try {
      store.enqueue('w-11111111', [note()])
    } catch (error) {
      expect((error as WebPaneError).status).toBe(429)
    }
    // Delivery clears the undelivered window even though nothing is acked yet.
    await store.drain('w-11111111', 0)
    expect(() => store.enqueue('w-11111111', [note('post-drain')])).not.toThrow()
  })

  it('applies capacity only after keyed retries are deduplicated', () => {
    const { store } = makeStore()
    for (let i = 0; i < MAX_QUEUED_FEEDBACK_NOTES; i += 1) {
      store.enqueue('w-11111111', [note(`note ${i}`, `pending:w-11111111:${i + 1}`)])
    }

    expect(() => store.enqueue('w-11111111', [note('retry', 'pending:w-11111111:1')])).not.toThrow()
    expect(store.info()['w-11111111']?.queued).toBe(MAX_QUEUED_FEEDBACK_NOTES)
    expect(() => store.enqueue('w-11111111', [note('new', 'pending:w-11111111:51')])).toThrow(WebPaneError)
  })

  it('does not retain a delivery key when capacity validation fails', async () => {
    const { store } = makeStore()
    for (let i = 0; i < MAX_QUEUED_FEEDBACK_NOTES; i += 1) store.enqueue('w-11111111', [note(`note ${i}`)])
    expect(() => store.enqueue('w-11111111', [note('retry me', 'pending:w-11111111:51')])).toThrow(WebPaneError)

    const { cursor } = await store.drain('w-11111111', 0)
    await store.drain('w-11111111', 0, { cursor })
    store.enqueue('w-11111111', [note('retry me', 'pending:w-11111111:51')])

    expect((await store.drain('w-11111111', 0)).notes.map((entry) => entry.comment)).toEqual(['retry me'])
  })

  it('does not retain a delivery key or consume an id when journal append fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'commando-feedback-append-failure-'))
    dirs.push(dir)
    const journal = new FeedbackJournal({ dir })
    vi.spyOn(journal, 'appendNotes').mockImplementationOnce(() => {
      throw new Error('append failed')
    })
    const store = new WebPaneFeedbackStore(journal)
    const keyed = note('retry me', 'pending:w-11111111:1')

    expect(() => store.enqueue('w-11111111', [keyed])).toThrow('append failed')
    store.enqueue('w-11111111', [keyed])

    expect((await store.drain('w-11111111', 0)).notes.map((entry) => ({ id: entry.id, deliveryKey: entry.deliveryKey })))
      .toEqual([{ id: 1, deliveryKey: 'pending:w-11111111:1' }])
  })

  it('retain() rejects waiters for dead panes with 404', async () => {
    vi.useFakeTimers()
    const { store } = makeStore()
    const waiting = store.drain('w-11111111', 30_000)
    store.retain(new Set(['w-33333333']))
    await expect(waiting).rejects.toMatchObject({ status: 404 })
  })

  it('an aborted drain resolves empty without recording a drain', async () => {
    vi.useFakeTimers()
    const { store } = makeStore()
    const controller = new AbortController()
    const pending = store.drain('w-11111111', 30_000, { signal: controller.signal })
    controller.abort()
    expect((await pending).notes).toEqual([])
    store.enqueue('w-11111111', [note()])
    expect(store.info()['w-11111111']?.queued).toBe(1)
  })
})

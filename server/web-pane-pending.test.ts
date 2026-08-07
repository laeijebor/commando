import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PENDING_NOTES, type WebPaneFeedbackNote, type WebPanePendingNote } from '../shared/protocol.js'
import type { RedlinePageResponse } from '../shared/redline-response.js'
import { JOURNAL_COMPACT_THRESHOLD } from './web-pane-feedback-journal.js'
import { PendingNotesJournal, WebPanePendingStore, type PendingNoteInput } from './web-pane-pending.js'
import { WebPaneError } from './web-panes.js'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'commando-pending-journal-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manualNote(comment: string): PendingNoteInput {
  return {
    selector: '#root',
    tag: 'div',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    comment,
  }
}

function response(answer: string, queueKey?: string): RedlinePageResponse {
  return {
    question: 'Ship it?',
    answer,
    ...(queueKey !== undefined ? { queueKey } : {}),
  }
}

describe('PendingNotesJournal', () => {
  it('round-trips notes and removals through append and load', () => {
    const journal = new PendingNotesJournal({ dir: makeDir(), now: () => 7 })
    const note: WebPanePendingNote = { ...manualNote('a'), id: 1 }
    journal.appendNote('w-11111111', note)
    journal.appendNote('w-11111111', { ...manualNote('b'), id: 2 })
    journal.appendRemovals('w-11111111', [1])
    const state = journal.load('w-11111111')
    expect(state.nextId).toBe(3)
    expect(state.notes.map((entry) => entry.comment)).toEqual(['b'])
  })

  it('returns an empty state for a pane with no journal', () => {
    const journal = new PendingNotesJournal({ dir: makeDir() })
    expect(journal.load('w-22222222')).toEqual({ notes: [], nextId: 1 })
  })

  it('survives corrupt lines and unknown entry kinds', () => {
    const dir = makeDir()
    const journal = new PendingNotesJournal({ dir })
    journal.appendNote('w-11111111', { ...manualNote('keep'), id: 1 })
    const path = join(dir, 'w-11111111.pending.jsonl')
    writeFileSync(path, readFileSync(path, 'utf8') + 'not json\n{"k":"future"}\n')
    expect(journal.load('w-11111111').notes.map((note) => note.comment)).toEqual(['keep'])
  })

  it('compacts a grown journal without losing live notes or the id counter', () => {
    const dir = makeDir()
    const journal = new PendingNotesJournal({ dir })
    for (let index = 1; index <= JOURNAL_COMPACT_THRESHOLD; index += 1) {
      journal.appendNote('w-11111111', { ...manualNote(`n${index}`), id: index })
      journal.appendRemovals('w-11111111', [index])
    }
    journal.compact('w-11111111')
    const raw = readFileSync(join(dir, 'w-11111111.pending.jsonl'), 'utf8')
    expect(raw.split('\n').filter((line) => line !== '').length).toBeLessThan(10)
    const state = journal.load('w-11111111')
    expect(state.notes).toEqual([])
    expect(state.nextId).toBe(JOURNAL_COMPACT_THRESHOLD + 1)
  })

  it('remove deletes the journal file', () => {
    const dir = makeDir()
    const journal = new PendingNotesJournal({ dir })
    journal.appendNote('w-11111111', { ...manualNote('a'), id: 1 })
    journal.remove('w-11111111')
    expect(journal.load('w-11111111')).toEqual({ notes: [], nextId: 1 })
  })

  it('rejects unsafe pane ids', () => {
    const journal = new PendingNotesJournal({ dir: makeDir() })
    expect(() => journal.appendNote('../evil', { ...manualNote('a'), id: 1 })).toThrow(/Unsafe/)
  })
})

describe('WebPanePendingStore', () => {
  function makeStore(): WebPanePendingStore {
    return new WebPanePendingStore(new PendingNotesJournal({ dir: makeDir() }))
  }

  it('queues page responses and manual notes with server-assigned ids', () => {
    const store = makeStore()
    store.addResponse('w-11111111', response('yes'))
    const notes = store.addNote('w-11111111', manualNote('too small'))
    expect(notes.map((note) => note.id)).toEqual([1, 2])
    expect(notes[0]?.comment).toBe('Ship it?: yes')
    expect(notes[0]?.response).toEqual({ question: 'Ship it?', answer: 'yes' })
    expect(notes[1]?.comment).toBe('too small')
  })

  it('replaces an unsent answer with the same queueKey', () => {
    const store = makeStore()
    store.addResponse('w-11111111', response('yes', 'q1'))
    store.addNote('w-11111111', manualNote('keep me'))
    const notes = store.addResponse('w-11111111', response('no', 'q1'))
    expect(notes.map((note) => note.comment)).toEqual(['keep me', 'Ship it?: no'])
  })

  it('drops the oldest response past the cap', () => {
    const store = makeStore()
    for (let index = 0; index < MAX_PENDING_NOTES + 1; index += 1) {
      store.addResponse('w-11111111', response(`a${index}`))
    }
    const notes = store.list('w-11111111')
    expect(notes.length).toBe(MAX_PENDING_NOTES)
    expect(notes[0]?.comment).toBe('Ship it?: a1')
  })

  it('rejects manual notes past the cap', () => {
    const store = makeStore()
    for (let index = 0; index < MAX_PENDING_NOTES; index += 1) {
      store.addNote('w-11111111', manualNote(`n${index}`))
    }
    expect(() => store.addNote('w-11111111', manualNote('overflow'))).toThrow(WebPaneError)
  })

  it('removes a single note by id', () => {
    const store = makeStore()
    store.addNote('w-11111111', manualNote('a'))
    store.addNote('w-11111111', manualNote('b'))
    expect(store.remove('w-11111111', 1).map((note) => note.comment)).toEqual(['b'])
  })

  it('send stamps pageUrl/capturedAt, strips queue metadata, and clears sent notes', () => {
    const store = makeStore()
    store.addResponse('w-11111111', response('yes', 'q1'))
    store.addNote('w-11111111', manualNote('manual'))
    let enqueued: WebPaneFeedbackNote[] = []
    const remaining = store.send('w-11111111', 'http://127.0.0.1:4310/x', 1_234, (notes) => {
      enqueued = notes
    })
    expect(remaining).toEqual([])
    expect(enqueued.map((note) => note.comment)).toEqual(['Ship it?: yes', 'manual'])
    expect(enqueued[0]).not.toHaveProperty('id')
    expect(enqueued[0]).not.toHaveProperty('queueKey')
    expect(enqueued[0]?.pageUrl).toBe('http://127.0.0.1:4310/x')
    expect(enqueued[0]?.capturedAt).toBe(1_234)
    expect(enqueued[0]?.response?.answer).toBe('yes')
  })

  it('send with ids moves only those notes', () => {
    const store = makeStore()
    store.addNote('w-11111111', manualNote('a'))
    store.addNote('w-11111111', manualNote('b'))
    const remaining = store.send('w-11111111', 'http://x/', 1, () => undefined, [1])
    expect(remaining.map((note) => note.comment)).toEqual(['b'])
  })

  it('a throwing enqueue leaves the pending queue untouched', () => {
    const store = makeStore()
    store.addNote('w-11111111', manualNote('a'))
    expect(() =>
      store.send('w-11111111', 'http://x/', 1, () => {
        throw new WebPaneError(429, 'full')
      }),
    ).toThrow(WebPaneError)
    expect(store.list('w-11111111').map((note) => note.comment)).toEqual(['a'])
  })

  it('send with no matching notes does not call enqueue', () => {
    const store = makeStore()
    let calls = 0
    store.send('w-11111111', 'http://x/', 1, () => {
      calls += 1
    })
    expect(calls).toBe(0)
  })

  it('persists pending notes across store instances via the journal', () => {
    const dir = makeDir()
    const first = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    first.addResponse('w-11111111', response('yes', 'q1'))
    first.addNote('w-11111111', manualNote('manual'))
    first.remove('w-11111111', 2)
    const second = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    const notes = second.list('w-11111111')
    expect(notes.map((note) => note.comment)).toEqual(['Ship it?: yes'])
    expect(notes[0]?.queueKey).toBe('q1')
    // Ids keep advancing — a restore cannot collide with a removed id.
    expect(second.addNote('w-11111111', manualNote('next'))[1]?.id).toBe(3)
  })

  it('retain drops state and journals for dead panes', () => {
    const dir = makeDir()
    const store = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    store.addNote('w-11111111', manualNote('a'))
    store.addNote('w-22222222', manualNote('b'))
    store.retain(new Set(['w-22222222']))
    expect(store.list('w-22222222').length).toBe(1)
    expect(new WebPanePendingStore(new PendingNotesJournal({ dir })).list('w-11111111')).toEqual([])
  })
})

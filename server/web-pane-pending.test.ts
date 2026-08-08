import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PENDING_NOTES, type WebPaneFeedbackNote, type WebPanePendingNote } from '../shared/protocol.js'
import type { RedlinePageResponse } from '../shared/redline-response.js'
import { JOURNAL_COMPACT_THRESHOLD } from './web-pane-feedback-journal.js'
import { PendingNotesJournal, WebPanePendingStore, type PendingNoteInput } from './web-pane-pending.js'
import { WebPaneError } from './web-panes.js'

const PAGE_URL = 'http://127.0.0.1:5173/'
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
    store.addResponse('w-11111111', PAGE_URL, response('yes'))
    const { notes } = store.addNote('w-11111111', PAGE_URL, manualNote('too small'))
    expect(notes.map((note) => note.id)).toEqual([1, 2])
    expect(notes[0]?.comment).toBe('Ship it?: yes')
    expect(notes[0]?.response).toEqual({ question: 'Ship it?', answer: 'yes' })
    expect(notes[1]?.comment).toBe('too small')
  })

  it('replaces an unsent answer with the same queueKey', () => {
    const store = makeStore()
    store.addResponse('w-11111111', PAGE_URL, response('yes', 'q1'))
    store.addNote('w-11111111', PAGE_URL, manualNote('keep me'))
    const { notes } = store.addResponse('w-11111111', PAGE_URL, response('no', 'q1'))
    expect(notes.map((note) => note.comment)).toEqual(['keep me', 'Ship it?: no'])
  })

  it('keeps distinct queueKeys and keyless answers separate', () => {
    const store = makeStore()
    store.addResponse('w-11111111', PAGE_URL, response('a', 'q1'))
    store.addResponse('w-11111111', PAGE_URL, response('b', 'q2'))
    const { notes } = store.addResponse('w-11111111', PAGE_URL, response('c'))
    expect(notes).toHaveLength(3)
  })

  it('uses page-provided selector/tag/rect, falling back to a redline synthetic', () => {
    const store = makeStore()
    store.addResponse('w-11111111', PAGE_URL, {
      ...response('a', 'q1'),
      selector: '#picker',
      tag: 'redline-choice',
      rect: { x: 1, y: 2, width: 3, height: 4 },
    })
    const { notes } = store.addResponse('w-11111111', PAGE_URL, response('b', 'q2'))
    expect(notes[0]).toMatchObject({
      selector: '#picker',
      tag: 'redline-choice',
      rect: { x: 1, y: 2, width: 3, height: 4 },
    })
    expect(notes[1]).toMatchObject({ selector: 'redline:q2', tag: 'redline' })
  })

  it('drops the oldest response past the cap', () => {
    const store = makeStore()
    for (let index = 0; index < MAX_PENDING_NOTES + 1; index += 1) {
      store.addResponse('w-11111111', PAGE_URL, response(`a${index}`))
    }
    const notes = store.list('w-11111111')
    expect(notes.length).toBe(MAX_PENDING_NOTES)
    expect(notes[0]?.comment).toBe('Ship it?: a1')
  })

  it('rejects manual notes past the cap', () => {
    const store = makeStore()
    for (let index = 0; index < MAX_PENDING_NOTES; index += 1) {
      store.addNote('w-11111111', PAGE_URL, manualNote(`n${index}`))
    }
    expect(() => store.addNote('w-11111111', PAGE_URL, manualNote('overflow'))).toThrow(WebPaneError)
  })

  it('removes a single note by id', () => {
    const store = makeStore()
    store.addNote('w-11111111', PAGE_URL, manualNote('a'))
    store.addNote('w-11111111', PAGE_URL, manualNote('b'))
    expect(store.remove('w-11111111', 1).notes.map((note) => note.comment)).toEqual(['b'])
  })

  it('send stamps pageUrl/capturedAt, strips queue metadata, and clears sent notes', () => {
    const store = makeStore()
    store.addResponse('w-11111111', PAGE_URL, response('yes', 'q1'))
    store.addNote('w-11111111', PAGE_URL, manualNote('manual'))
    let enqueued: WebPaneFeedbackNote[] = []
    const { notes: remaining } = store.send('w-11111111', 'http://127.0.0.1:4310/x', 1_234, (notes) => {
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
    store.addNote('w-11111111', PAGE_URL, manualNote('a'))
    store.addNote('w-11111111', PAGE_URL, manualNote('b'))
    const { notes: remaining } = store.send('w-11111111', 'http://x/', 1, () => undefined, [1])
    expect(remaining.map((note) => note.comment)).toEqual(['b'])
  })

  it('a throwing enqueue leaves the pending queue untouched', () => {
    const store = makeStore()
    store.addNote('w-11111111', PAGE_URL, manualNote('a'))
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
    first.addResponse('w-11111111', PAGE_URL, response('yes', 'q1'))
    first.addNote('w-11111111', PAGE_URL, manualNote('manual'))
    first.remove('w-11111111', 2)
    const second = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    const notes = second.list('w-11111111')
    expect(notes.map((note) => note.comment)).toEqual(['Ship it?: yes'])
    expect(notes[0]?.queueKey).toBe('q1')
    // Ids keep advancing — a restore cannot collide with a removed id.
    expect(second.addNote('w-11111111', PAGE_URL, manualNote('next')).notes[1]?.id).toBe(3)
  })

  it('retain drops in-memory state but leaves journals for adoption', () => {
    const dir = makeDir()
    const store = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    store.addNote('w-11111111', PAGE_URL, manualNote('a'))
    store.addNote('w-22222222', PAGE_URL, manualNote('b'))
    store.retain(new Set(['w-22222222']))
    expect(store.list('w-22222222').length).toBe(1)
    // The closed pane's notes are still on disk — a reopen can adopt them.
    expect(new WebPanePendingStore(new PendingNotesJournal({ dir })).list('w-11111111')).toHaveLength(1)
  })

  it('drop purges a pane outright', () => {
    const dir = makeDir()
    const store = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    store.addNote('w-11111111', PAGE_URL, manualNote('a'))
    store.drop('w-11111111')
    expect(new WebPanePendingStore(new PendingNotesJournal({ dir })).list('w-11111111')).toEqual([])
  })
})

describe('WebPanePendingStore adoption', () => {
  function makeStore(dir: string): WebPanePendingStore {
    return new WebPanePendingStore(new PendingNotesJournal({ dir }))
  }

  it('reopening the same URL inherits a closed pane\'s unsent notes with fresh ids', () => {
    const dir = makeDir()
    const closed = makeStore(dir)
    closed.addResponse('w-11111111', PAGE_URL, response('yes', 'q1'))
    closed.addNote('w-11111111', PAGE_URL, manualNote('annotation'))

    const reopened = makeStore(dir)
    const snapshot = reopened.adopt('w-22222222', PAGE_URL, new Set(['w-22222222']))
    expect(snapshot.notes.map((note) => note.comment)).toEqual(['Ship it?: yes', 'annotation'])
    expect(snapshot.notes.map((note) => note.id)).toEqual([1, 2])
    expect(snapshot.notes[0]?.response?.answer).toBe('yes')
    // The absorbed journal is deleted, so the notes cannot be adopted twice
    // while the pane that inherited them is still open.
    expect(existsSync(join(dir, 'w-11111111.pending.jsonl'))).toBe(false)
    expect(
      makeStore(dir).adopt('w-33333333', PAGE_URL, new Set(['w-22222222', 'w-33333333'])).notes,
    ).toEqual([])
  })

  it('does not inherit notes queued against a different URL', () => {
    const dir = makeDir()
    makeStore(dir).addNote('w-11111111', 'http://127.0.0.1:5173/other', manualNote('elsewhere'))
    const snapshot = makeStore(dir).adopt('w-22222222', PAGE_URL, new Set(['w-22222222']))
    expect(snapshot.notes).toEqual([])
  })

  it('does not steal from a pane that is still open on the same URL', () => {
    const dir = makeDir()
    const store = makeStore(dir)
    store.addNote('w-11111111', PAGE_URL, manualNote('still mine'))
    const snapshot = store.adopt('w-22222222', PAGE_URL, new Set(['w-11111111', 'w-22222222']))
    expect(snapshot.notes).toEqual([])
    expect(store.list('w-11111111')).toHaveLength(1)
  })

  it('appends inherited notes after the ones already queued', () => {
    const dir = makeDir()
    makeStore(dir).addNote('w-11111111', PAGE_URL, manualNote('from the closed tile'))
    const reopened = makeStore(dir)
    reopened.addNote('w-22222222', PAGE_URL, manualNote('queued first'))
    const snapshot = reopened.adopt('w-22222222', PAGE_URL, new Set(['w-22222222']))
    expect(snapshot.notes.map((note) => note.comment))
      .toEqual(['queued first', 'from the closed tile'])
  })

  it('discards an empty leftover journal instead of adopting nothing forever', () => {
    const dir = makeDir()
    const closed = makeStore(dir)
    closed.addNote('w-11111111', PAGE_URL, manualNote('a'))
    closed.send('w-11111111', PAGE_URL, 1, () => undefined)
    makeStore(dir).adopt('w-22222222', PAGE_URL, new Set(['w-22222222']))
    expect(existsSync(join(dir, 'w-11111111.pending.jsonl'))).toBe(false)
  })
})

describe('WebPanePendingStore snapshots', () => {
  function makeStore(): WebPanePendingStore {
    return new WebPanePendingStore(new PendingNotesJournal({ dir: makeDir() }))
  }

  it('knownUpTo covers every id ever issued, so sent notes never look unknown', () => {
    const store = makeStore()
    store.addNote('w-11111111', PAGE_URL, manualNote('a'))
    store.addNote('w-11111111', PAGE_URL, manualNote('b'))
    expect(store.snapshot('w-11111111').knownUpTo).toBe(2)
    store.send('w-11111111', PAGE_URL, 1, () => undefined)
    const after = store.snapshot('w-11111111')
    expect(after.notes).toEqual([])
    // The watermark holds after the queue empties — a mirrored note with id
    // 1 or 2 is therefore recognisably "already handled", not restorable.
    expect(after.knownUpTo).toBe(2)
  })

  it('a pane the daemon has never seen has a zero watermark', () => {
    expect(makeStore().snapshot('w-11111111')).toEqual({ notes: [], knownUpTo: 0, dropped: 0 })
  })

  it('counts capped page answers so the tile can show them, and clears on send', () => {
    const store = makeStore()
    for (let index = 0; index < MAX_PENDING_NOTES + 3; index += 1) {
      store.addResponse('w-11111111', PAGE_URL, response(`a${index}`))
    }
    expect(store.snapshot('w-11111111').dropped).toBe(3)
    expect(store.send('w-11111111', PAGE_URL, 1, () => undefined).dropped).toBe(0)
  })

  it('acknowledgeDropped clears the notice without touching the queue', () => {
    const store = makeStore()
    for (let index = 0; index < MAX_PENDING_NOTES + 1; index += 1) {
      store.addResponse('w-11111111', PAGE_URL, response(`a${index}`))
    }
    const snapshot = store.acknowledgeDropped('w-11111111')
    expect(snapshot.dropped).toBe(0)
    expect(snapshot.notes).toHaveLength(MAX_PENDING_NOTES)
  })
})

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PENDING_NOTE_ATTACHMENTS,
  MAX_PENDING_NOTES,
  type WebPaneFeedbackNote,
  type WebPaneImageAttachment,
  type WebPanePendingNote,
} from '../shared/protocol.js'
import type { RedlinePageResponse } from '../shared/redline-response.js'
import { JOURNAL_COMPACT_THRESHOLD } from './web-pane-feedback-journal.js'
import { PendingNotesJournal, WebPanePendingStore, type PendingNoteInput } from './web-pane-pending.js'
import { WebPaneError } from './web-panes.js'

const PAGE_URL = 'http://127.0.0.1:5173/'
const OTHER_PAGE_URL = 'http://127.0.0.1:5173/other'
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

function attachment(id: string): WebPaneImageAttachment {
  return { id, name: `${id}.png`, contentType: 'image/png', size: 12 }
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
    expect(journal.load('w-22222222')).toEqual({ notes: [], nextId: 1, revision: 0 })
  })

  it('survives corrupt lines and unknown entry kinds', () => {
    const dir = makeDir()
    const journal = new PendingNotesJournal({ dir })
    journal.appendNote('w-11111111', { ...manualNote('keep'), id: 1 })
    const path = join(dir, 'w-11111111.pending.jsonl')
    writeFileSync(path, readFileSync(path, 'utf8') + 'not json\n{"k":"future"}\n')
    expect(journal.load('w-11111111').notes.map((note) => note.comment)).toEqual(['keep'])
  })

  it('migrates historical notes to item revision 1 with no attachments', () => {
    const dir = makeDir()
    const path = join(dir, 'w-11111111.pending.jsonl')
    writeFileSync(path, `${JSON.stringify({ k: 'n', id: 7, note: { ...manualNote('old'), id: 7 } })}\n`)
    const state = new PendingNotesJournal({ dir }).load('w-11111111')
    expect(state.revision).toBe(1)
    expect(state.notes[0]).toMatchObject({ id: 7, revision: 1, attachments: [] })
  })

  it('fills a historical note pageUrl from the journal remembered URL', () => {
    const dir = makeDir()
    const path = join(dir, 'w-11111111.pending.jsonl')
    writeFileSync(path, [
      JSON.stringify({ k: 'n', id: 7, note: { ...manualNote('old'), id: 7 } }),
      JSON.stringify({ k: 'u', url: PAGE_URL }),
      '',
    ].join('\n'))

    const state = new PendingNotesJournal({ dir }).load('w-11111111')

    expect(state.notes[0]?.pageUrl).toBe(PAGE_URL)
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

  it('pins the snapshot revision through compaction', () => {
    const dir = makeDir()
    const journal = new PendingNotesJournal({ dir })
    journal.appendNote('w-11111111', {
      ...manualNote('keep'), id: 1, revision: 3, pageUrl: PAGE_URL, attachments: [],
    }, 11)
    for (let index = 0; index < JOURNAL_COMPACT_THRESHOLD; index += 1) {
      journal.appendRevision('w-11111111', 11)
    }
    journal.compact('w-11111111')
    const state = journal.load('w-11111111')
    expect(state.revision).toBe(11)
    expect(state.notes[0]?.revision).toBe(3)
    expect(state.notes[0]?.pageUrl).toBe(PAGE_URL)
  })

  it('remove deletes the journal file', () => {
    const dir = makeDir()
    const journal = new PendingNotesJournal({ dir })
    journal.appendNote('w-11111111', { ...manualNote('a'), id: 1 })
    journal.remove('w-11111111')
    expect(journal.load('w-11111111')).toEqual({ notes: [], nextId: 1, revision: 0 })
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
    expect(notes.map((note) => note.revision)).toEqual([1, 1])
    expect(notes.map((note) => note.attachments)).toEqual([[], []])
    expect(notes.map((note) => note.pageUrl)).toEqual([PAGE_URL, PAGE_URL])
    expect(notes[0]?.comment).toBe('Ship it?: yes')
    expect(notes[0]?.response).toEqual({ question: 'Ship it?', answer: 'yes' })
    expect(notes[1]?.comment).toBe('too small')
  })

  it('updates an unsent answer with the same queueKey in place', () => {
    const store = makeStore()
    const first = store.addResponse('w-11111111', PAGE_URL, response('yes', 'q1'))
    store.attach('w-11111111', 1, 1, attachment('kept'))
    store.addNote('w-11111111', PAGE_URL, manualNote('keep me'))
    const snapshot = store.addResponse('w-11111111', PAGE_URL, {
      ...response('no', 'q1'),
      note: 'because it is ready',
      selector: '#fresh',
      tag: 'button',
      text: 'Fresh',
      rect: { x: 1, y: 2, width: 3, height: 4 },
    })
    expect(first.notes[0]?.id).toBe(snapshot.notes[0]?.id)
    expect(snapshot.notes.map((note) => note.comment)).toEqual([
      'Ship it?: no\n\nNote: because it is ready',
      'keep me',
    ])
    expect(snapshot.notes[0]).toMatchObject({
      id: 1,
      revision: 3,
      selector: '#fresh',
      tag: 'button',
      text: 'Fresh',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      attachments: [attachment('kept')],
      pageUrl: PAGE_URL,
      response: { question: 'Ship it?', answer: 'no', note: 'because it is ready' },
    })
  })

  it('keeps the same queueKey on different pages as separate pending items', () => {
    const store = makeStore()
    store.addResponse('w-11111111', PAGE_URL, response('first', 'q1'))
    store.addResponse('w-11111111', OTHER_PAGE_URL, response('other page', 'q1'))
    const { notes } = store.addResponse('w-11111111', PAGE_URL, response('replacement', 'q1'))

    expect(notes).toHaveLength(2)
    expect(notes.map((note) => ({ pageUrl: note.pageUrl, answer: note.response?.answer }))).toEqual([
      { pageUrl: PAGE_URL, answer: 'replacement' },
      { pageUrl: OTHER_PAGE_URL, answer: 'other page' },
    ])
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

  it('updates component answers and notes, clears contradictory data, and persists revisions', () => {
    const dir = makeDir()
    const store = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    store.addResponse('w-11111111', PAGE_URL, {
      ...response('yes', 'q1'),
      note: ' first ',
      data: { selected: 'yes' },
    })
    const answered = store.update('w-11111111', 1, 1, { answer: 'no' })
    expect(answered.revision).toBe(2)
    expect(answered.notes[0]).toMatchObject({
      revision: 2,
      comment: 'Ship it?: no\n\nNote:  first ',
      response: { question: 'Ship it?', answer: 'no', note: ' first ' },
    })
    expect(answered.notes[0]?.response).not.toHaveProperty('data')

    const noted = store.update('w-11111111', 1, 2, { note: '  clearer  ' })
    expect(noted.notes[0]?.response?.note).toBe('clearer')
    expect(noted.notes[0]?.comment).toBe('Ship it?: no\n\nNote: clearer')
    const cleared = store.update('w-11111111', 1, 3, { note: '   ' })
    expect(cleared.notes[0]?.response).not.toHaveProperty('note')
    expect(cleared.notes[0]?.comment).toBe('Ship it?: no')

    const restarted = new WebPanePendingStore(new PendingNotesJournal({ dir })).snapshot('w-11111111')
    expect(restarted.revision).toBe(4)
    expect(restarted.notes[0]?.revision).toBe(4)
  })

  it('updates known choice data without discarding its option set', () => {
    const store = makeStore()
    store.addResponse('w-11111111', PAGE_URL, {
      ...response('Starter', 'plan'),
      data: { choice: 'Starter', options: ['Starter', 'Pro'], multiple: false },
    })

    const snapshot = store.update('w-11111111', 1, 1, { answer: 'Pro' })

    expect(snapshot.notes[0]?.response?.data).toEqual({
      choice: 'Pro',
      options: ['Starter', 'Pro'],
      multiple: false,
    })
  })

  it('clears a legacy approve comment when its response note is cleared', () => {
    const store = makeStore()
    store.addResponse('w-11111111', PAGE_URL, {
      ...response('reject', 'approval'),
      data: { verdict: 'reject', comment: 'legacy note' },
    })

    const snapshot = store.update('w-11111111', 1, 1, { note: '' })

    expect(snapshot.notes[0]?.response?.data).toEqual({ verdict: 'reject' })
    expect(snapshot.notes[0]?.response).not.toHaveProperty('note')
  })

  it('edits a manual annotation comment through answer', () => {
    const store = makeStore()
    store.addNote('w-11111111', PAGE_URL, manualNote('old'))
    const snapshot = store.update('w-11111111', 1, 1, { answer: 'new comment' })
    expect(snapshot.notes[0]).toMatchObject({ revision: 2, comment: 'new comment' })
  })

  it('rejects stale or missing revisions atomically', () => {
    const store = makeStore()
    store.addResponse('w-11111111', PAGE_URL, response('yes', 'q1'))
    const before = store.snapshot('w-11111111')
    expect(() => store.update('w-11111111', 1, 2, { answer: 'no' })).toThrow(WebPaneError)
    expect(() => store.update('w-11111111', 999, 1, { answer: 'no' })).toThrow(WebPaneError)
    expect(() => store.update('w-11111111', 1, 1, {})).toThrow(WebPaneError)
    expect(store.snapshot('w-11111111')).toEqual(before)
    try {
      store.update('w-11111111', 1, 2, { answer: 'no' })
    } catch (error) {
      expect(error).toMatchObject({ status: 409 })
    }
  })

  it('attaches and detaches with revision guards, limits, duplicate checks, and release', () => {
    const release = vi.fn()
    const store = new WebPanePendingStore(new PendingNotesJournal({ dir: makeDir() }), release)
    store.addNote('w-11111111', PAGE_URL, manualNote('a'))
    let expectedRevision = 1
    for (let index = 0; index < MAX_PENDING_NOTE_ATTACHMENTS; index += 1) {
      const snapshot = store.attach('w-11111111', 1, expectedRevision, attachment(`a${index}`))
      expectedRevision = snapshot.notes[0]?.revision ?? 0
    }
    expect(store.list('w-11111111')[0]?.attachments).toHaveLength(MAX_PENDING_NOTE_ATTACHMENTS)
    expect(() => store.attach('w-11111111', 1, expectedRevision, attachment('overflow')))
      .toThrow(WebPaneError)
    expect(() => store.attach('w-11111111', 1, expectedRevision, attachment('a0')))
      .toThrow(WebPaneError)
    expect(() => store.detach('w-11111111', 1, expectedRevision - 1, 'a0'))
      .toThrow(WebPaneError)

    const detached = store.detach('w-11111111', 1, expectedRevision, 'a0')
    expect(detached.notes[0]?.attachments?.map((entry) => entry.id)).toEqual(['a1', 'a2', 'a3'])
    expect(release).toHaveBeenCalledWith('a0')
    expect(store.referencesAttachment('w-11111111', 'a0')).toBe(false)
    expect(store.referencesAttachment('w-11111111', 'a1')).toBe(true)
  })

  it('finds attachment references in unloaded orphan journals', () => {
    const dir = makeDir()
    const first = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    first.addNote('w-11111111', PAGE_URL, manualNote('a'))
    first.attach('w-11111111', 1, 1, attachment('orphan'))
    const restarted = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    expect(restarted.referencedAttachmentIds()).toEqual(new Set(['orphan']))
  })

  it('send uses each note pageUrl, stamps capturedAt, strips queue metadata, and clears sent notes', () => {
    const store = makeStore()
    store.addResponse('w-11111111', PAGE_URL, response('yes', 'q1'))
    store.addNote('w-11111111', OTHER_PAGE_URL, manualNote('manual'))
    let enqueued: WebPaneFeedbackNote[] = []
    const { notes: remaining } = store.send('w-11111111', 'http://127.0.0.1:4310/x', 1_234, (notes) => {
      enqueued = notes
    })
    expect(remaining).toEqual([])
    expect(enqueued.map((note) => note.comment)).toEqual(['Ship it?: yes', 'manual'])
    expect(enqueued[0]).not.toHaveProperty('id')
    expect(enqueued[0]).not.toHaveProperty('queueKey')
    expect(enqueued.map((note) => note.pageUrl)).toEqual([PAGE_URL, OTHER_PAGE_URL])
    expect(enqueued[0]?.capturedAt).toBe(1_234)
    expect(enqueued[0]?.response?.answer).toBe('yes')
  })

  it('send falls back to the current-page argument for a historical note without pageUrl', () => {
    const dir = makeDir()
    const journal = new PendingNotesJournal({ dir })
    journal.appendNote('w-11111111', { ...manualNote('historical'), id: 1 })
    const store = new WebPanePendingStore(new PendingNotesJournal({ dir }))
    let enqueued: WebPaneFeedbackNote[] = []

    store.send('w-11111111', OTHER_PAGE_URL, 1, (notes) => { enqueued = notes })

    expect(enqueued[0]?.pageUrl).toBe(OTHER_PAGE_URL)
  })

  it('send includes daemon attachment paths without releasing transferred ownership', () => {
    const release = vi.fn()
    const store = new WebPanePendingStore(new PendingNotesJournal({ dir: makeDir() }), release)
    store.addNote('w-11111111', PAGE_URL, manualNote('manual'))
    store.attach('w-11111111', 1, 1, attachment('image.png'))
    let enqueued: WebPaneFeedbackNote[] = []
    store.send('w-11111111', PAGE_URL, 1, (notes) => { enqueued = notes }, [1])
    expect(enqueued[0]?.attachments).toEqual([{
      ...attachment('image.png'),
      path: '/api/web-panes/w-11111111/attachments/image.png',
    }])
    expect(release).not.toHaveBeenCalled()
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
    expect(second.snapshot('w-11111111').revision).toBe(3)
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

  it('releases attachments on removal, cap eviction, and explicit drop', () => {
    const dir = makeDir()
    const release = vi.fn()
    const store = new WebPanePendingStore(new PendingNotesJournal({ dir }), release)
    store.addNote('w-11111111', PAGE_URL, manualNote('remove'))
    store.attach('w-11111111', 1, 1, attachment('removed'))
    store.remove('w-11111111', 1)
    expect(release).toHaveBeenCalledWith('removed')

    store.addNote('w-11111111', PAGE_URL, manualNote('evict'))
    store.attach('w-11111111', 2, 1, attachment('evicted'))
    for (let index = 0; index < MAX_PENDING_NOTES; index += 1) {
      store.addResponse('w-11111111', PAGE_URL, response(`a${index}`))
    }
    expect(release).toHaveBeenCalledWith('evicted')

    const last = store.list('w-11111111').at(-1)
    if (!last) throw new Error('expected a pending note')
    store.attach('w-11111111', last.id, last.revision ?? 1, attachment('dropped'))
    store.drop('w-11111111')
    expect(release).toHaveBeenCalledWith('dropped')
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
    closed.attach('w-11111111', 1, 1, attachment('adopted'))
    closed.addNote('w-11111111', PAGE_URL, manualNote('annotation'))

    const reopened = makeStore(dir)
    const snapshot = reopened.adopt('w-22222222', PAGE_URL, new Set(['w-22222222']))
    expect(snapshot.notes.map((note) => note.comment)).toEqual(['Ship it?: yes', 'annotation'])
    expect(snapshot.notes.map((note) => note.id)).toEqual([1, 2])
    expect(snapshot.notes[0]?.response?.answer).toBe('yes')
    expect(snapshot.notes[0]?.attachments).toEqual([attachment('adopted')])
    expect(snapshot.notes.map((note) => note.pageUrl)).toEqual([PAGE_URL, PAGE_URL])
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
    expect(makeStore().snapshot('w-11111111')).toEqual({ revision: 0, notes: [], knownUpTo: 0, dropped: 0 })
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

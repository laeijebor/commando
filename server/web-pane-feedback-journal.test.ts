import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebPaneFeedbackNote } from '../shared/protocol.js'
import { FeedbackJournal, JOURNAL_COMPACT_THRESHOLD } from './web-pane-feedback-journal.js'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'commando-feedback-journal-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function note(comment: string): WebPaneFeedbackNote {
  return {
    selector: '#root',
    tag: 'div',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    comment,
    pageUrl: 'http://127.0.0.1:5173/',
    capturedAt: 1_000,
  }
}

describe('FeedbackJournal', () => {
  it('round-trips notes and acks through append and load', () => {
    const journal = new FeedbackJournal({ dir: makeDir(), now: () => 7 })
    journal.appendNotes('w-11111111', [
      { id: 1, note: { ...note('a'), deliveryKey: 'pending:w-11111111:1' } },
      { id: 2, note: { ...note('b'), deliveryKey: 'pending:w-11111111:2' } },
    ])
    journal.appendAck('w-11111111', 1)
    const state = journal.load('w-11111111')
    expect(state.ackedUpTo).toBe(1)
    expect(state.nextId).toBe(3)
    expect(state.deliveryKeys).toEqual(['pending:w-11111111:1', 'pending:w-11111111:2'])
    expect(state.notes.map((entry) => entry.id)).toEqual([2])
    expect(state.notes[0]?.note.comment).toBe('b')
  })

  it('returns an empty state for a pane with no journal', () => {
    const journal = new FeedbackJournal({ dir: makeDir() })
    expect(journal.load('w-22222222')).toEqual({ notes: [], deliveryKeys: [], ackedUpTo: 0, nextId: 1 })
  })

  it('survives corrupt lines and unknown entry kinds', () => {
    const dir = makeDir()
    const journal = new FeedbackJournal({ dir })
    journal.appendNotes('w-11111111', [{ id: 1, note: note('keep') }])
    const path = join(dir, 'w-11111111.jsonl')
    writeFileSync(path, readFileSync(path, 'utf8') + 'not json\n{"k":"future"}\n')
    const state = journal.load('w-11111111')
    expect(state.notes.map((entry) => entry.note.comment)).toEqual(['keep'])
  })

  it('rejects pane ids that are not safe file names', () => {
    const journal = new FeedbackJournal({ dir: makeDir() })
    expect(() => journal.load('../escape')).toThrow()
    expect(() => journal.appendAck('a/b', 1)).toThrow()
  })

  it('keeps acknowledged delivery keys through compaction and restart without changing keyless notes or nextId', () => {
    const dir = makeDir()
    const journal = new FeedbackJournal({ dir })
    const paneId = 'w-11111111'
    journal.appendNotes(paneId, [
      { id: 1, note: { ...note('keyed ack'), deliveryKey: 'pending:w-11111111:1' } },
      { id: 2, note: note('keyless ack') },
      { id: 3, note: note('keyless live') },
      { id: 4, note: { ...note('keyed live'), deliveryKey: 'pending:w-11111111:4' } },
    ])
    for (let i = 0; i < JOURNAL_COMPACT_THRESHOLD; i++) journal.appendAck(paneId, 2)
    journal.compact(paneId)
    const lines = readFileSync(join(dir, `${paneId}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.length).toBeLessThan(10)
    expect(lines.filter((entry) => entry.k === 'd')).toEqual([
      expect.objectContaining({ k: 'd', key: 'pending:w-11111111:1' }),
    ])

    const state = new FeedbackJournal({ dir }).load(paneId)
    expect(state.notes.map((entry) => entry.note.comment)).toEqual(['keyless live', 'keyed live'])
    expect(state.deliveryKeys).toEqual(['pending:w-11111111:1', 'pending:w-11111111:4'])
    expect(state.ackedUpTo).toBe(2)
    expect(state.nextId).toBe(5)
  })

  it('removes journals older than the ttl and keeps fresh ones', () => {
    const dir = makeDir()
    const journal = new FeedbackJournal({ dir })
    journal.appendNotes('w-old00000', [{ id: 1, note: note('old') }])
    journal.appendNotes('w-fresh000', [{ id: 1, note: note('fresh') }])
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
    utimesSync(join(dir, 'w-old00000.jsonl'), stale, stale)
    journal.removeExpired(7 * 24 * 60 * 60 * 1_000)
    expect(readdirSync(dir)).toEqual(['w-fresh000.jsonl'])
  })

  it('lists attachment ids from every readable unacked feedback journal', () => {
    const dir = makeDir()
    const journal = new FeedbackJournal({ dir })
    const attached = (id: string): WebPaneFeedbackNote => ({
      ...note(id),
      attachments: [{
        id,
        name: 'screen.png',
        contentType: 'image/png',
        size: 8,
        path: `/api/web-panes/w-11111111/attachments/${id}`,
      }],
    })
    journal.appendNotes('w-open0000', [{ id: 1, note: attached('open.png') }])
    journal.appendNotes('w-closed00', [{ id: 1, note: attached('closed.png') }])
    journal.appendNotes('w-acked000', [{ id: 1, note: attached('acked.png') }])
    journal.appendAck('w-acked000', 1)
    writeFileSync(join(dir, 'w-ignore00.pending.jsonl'), JSON.stringify({
      k: 'n',
      id: 1,
      note: attached('pending.png'),
    }) + '\n')

    expect(journal.referencedAttachmentIds()).toEqual(new Set(['open.png', 'closed.png']))
  })
})

import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebPaneFeedbackNote } from '../shared/protocol.js'
import {
  DELIVERY_DEDUPE_TTL_MS,
  FeedbackJournal,
  JOURNAL_COMPACT_THRESHOLD,
} from './web-pane-feedback-journal.js'

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
    expect(state.deliveryKeyRecords).toEqual([
      { key: 'pending:w-11111111:1', at: 7, live: false },
      { key: 'pending:w-11111111:2', at: 7, live: true },
    ])
    expect(state.notes.map((entry) => entry.id)).toEqual([2])
    expect(state.notes[0]?.note.comment).toBe('b')
  })

  it('returns an empty state for a pane with no journal', () => {
    const journal = new FeedbackJournal({ dir: makeDir() })
    expect(journal.load('w-22222222')).toEqual({
      notes: [],
      deliveryKeys: [],
      deliveryKeyRecords: [],
      ackedUpTo: 0,
      nextId: 1,
    })
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

  it('preserves accepted times through compaction, expires tombstones, and retains old live keys', () => {
    const dir = makeDir()
    const paneId = 'w-11111111'
    const acceptedAt = 1_000
    const now = acceptedAt + DELIVERY_DEDUPE_TTL_MS - 1
    const path = join(dir, `${paneId}.jsonl`)
    writeFileSync(path, [
      JSON.stringify({ k: 'n', id: 1, at: acceptedAt, note: { ...note('acked'), deliveryKey: 'acked-key' } }),
      JSON.stringify({ k: 'n', id: 2, at: acceptedAt, note: { ...note('live'), deliveryKey: 'live-key' } }),
      ...Array.from({ length: JOURNAL_COMPACT_THRESHOLD + 1 }, () => JSON.stringify({ k: 'a', upTo: 1, at: now })),
      '',
    ].join('\n'))

    new FeedbackJournal({ dir, now: () => now }).compact(paneId)

    const compacted = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(compacted.find((entry) => entry.k === 'd')).toEqual({ k: 'd', key: 'acked-key', at: acceptedAt })
    expect(compacted.find((entry) => entry.k === 'n')).toMatchObject({ id: 2, at: acceptedAt })
    expect(new FeedbackJournal({ dir, now: () => acceptedAt + DELIVERY_DEDUPE_TTL_MS }).load(paneId))
      .toMatchObject({
        deliveryKeys: ['live-key'],
        deliveryKeyRecords: [{ key: 'live-key', at: acceptedAt, live: true }],
      })
  })

  it('scans valid unexpired delivery keys across readable feedback journals only', () => {
    const dir = makeDir()
    const now = DELIVERY_DEDUPE_TTL_MS + 10_000
    const freshAt = now - 1_000
    writeFileSync(join(dir, 'w-acked000.jsonl'), [
      JSON.stringify({ k: 'n', id: 1, at: freshAt, note: { ...note('fresh'), deliveryKey: 'fresh-key' } }),
      JSON.stringify({ k: 'a', upTo: 1, at: now }),
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'w-expired0.jsonl'), [
      JSON.stringify({ k: 'n', id: 1, at: 1, note: { ...note('expired'), deliveryKey: 'expired-key' } }),
      JSON.stringify({ k: 'a', upTo: 1, at: now }),
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'w-live00000.jsonl'), JSON.stringify({
      k: 'n', id: 1, at: 1, note: { ...note('old live'), deliveryKey: 'live-key' },
    }) + '\n')
    writeFileSync(join(dir, 'w-corrupt00.jsonl'), 'not json\n' + JSON.stringify({
      k: 'd', key: 'recovered-key', at: freshAt,
    }) + '\n')
    writeFileSync(join(dir, 'w-ignore00.pending.jsonl'), JSON.stringify({
      k: 'n', id: 1, at: freshAt, note: { ...note('pending'), deliveryKey: 'pending-key' },
    }) + '\n')
    writeFileSync(join(dir, 'unsafe.name.jsonl'), JSON.stringify({ k: 'd', key: 'unsafe-key', at: freshAt }) + '\n')

    expect(new FeedbackJournal({ dir }).scanDeliveryKeys(now)).toEqual(expect.arrayContaining([
      { webPaneId: 'w-acked000', key: 'fresh-key', at: freshAt, live: false },
      { webPaneId: 'w-live00000', key: 'live-key', at: 1, live: true },
      { webPaneId: 'w-corrupt00', key: 'recovered-key', at: freshAt, live: false },
    ]))
    expect(new FeedbackJournal({ dir }).scanDeliveryKeys(now).map((record) => record.key).sort())
      .toEqual(['fresh-key', 'live-key', 'recovered-key'])
  })

  it('does not rewrite a large tombstone baseline on each subsequent ack', () => {
    const dir = makeDir()
    const journal = new FeedbackJournal({ dir, now: () => 7 })
    const paneId = 'w-11111111'
    const baseline = JOURNAL_COMPACT_THRESHOLD + 10
    journal.appendNotes(paneId, Array.from({ length: baseline }, (_, index) => ({
      id: index + 1,
      note: { ...note(`note ${index}`), deliveryKey: `key-${index}` },
    })))
    for (let index = 0; index <= JOURNAL_COMPACT_THRESHOLD; index += 1) journal.appendAck(paneId, baseline)
    journal.compact(paneId)
    const path = join(dir, `${paneId}.jsonl`)
    const baselineLines = readFileSync(path, 'utf8').trim().split('\n').length
    expect(baselineLines).toBe(baseline + 1)

    for (let index = 1; index <= 3; index += 1) {
      journal.appendNotes(paneId, [{
        id: baseline + index,
        note: { ...note(`later ${index}`), deliveryKey: `later-${index}` },
      }])
      journal.appendAck(paneId, baseline + index)
      journal.compact(paneId)
    }

    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(baselineLines + 6)
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

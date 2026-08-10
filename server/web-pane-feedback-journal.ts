import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WebPaneFeedbackNote } from '../shared/protocol.js'

export type JournaledNote = { id: number; at: number; note: WebPaneFeedbackNote }

export type DeliveryKeyRecord = {
  key: string
  /** Original note acceptance time, used to bound historical dedupe. */
  at: number
  /** Live note keys do not expire until their note is acknowledged. */
  live: boolean
}

export type ScannedDeliveryKeyRecord = DeliveryKeyRecord & { webPaneId: string }

export type JournalState = {
  /** Unacked notes in id order. */
  notes: JournaledNote[]
  /** Every stable delivery key retained by this journal. */
  deliveryKeys: string[]
  deliveryKeyRecords: DeliveryKeyRecord[]
  ackedUpTo: number
  nextId: number
}

/** Rewrite a journal once it accumulates this many lines. */
export const JOURNAL_COMPACT_THRESHOLD = 200

export const FEEDBACK_JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const DELIVERY_DEDUPE_TTL_MS = FEEDBACK_JOURNAL_TTL_MS

export function defaultFeedbackJournalDir(): string {
  return resolve(homedir(), '.commando', 'feedback')
}

type JournalOptions = {
  dir?: string
  now?: () => number
}

/**
 * Append-only JSONL journal for review-feedback notes, one file per web pane
 * under ~/.commando/feedback. Lines are {k:'n',id,at,note} for notes and
 * {k:'a',upTo,at} for acks, and {k:'d',key,at} for compacted delivery-key
 * tombstones; load() replays them into the unacked backlog.
 * This is what lets answers survive lost long-poll responses, daemon
 * restarts, and closed tiles.
 */
export class FeedbackJournal {
  private readonly dir: string
  private readonly now: () => number
  private ready = false

  constructor(options: JournalOptions = {}) {
    this.dir = options.dir ?? defaultFeedbackJournalDir()
    this.now = options.now ?? Date.now
  }

  load(webPaneId: string, now = this.now()): JournalState {
    const path = this.pathFor(webPaneId)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return { notes: [], deliveryKeys: [], deliveryKeyRecords: [], ackedUpTo: 0, nextId: 1 }
    }
    return replay(raw, now)
  }

  appendNotes(webPaneId: string, entries: Array<Omit<JournaledNote, 'at'> & { at?: number }>): void {
    if (entries.length === 0) return
    const lines = entries
      .map((entry) => JSON.stringify({ k: 'n', id: entry.id, at: entry.at ?? this.now(), note: entry.note }))
      .join('\n')
    this.append(webPaneId, lines)
  }

  appendAck(webPaneId: string, upTo: number): void {
    this.append(webPaneId, JSON.stringify({ k: 'a', upTo, at: this.now() }))
  }

  /** Rewrites the journal once redundant append history has grown large. */
  compact(webPaneId: string): void {
    const path = this.pathFor(webPaneId)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return
    }
    const now = this.now()
    const state = replay(raw, now)
    const historicalKeys = state.deliveryKeyRecords.filter((record) => !record.live)
    const minimalLines = state.notes.length + historicalKeys.length + (state.ackedUpTo > 0 ? 1 : 0)
    const lineCount = raw.split('\n').filter((line) => line.trim() !== '').length
    if (lineCount - minimalLines < JOURNAL_COMPACT_THRESHOLD) return
    const lines = state.notes.map((entry) => JSON.stringify({
      k: 'n',
      id: entry.id,
      at: entry.at,
      note: entry.note,
    }))
    lines.unshift(...historicalKeys.map((record) => JSON.stringify({ k: 'd', key: record.key, at: record.at })))
    if (state.ackedUpTo > 0) lines.unshift(JSON.stringify({ k: 'a', upTo: state.ackedUpTo, at: now }))
    const tmp = `${path}.tmp`
    writeFileSync(tmp, lines.length > 0 ? lines.join('\n') + '\n' : '')
    renameSync(tmp, path)
  }

  /** Deletes journals not touched within ttlMs; a lost answer 7 days unread is gone for good. */
  removeExpired(ttlMs: number): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    const cutoff = this.now() - ttlMs
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(this.dir, name)
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
      } catch {
        // Raced with another writer or already gone — nothing to clean.
      }
    }
  }

  /** Attachment ids named by every readable unacked feedback journal. */
  referencedAttachmentIds(): Set<string> {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return new Set()
    }
    const ids = new Set<string>()
    for (const name of names) {
      if (!name.endsWith('.jsonl') || name.endsWith('.pending.jsonl')) continue
      const webPaneId = name.slice(0, -'.jsonl'.length)
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(webPaneId)) continue
      try {
        for (const entry of replay(readFileSync(join(this.dir, name), 'utf8'), this.now()).notes) {
          for (const attachment of entry.note.attachments ?? []) ids.add(attachment.id)
        }
      } catch {
        // A corrupt or concurrently removed journal has no reliable references.
      }
    }
    return ids
  }

  /** Retained stable delivery keys from every safe, readable feedback journal. */
  scanDeliveryKeys(now = this.now()): ScannedDeliveryKeyRecord[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const records: ScannedDeliveryKeyRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.jsonl') || name.endsWith('.pending.jsonl')) continue
      const webPaneId = name.slice(0, -'.jsonl'.length)
      if (!isSafePaneId(webPaneId)) continue
      try {
        records.push(...replay(readFileSync(join(this.dir, name), 'utf8'), now).deliveryKeyRecords
          .map((record) => ({ ...record, webPaneId })))
      } catch {
        // A corrupt or concurrently removed journal has no reliable records.
      }
    }
    return records
  }

  private append(webPaneId: string, lines: string): void {
    const path = this.pathFor(webPaneId)
    if (!this.ready) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      this.ready = true
    }
    appendFileSync(path, lines + '\n')
  }

  private pathFor(webPaneId: string): string {
    if (!isSafePaneId(webPaneId)) {
      throw new Error(`Unsafe web pane id for journal path: ${webPaneId}`)
    }
    return join(this.dir, `${webPaneId}.jsonl`)
  }
}

function replay(raw: string, now: number): JournalState {
  const notes = new Map<number, JournaledNote>()
  const candidates: Array<{ key: string; at: number; noteId?: number }> = []
  let ackedUpTo = 0
  let maxId = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.k === 'n' && typeof entry.id === 'number' && Number.isInteger(entry.id) && entry.id > 0) {
      const note = entry.note as WebPaneFeedbackNote | undefined
      if (typeof note === 'object' && note !== null) {
        const at = validTimestamp(entry.at) ? entry.at : now
        notes.set(entry.id, { id: entry.id, at, note })
        if (isDeliveryKey(note.deliveryKey)) candidates.push({ key: note.deliveryKey, at, noteId: entry.id })
        if (entry.id > maxId) maxId = entry.id
      }
      continue
    }
    if (entry.k === 'a' && typeof entry.upTo === 'number' && Number.isFinite(entry.upTo)) {
      if (entry.upTo > ackedUpTo) ackedUpTo = entry.upTo
      if (entry.upTo > maxId) maxId = Math.floor(entry.upTo)
      continue
    }
    if (entry.k === 'd' && isDeliveryKey(entry.key) && validTimestamp(entry.at)) {
      candidates.push({ key: entry.key, at: entry.at })
    }
  }
  const live = [...notes.values()].filter((entry) => entry.id > ackedUpTo).sort((a, b) => a.id - b.id)
  const cutoff = now - DELIVERY_DEDUPE_TTL_MS
  const deliveryKeyRecords = new Map<string, DeliveryKeyRecord>()
  for (const candidate of candidates) {
    const isLive = candidate.noteId !== undefined && candidate.noteId > ackedUpTo
    if (!isLive && candidate.at <= cutoff) continue
    const existing = deliveryKeyRecords.get(candidate.key)
    if (existing) {
      existing.at = Math.min(existing.at, candidate.at)
      existing.live ||= isLive
    } else {
      deliveryKeyRecords.set(candidate.key, { key: candidate.key, at: candidate.at, live: isLive })
    }
  }
  return {
    notes: live,
    deliveryKeys: [...deliveryKeyRecords.keys()],
    deliveryKeyRecords: [...deliveryKeyRecords.values()],
    ackedUpTo,
    nextId: maxId + 1,
  }
}

function isDeliveryKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafePaneId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

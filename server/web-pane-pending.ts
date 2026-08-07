import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_PENDING_NOTES, type WebPaneFeedbackNote, type WebPanePendingNote } from '../shared/protocol.js'
import type { RedlinePageResponse } from '../shared/redline-response.js'
import { defaultFeedbackJournalDir, JOURNAL_COMPACT_THRESHOLD } from './web-pane-feedback-journal.js'
import { WebPaneError } from './web-panes.js'

type PendingJournalState = {
  /** Live (not removed) notes in id order. */
  notes: WebPanePendingNote[]
  nextId: number
}

type JournalOptions = {
  dir?: string
  now?: () => number
}

/**
 * Append-only JSONL journal for queued-but-unsent review notes, one
 * `<paneId>.pending.jsonl` file per web pane in the feedback directory (so
 * the feedback journal's TTL sweep covers both). Lines are {k:'n',id,at,note}
 * for queued notes and {k:'r',id,at} for removals; load() replays them into
 * the live pending list.
 */
export class PendingNotesJournal {
  private readonly dir: string
  private readonly now: () => number
  private ready = false

  constructor(options: JournalOptions = {}) {
    this.dir = options.dir ?? defaultFeedbackJournalDir()
    this.now = options.now ?? Date.now
  }

  load(webPaneId: string): PendingJournalState {
    let raw: string
    try {
      raw = readFileSync(this.pathFor(webPaneId), 'utf8')
    } catch {
      return { notes: [], nextId: 1 }
    }
    return replay(raw)
  }

  appendNote(webPaneId: string, note: WebPanePendingNote): void {
    this.append(webPaneId, JSON.stringify({ k: 'n', id: note.id, at: this.now(), note }))
  }

  appendRemovals(webPaneId: string, ids: readonly number[]): void {
    if (ids.length === 0) return
    this.append(
      webPaneId,
      ids.map((id) => JSON.stringify({ k: 'r', id, at: this.now() })).join('\n'),
    )
  }

  /** Rewrites the journal as just its live notes when it has grown. */
  compact(webPaneId: string): void {
    const path = this.pathFor(webPaneId)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      return
    }
    if (raw.split('\n').length < JOURNAL_COMPACT_THRESHOLD) return
    const state = replay(raw)
    const lines = state.notes.map((note) => JSON.stringify({ k: 'n', id: note.id, at: this.now(), note }))
    // Removals are dropped by the rewrite, so pin the id counter explicitly —
    // otherwise a fully-drained journal would restart ids at 1 and a replayed
    // removal could hit a fresh note.
    lines.unshift(JSON.stringify({ k: 'c', nextId: state.nextId, at: this.now() }))
    const tmp = `${path}.tmp`
    writeFileSync(tmp, lines.join('\n') + '\n')
    renameSync(tmp, path)
  }

  /** Deletes a pane's pending journal (the pane is gone, pills are dead). */
  remove(webPaneId: string): void {
    rmSync(this.pathFor(webPaneId), { force: true })
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
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(webPaneId)) {
      throw new Error(`Unsafe web pane id for journal path: ${webPaneId}`)
    }
    return join(this.dir, `${webPaneId}.pending.jsonl`)
  }
}

function replay(raw: string): PendingJournalState {
  const notes = new Map<number, WebPanePendingNote>()
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
      const note = entry.note as WebPanePendingNote | undefined
      if (typeof note === 'object' && note !== null) {
        notes.set(entry.id, { ...note, id: entry.id })
        if (entry.id > maxId) maxId = entry.id
      }
      continue
    }
    if (entry.k === 'r' && typeof entry.id === 'number') {
      notes.delete(entry.id)
      continue
    }
    if (entry.k === 'c' && typeof entry.nextId === 'number' && Number.isInteger(entry.nextId)) {
      if (entry.nextId - 1 > maxId) maxId = entry.nextId - 1
    }
  }
  return {
    notes: [...notes.values()].sort((a, b) => a.id - b.id),
    nextId: maxId + 1,
  }
}

/** A manual (element-annotation) note as submitted by the tile UI. */
export type PendingNoteInput = Omit<WebPanePendingNote, 'id'>

type PaneState = {
  notes: WebPanePendingNote[]
  nextId: number
}

/**
 * Daemon-owned queue of review notes the owner has queued but not yet sent.
 * Page-component answers land here straight from the CDP binding — with or
 * without a connected tile viewer — and manual annotations are POSTed in;
 * both survive session switches, reloads, and (via the journal) daemon
 * restarts. Nothing here reaches the agent until the owner's explicit send
 * moves it into the WebPaneFeedbackStore.
 */
export class WebPanePendingStore {
  private readonly panes = new Map<string, PaneState>()

  constructor(private readonly journal: PendingNotesJournal = new PendingNotesJournal()) {}

  list(webPaneId: string): WebPanePendingNote[] {
    return [...this.state(webPaneId).notes]
  }

  /**
   * Queues an in-page component answer. A queueKey match replaces the unsent
   * previous answer (lavish's replace-not-stack rule); past the cap the
   * oldest note is dropped so a misbehaving page cannot grow the queue
   * without bound.
   */
  addResponse(webPaneId: string, response: RedlinePageResponse): WebPanePendingNote[] {
    const state = this.state(webPaneId)
    const replaced = response.queueKey === undefined
      ? []
      : state.notes.filter((note) => note.queueKey === response.queueKey)
    const note: WebPanePendingNote = {
      id: state.nextId++,
      selector: response.selector ?? `redline:${response.queueKey ?? response.question.slice(0, 64)}`,
      tag: response.tag ?? 'redline',
      ...(response.text !== undefined ? { text: response.text } : {}),
      rect: response.rect ?? { x: 0, y: 0, width: 0, height: 0 },
      comment: `${response.question}: ${response.answer}`,
      ...(response.queueKey !== undefined ? { queueKey: response.queueKey } : {}),
      response: {
        question: response.question,
        answer: response.answer,
        ...(response.data !== undefined ? { data: response.data } : {}),
      },
    }
    const kept = state.notes.filter((existing) => !replaced.includes(existing))
    const overflow = kept.length + 1 > MAX_PENDING_NOTES ? kept.splice(0, kept.length + 1 - MAX_PENDING_NOTES) : []
    state.notes = [...kept, note]
    this.journal.appendNote(webPaneId, note)
    this.journal.appendRemovals(webPaneId, [...replaced, ...overflow].map((dropped) => dropped.id))
    this.journal.compact(webPaneId)
    return this.list(webPaneId)
  }

  /** Queues a manual annotation (or a client-side restore of one). */
  addNote(webPaneId: string, input: PendingNoteInput): WebPanePendingNote[] {
    const state = this.state(webPaneId)
    if (state.notes.length >= MAX_PENDING_NOTES) {
      throw new WebPaneError(429, `At most ${MAX_PENDING_NOTES} notes can be queued per tile`)
    }
    const note: WebPanePendingNote = { ...input, id: state.nextId++ }
    state.notes.push(note)
    this.journal.appendNote(webPaneId, note)
    this.journal.compact(webPaneId)
    return this.list(webPaneId)
  }

  remove(webPaneId: string, noteId: number): WebPanePendingNote[] {
    const state = this.state(webPaneId)
    const kept = state.notes.filter((note) => note.id !== noteId)
    if (kept.length !== state.notes.length) {
      state.notes = kept
      this.journal.appendRemovals(webPaneId, [noteId])
      this.journal.compact(webPaneId)
    }
    return this.list(webPaneId)
  }

  /**
   * Hands the pending notes (all of them, or the requested ids) to `enqueue`
   * as feedback notes, and removes them only after it returns — a throwing
   * enqueue (e.g. the feedback queue is full) leaves the pending queue
   * untouched for a retry.
   */
  send(
    webPaneId: string,
    pageUrl: string,
    capturedAt: number,
    enqueue: (notes: WebPaneFeedbackNote[]) => void,
    ids?: readonly number[],
  ): WebPanePendingNote[] {
    const state = this.state(webPaneId)
    const wanted = ids === undefined ? state.notes : state.notes.filter((note) => ids.includes(note.id))
    if (wanted.length > 0) {
      enqueue(wanted.map(({ id: _id, queueKey: _queueKey, ...note }) => ({ ...note, pageUrl, capturedAt })))
      const sent = new Set(wanted.map((note) => note.id))
      state.notes = state.notes.filter((note) => !sent.has(note.id))
      this.journal.appendRemovals(webPaneId, [...sent])
      this.journal.compact(webPaneId)
    }
    return this.list(webPaneId)
  }

  /** Drops state and journals for panes that no longer exist. */
  retain(liveIds: ReadonlySet<string>): void {
    for (const id of [...this.panes.keys()]) {
      if (!liveIds.has(id)) this.drop(id)
    }
  }

  /** Forgets a closed pane's pending notes — nobody can send them anymore. */
  drop(webPaneId: string): void {
    this.panes.delete(webPaneId)
    this.journal.remove(webPaneId)
  }

  private state(webPaneId: string): PaneState {
    let state = this.panes.get(webPaneId)
    if (!state) {
      state = this.journal.load(webPaneId)
      this.panes.set(webPaneId, state)
    }
    return state
  }
}

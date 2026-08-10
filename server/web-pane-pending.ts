import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_PENDING_NOTE_ATTACHMENTS,
  MAX_PENDING_NOTES,
  type WebPaneFeedbackNote,
  type WebPaneImageAttachment,
  type WebPanePendingNote,
  type WebPanePendingSnapshot,
} from '../shared/protocol.js'
import {
  MAX_RESPONSE_ANSWER,
  MAX_RESPONSE_NOTE,
  type RedlinePageResponse,
} from '../shared/redline-response.js'
import { defaultFeedbackJournalDir, JOURNAL_COMPACT_THRESHOLD } from './web-pane-feedback-journal.js'
import { WebPaneError } from './web-panes.js'

const PENDING_SUFFIX = '.pending.jsonl'

type PendingJournalState = {
  /** Live (not removed) notes in id order. */
  notes: WebPanePendingNote[]
  nextId: number
  revision: number
  /** URL of the page these notes were queued against, when recorded. */
  url?: string
}

/** A closed pane's leftover queue, waiting for the same URL to be reopened. */
export type OrphanedPending = PendingJournalState & { webPaneId: string }

type JournalOptions = {
  dir?: string
  now?: () => number
}

type ReleaseAttachment = (attachmentId: string) => void

const MAX_FEEDBACK_COMMENT = 4_096

/**
 * Append-only JSONL journal for queued-but-unsent review notes, one
 * `<paneId>.pending.jsonl` file per web pane in the feedback directory (so
 * the feedback journal's TTL sweep covers both). Lines are {k:'n',id,at,note}
 * for queued notes, {k:'r',id,at} for removals, {k:'u',url,at} for the page
 * the notes belong to, {k:'v',revision,at} for revision-only changes, and
 * {k:'c',nextId,revision,at} as compaction pins. Mutation entries also carry
 * the pane revision so it survives replay.
 * A closed pane's journal is deliberately left behind so reopening the same
 * URL can adopt it.
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
      return { notes: [], nextId: 1, revision: 0 }
    }
    return replay(raw)
  }

  appendNote(webPaneId: string, note: WebPanePendingNote, revision = note.revision ?? 1): void {
    this.append(webPaneId, JSON.stringify({ k: 'n', id: note.id, revision, at: this.now(), note }))
  }

  appendRemovals(webPaneId: string, ids: readonly number[], revision?: number): void {
    if (ids.length === 0) return
    this.append(
      webPaneId,
      ids.map((id) => JSON.stringify({
        k: 'r',
        id,
        ...(revision !== undefined ? { revision } : {}),
        at: this.now(),
      })).join('\n'),
    )
  }

  appendUrl(webPaneId: string, url: string, revision = 0): void {
    this.append(webPaneId, JSON.stringify({ k: 'u', url, revision, at: this.now() }))
  }

  appendRevision(webPaneId: string, revision: number): void {
    this.append(webPaneId, JSON.stringify({ k: 'v', revision, at: this.now() }))
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
    lines.unshift(JSON.stringify({ k: 'c', nextId: state.nextId, revision: state.revision, at: this.now() }))
    if (state.url !== undefined) lines.unshift(JSON.stringify({ k: 'u', url: state.url, revision: state.revision, at: this.now() }))
    const tmp = `${path}.tmp`
    writeFileSync(tmp, lines.join('\n') + '\n')
    renameSync(tmp, path)
  }

  /**
   * Journals belonging to panes that no longer exist and still hold notes.
   * Empty leftovers are deleted on the way past — a closed pane whose notes
   * were all sent has nothing worth adopting.
   */
  listOrphans(liveIds: ReadonlySet<string>): OrphanedPending[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const orphans: OrphanedPending[] = []
    for (const name of names) {
      if (!name.endsWith(PENDING_SUFFIX)) continue
      const webPaneId = name.slice(0, -PENDING_SUFFIX.length)
      if (liveIds.has(webPaneId) || !isSafePaneId(webPaneId)) continue
      let state: PendingJournalState
      try {
        state = replay(readFileSync(join(this.dir, name), 'utf8'))
      } catch {
        continue
      }
      if (state.notes.length === 0) {
        this.remove(webPaneId)
        continue
      }
      orphans.push({ ...state, webPaneId })
    }
    return orphans
  }

  /** Attachment ids named by every readable pending journal, including orphans. */
  referencedAttachmentIds(): Set<string> {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return new Set()
    }
    const ids = new Set<string>()
    for (const name of names) {
      if (!name.endsWith(PENDING_SUFFIX)) continue
      const webPaneId = name.slice(0, -PENDING_SUFFIX.length)
      if (!isSafePaneId(webPaneId)) continue
      try {
        for (const note of replay(readFileSync(join(this.dir, name), 'utf8')).notes) {
          for (const attachment of note.attachments ?? []) ids.add(attachment.id)
        }
      } catch {
        // A corrupt or concurrently removed journal has no reliable references.
      }
    }
    return ids
  }

  /** Deletes a pane's pending journal. */
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
    if (!isSafePaneId(webPaneId)) {
      throw new Error(`Unsafe web pane id for journal path: ${webPaneId}`)
    }
    return join(this.dir, `${webPaneId}${PENDING_SUFFIX}`)
  }
}

function isSafePaneId(webPaneId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(webPaneId)
}

function replay(raw: string): PendingJournalState {
  const notes = new Map<number, WebPanePendingNote>()
  let maxId = 0
  let revision = 0
  let url: string | undefined
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const entryRevision = typeof entry.revision === 'number' && Number.isSafeInteger(entry.revision) && entry.revision >= 0
      ? entry.revision
      : 1
    if (entry.k === 'n' && typeof entry.id === 'number' && Number.isInteger(entry.id) && entry.id > 0) {
      const note = entry.note as WebPanePendingNote | undefined
      if (typeof note === 'object' && note !== null) {
        notes.set(entry.id, normalizePendingNote(note, entry.id))
        if (entry.id > maxId) maxId = entry.id
        revision = Math.max(revision, entryRevision)
      }
      continue
    }
    if (entry.k === 'r' && typeof entry.id === 'number') {
      notes.delete(entry.id)
      revision = Math.max(revision, entryRevision)
      continue
    }
    if (entry.k === 'u' && typeof entry.url === 'string') {
      url = entry.url
      revision = Math.max(revision, entryRevision)
      continue
    }
    if (entry.k === 'c' && typeof entry.nextId === 'number' && Number.isInteger(entry.nextId)) {
      if (entry.nextId - 1 > maxId) maxId = entry.nextId - 1
      revision = Math.max(revision, entryRevision)
      continue
    }
    if (entry.k === 'v') {
      revision = Math.max(revision, entryRevision)
    }
  }
  return {
    notes: [...notes.values()].sort((a, b) => a.id - b.id),
    nextId: maxId + 1,
    revision,
    ...(url !== undefined ? { url } : {}),
  }
}

function normalizePendingNote(note: WebPanePendingNote, id: number): WebPanePendingNote {
  const attachments = Array.isArray(note.attachments)
    ? note.attachments.filter(isImageAttachment).map((attachment) => ({ ...attachment }))
    : []
  return {
    ...note,
    id,
    revision: typeof note.revision === 'number' && Number.isSafeInteger(note.revision) && note.revision > 0
      ? note.revision
      : 1,
    attachments,
  }
}

function isImageAttachment(value: unknown): value is WebPaneImageAttachment {
  if (typeof value !== 'object' || value === null) return false
  const attachment = value as Partial<WebPaneImageAttachment>
  return typeof attachment.id === 'string' && attachment.id.length > 0 &&
    typeof attachment.name === 'string' && attachment.name.length > 0 &&
    typeof attachment.contentType === 'string' && attachment.contentType.length > 0 &&
    typeof attachment.size === 'number' && Number.isSafeInteger(attachment.size) && attachment.size > 0
}

/** A manual (element-annotation) note as submitted by the tile UI. */
export type PendingNoteInput = Omit<WebPanePendingNote, 'id' | 'revision' | 'attachments'>

type PaneState = {
  notes: WebPanePendingNote[]
  nextId: number
  revision: number
  url?: string
  /** Page answers the cap discarded since the last send. */
  dropped: number
}

/**
 * Daemon-owned queue of review notes the owner has queued but not yet sent.
 * Page-component answers land here straight from the CDP binding — with or
 * without a connected tile viewer — and manual annotations are POSTed in;
 * both survive session switches, reloads, closed tiles, and (via the
 * journal) daemon restarts. Nothing here reaches the agent until the owner's
 * explicit send moves it into the WebPaneFeedbackStore.
 */
export class WebPanePendingStore {
  private readonly panes = new Map<string, PaneState>()

  constructor(
    private readonly journal: PendingNotesJournal = new PendingNotesJournal(),
    private readonly releaseAttachment: ReleaseAttachment = () => undefined,
  ) {}

  list(webPaneId: string): WebPanePendingNote[] {
    return [...this.state(webPaneId).notes]
  }

  snapshot(webPaneId: string): WebPanePendingSnapshot {
    const state = this.state(webPaneId)
    return { revision: state.revision, notes: [...state.notes], knownUpTo: state.nextId - 1, dropped: state.dropped }
  }

  /**
   * Queues an in-page component answer. A queueKey match replaces the unsent
   * previous answer (lavish's replace-not-stack rule); past the cap the
   * oldest note is dropped so a misbehaving page cannot grow the queue
   * without bound. Drops are counted, not silent — the tile shows them.
   */
  addResponse(webPaneId: string, url: string, response: RedlinePageResponse): WebPanePendingSnapshot {
    const state = this.state(webPaneId)
    this.rememberUrl(webPaneId, state, url)
    const existing = response.queueKey === undefined
      ? undefined
      : state.notes.find((note) => note.queueKey === response.queueKey)
    const responseValue = {
      question: response.question,
      answer: response.answer,
      ...(response.note !== undefined ? { note: response.note } : {}),
      ...(response.data !== undefined ? { data: response.data } : {}),
    }
    if (existing) {
      const updated: WebPanePendingNote = {
        id: existing.id,
        revision: (existing.revision ?? 1) + 1,
        selector: response.selector ?? `redline:${response.queueKey}`,
        tag: response.tag ?? 'redline',
        ...(response.text !== undefined ? { text: response.text } : {}),
        rect: response.rect ?? { x: 0, y: 0, width: 0, height: 0 },
        comment: responseComment(responseValue),
        queueKey: response.queueKey,
        response: responseValue,
        attachments: [...(existing.attachments ?? [])],
      }
      state.revision += 1
      state.notes = state.notes.map((note) => note.id === existing.id ? updated : note)
      this.journal.appendNote(webPaneId, updated, state.revision)
      this.journal.compact(webPaneId)
      return this.snapshot(webPaneId)
    }
    const note: WebPanePendingNote = {
      id: state.nextId++,
      revision: 1,
      selector: response.selector ?? `redline:${response.queueKey ?? response.question.slice(0, 64)}`,
      tag: response.tag ?? 'redline',
      ...(response.text !== undefined ? { text: response.text } : {}),
      rect: response.rect ?? { x: 0, y: 0, width: 0, height: 0 },
      comment: responseComment(responseValue),
      ...(response.queueKey !== undefined ? { queueKey: response.queueKey } : {}),
      response: responseValue,
      attachments: [],
    }
    const kept = [...state.notes]
    const overflow = kept.length + 1 > MAX_PENDING_NOTES
      ? kept.splice(0, kept.length + 1 - MAX_PENDING_NOTES)
      : []
    state.dropped += overflow.length
    state.notes = [...kept, note]
    state.revision += 1
    this.journal.appendNote(webPaneId, note, state.revision)
    this.journal.appendRemovals(webPaneId, overflow.map((dropped) => dropped.id), state.revision)
    this.journal.compact(webPaneId)
    this.release(overflow)
    return this.snapshot(webPaneId)
  }

  /** Queues a manual annotation (or a client-side restore of one). */
  addNote(webPaneId: string, url: string, input: PendingNoteInput): WebPanePendingSnapshot {
    const state = this.state(webPaneId)
    this.rememberUrl(webPaneId, state, url)
    if (state.notes.length >= MAX_PENDING_NOTES) {
      throw new WebPaneError(429, `At most ${MAX_PENDING_NOTES} notes can be queued per tile`)
    }
    const note: WebPanePendingNote = { ...input, id: state.nextId++, revision: 1, attachments: [] }
    state.notes.push(note)
    state.revision += 1
    this.journal.appendNote(webPaneId, note, state.revision)
    this.journal.compact(webPaneId)
    return this.snapshot(webPaneId)
  }

  remove(webPaneId: string, noteId: number): WebPanePendingSnapshot {
    const state = this.state(webPaneId)
    const kept = state.notes.filter((note) => note.id !== noteId)
    if (kept.length !== state.notes.length) {
      const removed = state.notes.filter((note) => note.id === noteId)
      state.notes = kept
      state.revision += 1
      this.journal.appendRemovals(webPaneId, [noteId], state.revision)
      this.journal.compact(webPaneId)
      this.release(removed)
    }
    return this.snapshot(webPaneId)
  }

  /** Clears the cap-drop notice once the owner has seen it. */
  acknowledgeDropped(webPaneId: string): WebPanePendingSnapshot {
    const state = this.state(webPaneId)
    if (state.dropped > 0) {
      state.dropped = 0
      state.revision += 1
      this.journal.appendRevision(webPaneId, state.revision)
      this.journal.compact(webPaneId)
    }
    return this.snapshot(webPaneId)
  }

  update(
    webPaneId: string,
    noteId: number,
    expectedRevision: number,
    change: { answer?: string; note?: string },
  ): WebPanePendingSnapshot {
    const state = this.state(webPaneId)
    const index = state.notes.findIndex((note) => note.id === noteId)
    const current = state.notes[index]
    this.assertRevision(current, expectedRevision)
    const hasAnswer = Object.prototype.hasOwnProperty.call(change, 'answer')
    const hasNote = Object.prototype.hasOwnProperty.call(change, 'note')
    if (!hasAnswer && !hasNote) throw new WebPaneError(400, 'At least answer or note must be provided')

    const updated: WebPanePendingNote = {
      ...current,
      revision: (current.revision ?? 1) + 1,
      attachments: [...(current.attachments ?? [])],
    }
    if (current.response) {
      const response = { ...current.response }
      if (hasAnswer) {
        if (typeof change.answer !== 'string' || change.answer.length === 0 || change.answer.length > MAX_RESPONSE_ANSWER) {
          throw new WebPaneError(400, `Answer must contain 1 to ${MAX_RESPONSE_ANSWER} characters`)
        }
        response.answer = change.answer
        delete response.data
      }
      if (hasNote) {
        if (typeof change.note !== 'string') throw new WebPaneError(400, 'Note must be a string')
        const note = change.note.trim()
        if (note.length > MAX_RESPONSE_NOTE) {
          throw new WebPaneError(400, `Note must contain at most ${MAX_RESPONSE_NOTE} characters`)
        }
        if (note === '') delete response.note
        else response.note = note
      }
      updated.response = response
      updated.comment = responseComment(response)
    } else {
      if (hasNote) throw new WebPaneError(400, 'Manual annotations do not have a response note')
      if (typeof change.answer !== 'string' || change.answer.length === 0 || change.answer.length > MAX_FEEDBACK_COMMENT) {
        throw new WebPaneError(400, `Comment must contain 1 to ${MAX_FEEDBACK_COMMENT} characters`)
      }
      updated.comment = change.answer
    }
    if (updated.comment.length > MAX_FEEDBACK_COMMENT) {
      throw new WebPaneError(400, `Comment must contain at most ${MAX_FEEDBACK_COMMENT} characters`)
    }

    state.revision += 1
    state.notes[index] = updated
    this.journal.appendNote(webPaneId, updated, state.revision)
    this.journal.compact(webPaneId)
    return this.snapshot(webPaneId)
  }

  attach(
    webPaneId: string,
    noteId: number,
    expectedRevision: number,
    metadata: WebPaneImageAttachment,
  ): WebPanePendingSnapshot {
    const state = this.state(webPaneId)
    const index = state.notes.findIndex((note) => note.id === noteId)
    const current = state.notes[index]
    this.assertRevision(current, expectedRevision)
    if (!isImageAttachment(metadata)) throw new WebPaneError(400, 'Attachment metadata is malformed')
    const attachments = current.attachments ?? []
    if (attachments.some((attachment) => attachment.id === metadata.id) || this.referencedAttachmentIds().has(metadata.id)) {
      throw new WebPaneError(409, 'Attachment is already referenced')
    }
    if (attachments.length >= MAX_PENDING_NOTE_ATTACHMENTS) {
      throw new WebPaneError(429, `At most ${MAX_PENDING_NOTE_ATTACHMENTS} attachments can be added per note`)
    }
    const updated: WebPanePendingNote = {
      ...current,
      revision: (current.revision ?? 1) + 1,
      attachments: [...attachments, { ...metadata }],
    }
    state.revision += 1
    state.notes[index] = updated
    this.journal.appendNote(webPaneId, updated, state.revision)
    this.journal.compact(webPaneId)
    return this.snapshot(webPaneId)
  }

  detach(
    webPaneId: string,
    noteId: number,
    expectedRevision: number,
    attachmentId: string,
  ): WebPanePendingSnapshot {
    const state = this.state(webPaneId)
    const index = state.notes.findIndex((note) => note.id === noteId)
    const current = state.notes[index]
    this.assertRevision(current, expectedRevision)
    const attachments = current.attachments ?? []
    const detached = attachments.find((attachment) => attachment.id === attachmentId)
    if (!detached) throw new WebPaneError(404, 'Attachment is not attached to this note')
    const updated: WebPanePendingNote = {
      ...current,
      revision: (current.revision ?? 1) + 1,
      attachments: attachments.filter((attachment) => attachment.id !== attachmentId),
    }
    state.revision += 1
    state.notes[index] = updated
    this.journal.appendNote(webPaneId, updated, state.revision)
    this.journal.compact(webPaneId)
    this.releaseAttachment(detached.id)
    return this.snapshot(webPaneId)
  }

  referencesAttachment(webPaneId: string, attachmentId: string): boolean {
    return this.state(webPaneId).notes.some((note) =>
      (note.attachments ?? []).some((attachment) => attachment.id === attachmentId),
    )
  }

  referencedAttachmentIds(): Set<string> {
    const ids = this.journal.referencedAttachmentIds()
    for (const state of this.panes.values()) {
      for (const note of state.notes) {
        for (const attachment of note.attachments ?? []) ids.add(attachment.id)
      }
    }
    return ids
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
  ): WebPanePendingSnapshot {
    const state = this.state(webPaneId)
    const wanted = ids === undefined ? state.notes : state.notes.filter((note) => ids.includes(note.id))
    if (wanted.length > 0) {
      enqueue(wanted.map(({ id: _id, revision: _revision, queueKey: _queueKey, attachments, ...note }) => ({
        ...note,
        pageUrl,
        capturedAt,
        ...(attachments && attachments.length > 0 ? {
          attachments: attachments.map((attachment) => ({
            ...attachment,
            path: `/api/web-panes/${webPaneId}/attachments/${attachment.id}`,
          })),
        } : {}),
      })))
      const sent = new Set(wanted.map((note) => note.id))
      state.notes = state.notes.filter((note) => !sent.has(note.id))
      state.dropped = 0
      state.revision += 1
      this.journal.appendRemovals(webPaneId, [...sent], state.revision)
      this.journal.compact(webPaneId)
    }
    return this.snapshot(webPaneId)
  }

  /**
   * Absorbs the leftover queues of closed panes that were reviewing the same
   * URL, so reopening a tile you closed mid-review brings your unsent pills
   * back. Adopted notes are re-issued ids in this pane's sequence; the
   * absorbed journals are deleted so a third tile cannot adopt them twice.
   */
  adopt(webPaneId: string, url: string, liveIds: ReadonlySet<string>): WebPanePendingSnapshot {
    const state = this.state(webPaneId)
    this.rememberUrl(webPaneId, state, url)
    const orphans = this.journal
      .listOrphans(new Set([...liveIds, webPaneId]))
      .filter((orphan) => orphan.url === url)
    if (orphans.length === 0) return this.snapshot(webPaneId)

    const inherited = orphans.flatMap((orphan) => orphan.notes)
    state.revision += 1
    for (const note of inherited) {
      // Past the cap the oldest goes, matching the live queue's own rule.
      if (state.notes.length >= MAX_PENDING_NOTES) {
        const [evicted] = state.notes.splice(0, 1)
        state.dropped += 1
        if (evicted) {
          this.journal.appendRemovals(webPaneId, [evicted.id], state.revision)
          this.release([evicted])
        }
      }
      const adopted: WebPanePendingNote = normalizePendingNote({ ...note, id: state.nextId++ }, state.nextId - 1)
      state.notes.push(adopted)
      this.journal.appendNote(webPaneId, adopted, state.revision)
    }
    for (const orphan of orphans) this.journal.remove(orphan.webPaneId)
    this.journal.compact(webPaneId)
    return this.snapshot(webPaneId)
  }

  /**
   * Drops in-memory state for panes that no longer exist. Journals stay on
   * disk — a closed tile's unsent pills wait there for the same URL to be
   * reopened, and expire with the feedback journal's TTL sweep.
   */
  retain(liveIds: ReadonlySet<string>): void {
    for (const id of [...this.panes.keys()]) {
      if (!liveIds.has(id)) this.panes.delete(id)
    }
  }

  /** Purges a pane's pending notes outright (nothing keeps them). */
  drop(webPaneId: string): void {
    const state = this.panes.get(webPaneId) ?? { ...this.journal.load(webPaneId), dropped: 0 }
    this.release(state.notes)
    this.panes.delete(webPaneId)
    this.journal.remove(webPaneId)
  }

  private rememberUrl(webPaneId: string, state: PaneState, url: string): void {
    if (state.url === url) return
    state.url = url
    this.journal.appendUrl(webPaneId, url, state.revision)
  }

  private state(webPaneId: string): PaneState {
    let state = this.panes.get(webPaneId)
    if (!state) {
      state = { ...this.journal.load(webPaneId), dropped: 0 }
      this.panes.set(webPaneId, state)
    }
    return state
  }

  private assertRevision(note: WebPanePendingNote | undefined, expectedRevision: number): asserts note is WebPanePendingNote {
    if (!note || !Number.isSafeInteger(expectedRevision) || expectedRevision <= 0 || (note.revision ?? 1) !== expectedRevision) {
      throw new WebPaneError(409, 'Pending note revision is stale')
    }
  }

  private release(notes: readonly WebPanePendingNote[]): void {
    const ids = notes.flatMap((note) => (note.attachments ?? []).map((attachment) => attachment.id))
    for (const id of ids) this.releaseAttachment(id)
  }
}

function responseComment(response: { question: string; answer: string; note?: string }): string {
  const answer = `${response.question}: ${response.answer}`
  return response.note ? `${answer}\n\nNote: ${response.note}` : answer
}

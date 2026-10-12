import { WebPaneError } from './web-panes.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseCanvasNoteContext } from '../shared/canvas-feedback.js'
import type { CanvasThread, WebPaneFeedbackNote } from '../shared/protocol.js'

const threadIdForKey = (webPaneId: string, key: string) => `ct-${createHash('sha256').update(`${webPaneId}:${key}`).digest('hex').slice(0, 24)}`

export function defaultCanvasThreadsPath(port = 4310): string {
  return join(homedir(), '.commando', `canvas-threads-${port}.json`)
}

/** Sent pins outlive feedback acknowledgement. Delivery identities make retries idempotent. */
export class CanvasThreadsStore {
  private threads = new Map<string, CanvasThread>()
  constructor(private readonly path = defaultCanvasThreadsPath(), private readonly changed: (webPaneId: string) => void = () => {}) {
    try {
      const entries: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(entries)) for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue
        const thread = entry as CanvasThread
        if (typeof thread.id !== 'string' || typeof thread.webPaneId !== 'string' ||
          !parseCanvasNoteContext({ frameId: thread.frameId, point: thread.point, label: thread.label, labelId: thread.labelId }) ||
          (thread.canvas !== undefined && !parseCanvasNoteContext(thread.canvas)) ||
          !['open', 'resolved'].includes(thread.status) || !Number.isFinite(thread.createdAt) || !Array.isArray(thread.messages) ||
          thread.messages.length === 0 || thread.messages.length > 200 ||
          !thread.messages.every((m) => m && ['user', 'agent'].includes(m.author) && typeof m.text === 'string' && m.text.length > 0 && m.text.length <= 4_096 && Number.isFinite(m.at))) continue
        this.threads.set(thread.id, thread)
      }
    } catch { /* A missing or corrupt store starts empty. */ }
  }

  list(webPaneId: string): CanvasThread[] {
    return structuredClone([...this.threads.values()].filter((thread) => thread.webPaneId === webPaneId))
  }

  get(webPaneId: string, id: string): CanvasThread {
    const thread = this.threads.get(id)
    if (!thread || thread.webPaneId !== webPaneId) throw new WebPaneError(404, 'Thread does not exist')
    return structuredClone(thread)
  }

  /** Assign identities before enqueueing, so the journal and thread agree on retries. */
  prepare(webPaneId: string, notes: readonly WebPaneFeedbackNote[]): WebPaneFeedbackNote[] {
    const additions = new Map<string, Set<string>>()
    return notes.map((note) => {
      if (!note.canvas) return note
      const key = note.reviewKey ?? note.deliveryKey ?? randomUUID()
      const deliveryKey = note.deliveryKey ?? key
      const id = note.canvas.threadId ?? threadIdForKey(webPaneId, key)
      if (note.canvas.threadId) {
        const thread = this.get(webPaneId, id)
        if (id !== threadIdForKey(webPaneId, key) && !thread.messages.some((m) => m.deliveryKey === deliveryKey)) {
          const keys = additions.get(id) ?? new Set<string>()
          keys.add(deliveryKey); additions.set(id, keys)
          if (thread.messages.length + keys.size > 200) throw new WebPaneError(409, 'Thread has reached the 200 message limit')
        }
      }
      return { ...note, deliveryKey, canvas: { ...note.canvas, threadId: id } }
    })
  }

  record(webPaneId: string, notes: readonly WebPaneFeedbackNote[]): void {
    const next = new Map(this.threads)
    let changed = false
    for (const note of notes) {
      if (!note.canvas) continue
      if (note.comment.length === 0 || note.comment.length > 4_096) throw new WebPaneError(400, 'text must contain 1 to 4096 characters')
      const { frameId, point, label, labelId } = note.canvas
      const key = note.reviewKey ?? note.deliveryKey ?? randomUUID()
      const id = note.canvas.threadId ?? threadIdForKey(webPaneId, key)
      const existing = next.get(id)
      if (existing) {
        // A pin retry has the same identity as its original user message.
        if (!note.canvas.threadId || id === threadIdForKey(webPaneId, key) || existing.messages.some((m) => m.deliveryKey === note.deliveryKey)) continue
        this.assertRoom(existing)
        next.set(id, { ...existing, status: 'open', messages: [...existing.messages,
          { author: 'user', text: note.comment, at: note.capturedAt, deliveryKey: note.deliveryKey }] })
      } else {
        const { selector, tag, text, rect, pageUrl } = note
        next.set(id, { id, webPaneId, frameId, point: { ...point }, label, labelId, selector,
          canvas: { ...note.canvas, threadId: id }, source: { selector, tag, text, rect, pageUrl },
          messages: [{ author: 'user', text: note.comment, at: note.capturedAt, deliveryKey: note.deliveryKey }], status: 'open', createdAt: note.capturedAt })
      }
      changed = true
    }
    if (!changed) return
    this.persist(next)
    this.threads = next
    this.changed(webPaneId)
  }

  reply(webPaneId: string, id: string, text: string, resolve = false): CanvasThread {
    const thread = this.get(webPaneId, id)
    if (!text.trim() || text.length > 4_096) throw new WebPaneError(400, 'text must contain 1 to 4096 characters')
    this.assertRoom(thread)
    return this.save({ ...thread, status: resolve ? 'resolved' : thread.status,
      messages: [...thread.messages, { author: 'agent', text, at: Date.now() }] })
  }

  status(webPaneId: string, id: string, status: 'open' | 'resolved'): CanvasThread {
    return this.save({ ...this.get(webPaneId, id), status })
  }

  private assertRoom(thread: CanvasThread): void {
    if (thread.messages.length >= 200) throw new WebPaneError(409, 'Thread has reached the 200 message limit')
  }

  private save(thread: CanvasThread): CanvasThread {
    const next = new Map(this.threads).set(thread.id, thread)
    this.persist(next); this.threads = next; this.changed(thread.webPaneId)
    return structuredClone(thread)
  }

  retain(liveIds: ReadonlySet<string>): void {
    const next = new Map([...this.threads].filter(([, thread]) => liveIds.has(thread.webPaneId)))
    if (next.size === this.threads.size) return
    this.persist(next)
    const removedPanes = new Set([...this.threads.values()].filter((t) => !liveIds.has(t.webPaneId)).map((t) => t.webPaneId))
    this.threads = next
    for (const id of removedPanes) this.changed(id)
  }

  private persist(threads: Map<string, CanvasThread>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify([...threads.values()]), { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}

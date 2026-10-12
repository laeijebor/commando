import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseCanvasNoteContext } from '../shared/canvas-feedback.js'
import type { CanvasThread, WebPaneFeedbackNote } from '../shared/protocol.js'

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
          thread.status !== 'open' || !Number.isFinite(thread.createdAt) || !Array.isArray(thread.messages) ||
          !thread.messages.every((m) => m && m.author === 'user' && typeof m.text === 'string' && m.text.length <= 4_096 && Number.isFinite(m.at))) continue
        this.threads.set(thread.id, thread)
      }
    } catch { /* A missing or corrupt store starts empty. */ }
  }

  list(webPaneId: string): CanvasThread[] {
    return structuredClone([...this.threads.values()].filter((thread) => thread.webPaneId === webPaneId))
  }

  record(webPaneId: string, notes: readonly WebPaneFeedbackNote[]): void {
    const next = new Map(this.threads)
    for (const note of notes) {
      if (!note.canvas) continue
      const { frameId, point, label, labelId } = note.canvas
      const key = note.reviewKey ?? note.deliveryKey ?? randomUUID()
      const id = `ct-${createHash('sha256').update(`${webPaneId}:${key}`).digest('hex').slice(0, 24)}`
      if (next.has(id)) continue
      next.set(id, { id, webPaneId, frameId, point: { ...point }, label, labelId, selector: note.selector,
        messages: [{ author: 'user', text: note.comment, at: note.capturedAt }], status: 'open', createdAt: note.capturedAt })
    }
    if (next.size === this.threads.size) return
    this.persist(next)
    this.threads = next
    this.changed(webPaneId)
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

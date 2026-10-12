import { randomUUID } from 'node:crypto'
import type { AgentStatus, WebPane, WebPaneFeedbackNote } from '../shared/protocol.js'

const singleLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ')
const clip = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

export function canvasPushPrompt(title: string, id: string, notes: readonly WebPaneFeedbackNote[]): string {
  const header = `Canvas feedback on "${clip(singleLine(title), 180)}" (${notes.length} comment(s)) — webPaneId ${id}.`
  const footer = `Run scripts/commando-feedback ${id} to collect them (this also acknowledges them), apply the changes, and reply in each thread with scripts/commando-canvas reply ${id} <threadId> "<text>" [--resolve].`
  const lines: string[] = []
  let length = header.length + footer.length + 2
  for (const note of notes) {
    const canvas = note.canvas
    const line = `- [${clip(singleLine(canvas?.frameTitle ?? canvas?.frameId ?? 'Frame'), 100)} › ${clip(singleLine(canvas?.label ?? 'unlabelled'), 100)}] ${clip(singleLine(note.comment), 350)}  (thread ${canvas?.threadId ?? 'unknown'})`
    if (length + line.length + 1 > 1_900) break
    lines.push(line); length += line.length + 1
  }
  const omitted = notes.length - lines.length
  return [header, ...lines, ...(omitted ? [`… ${omitted} comment(s) omitted; collect the journal for all comments.`] : []), footer].join('\n')
}

type Dependencies = {
  pane: (id: string) => WebPane | undefined
  title: (pane: WebPane) => string
  owns: (paneId: string) => boolean
  sendChat: (paneId: string, text: string, requestId: string) => boolean
  status: (paneId: string) => AgentStatus | undefined
  sendTerminal: (paneId: string, text: string) => Promise<void>
}

/** Push is an in-memory convenience; the acknowledged journal is authoritative. */
export class CanvasPush {
  private readonly pushed = new Map<string, Set<string>>()
  private readonly owed = new Map<string, Map<string, WebPaneFeedbackNote>>()
  private readonly sending = new Set<string>()
  constructor(private readonly deps: Dependencies) {}

  async deliver(webPaneId: string, notes: readonly WebPaneFeedbackNote[]): Promise<void> {
    const pane = this.deps.pane(webPaneId)
    if (pane?.content?.kind !== 'canvas') return
    const pushed = this.pushed.get(webPaneId) ?? new Set<string>()
    this.pushed.set(webPaneId, pushed)
    const owed = this.owed.get(webPaneId) ?? new Map<string, WebPaneFeedbackNote>()
    this.owed.set(webPaneId, owed)
    for (const note of notes) if (note.canvas && note.deliveryKey && !pushed.has(note.deliveryKey)) owed.set(note.deliveryKey, note)
    await this.flush(webPaneId)
  }

  async statusChanged(paneId: string): Promise<void> {
    for (const id of this.owed.keys()) if (this.deps.pane(id)?.anchorPaneId === paneId) await this.flush(id)
  }

  retain(liveIds: ReadonlySet<string>): void {
    for (const id of this.pushed.keys()) if (!liveIds.has(id)) { this.pushed.delete(id); this.owed.delete(id) }
  }

  private async flush(id: string): Promise<void> {
    if (this.sending.has(id)) return
    const pane = this.deps.pane(id), owed = this.owed.get(id)
    if (!pane || !owed?.size) return
    const paneId = pane.anchorPaneId
    const chat = this.deps.owns(paneId)
    const status = this.deps.status(paneId)
    if (!chat && (!status || status.provider === 'unknown' || status.status !== 'done')) return
    const notes = [...owed.values()], keys = [...owed.keys()]
    const text = canvasPushPrompt(this.deps.title(pane), id, notes)
    this.sending.add(id)
    try {
      if (chat) {
        if (!this.deps.sendChat(paneId, text, `canvas-${randomUUID()}`)) return
      } else await this.deps.sendTerminal(paneId, text)
      for (const key of keys) { this.pushed.get(id)?.add(key); owed.delete(key) }
    } catch { /* Keep owed notes for the next status change; never fail journal delivery. */ }
    finally { this.sending.delete(id) }
  }
}

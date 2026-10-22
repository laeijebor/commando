import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { tileEventMarker } from '../shared/chat-tile-events.js'
import type { AgentStatus, WebPane, WebPaneFeedbackNote } from '../shared/protocol.js'

export const canvasRepoRoot = fileURLToPath(new URL('../', import.meta.url))

export const singleLine = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
export const clip = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

export function canvasPushPrompt(title: string, id: string, notes: readonly WebPaneFeedbackNote[], repoRoot = canvasRepoRoot): string {
  id = singleLine(id)
  const feedbackScript = JSON.stringify(singleLine(resolve(repoRoot, 'scripts/commando-feedback')))
  const canvasScript = JSON.stringify(singleLine(resolve(repoRoot, 'scripts/commando-canvas')))
  const header = `Canvas feedback on "${clip(singleLine(title), 180)}" (${notes.length} comment(s)) — webPaneId ${id}.`
  const footer = `Run ${feedbackScript} ${id} to collect them (this also acknowledges them), apply the changes, and reply in each thread with ${canvasScript} reply ${id} <threadId> "<text>" [--resolve].`
  const lines: string[] = []
  let length = header.length + footer.length + 2
  for (const note of notes) {
    const canvas = note.canvas
    const line = `- [${clip(singleLine(canvas?.frameTitle ?? canvas?.frameId ?? 'Frame'), 100)} › ${clip(singleLine(canvas?.label ?? 'unlabelled'), 100)}] ${clip(singleLine(note.comment), 350)}  (thread ${singleLine(canvas?.threadId ?? 'unknown')})`
    if (length + line.length + 1 > 1_900) break
    lines.push(line); length += line.length + 1
  }
  const omitted = notes.length - lines.length
  return [header, ...lines, ...(omitted ? [`… ${omitted} comment(s) omitted; collect the journal for all comments.`] : []), footer].join('\n')
}

/** Typed into an idle chat when redline answers arrive and the agent isn't polling. */
export function redlinePushPrompt(title: string, id: string, count: number, repoRoot = canvasRepoRoot): string {
  id = singleLine(id)
  const feedbackScript = JSON.stringify(singleLine(resolve(repoRoot, 'scripts/commando-feedback')))
  return [
    `Redline feedback on "${clip(singleLine(title), 180)}" (${count} note(s)) — webPaneId ${id}.`,
    `Run ${feedbackScript} ${id} to collect them (this also acknowledges them), then apply them.`,
  ].join('\n')
}

type Dependencies = {
  repoRoot?: string
  pane: (id: string) => WebPane | undefined
  title: (pane: WebPane) => string
  owns: (paneId: string) => boolean
  /** `queue`: wait for a running turn to end instead of joining it. */
  sendChat: (paneId: string, text: string, requestId: string, queue: boolean) => boolean
  status: (paneId: string) => AgentStatus | undefined
  sendTerminal: (paneId: string, text: string) => Promise<void>
  /** A redline tile whose agent is already waiting on a poll needs no push. */
  polling?: (webPaneId: string) => boolean
  /** Chat card ids for these notes; the prompt names them so the chat shows the cards. */
  eventIds?: (webPaneId: string, deliveryKeys: readonly string[]) => string[]
  delivered?: (eventIds: readonly string[]) => void
  /** Anchors mid-paste, shared with other pushers so two prompts never interleave. */
  sending?: Set<string>
}

/**
 * Types sent tile feedback into the owning agent's pane: canvas comments into
 * an idle chat or terminal agent, redline notes into a chat whose agent isn't
 * polling. Push is an in-memory convenience; the acknowledged journal is authoritative.
 */
export class CanvasPush {
  private readonly pushed = new Map<string, Set<string>>()
  private readonly owed = new Map<string, Map<string, WebPaneFeedbackNote>>()
  private readonly sending: Set<string>
  constructor(private readonly deps: Dependencies) { this.sending = deps.sending ?? new Set() }

  async deliver(webPaneId: string, notes: readonly WebPaneFeedbackNote[]): Promise<void> {
    const pane = this.deps.pane(webPaneId)
    if (!pane) return
    const canvas = pane.content?.kind === 'canvas'
    if (!canvas && (pane.content || !this.deps.owns(pane.anchorPaneId) || this.deps.polling?.(webPaneId))) return
    const pushed = this.pushed.get(webPaneId) ?? new Set<string>()
    this.pushed.set(webPaneId, pushed)
    const owed = this.owed.get(webPaneId) ?? new Map<string, WebPaneFeedbackNote>()
    this.owed.set(webPaneId, owed)
    for (const note of notes) if ((note.canvas || !canvas) && note.deliveryKey && !pushed.has(note.deliveryKey)) owed.set(note.deliveryKey, note)
    await this.flush(webPaneId)
  }

  async statusChanged(paneId: string): Promise<void> {
    for (const id of this.owed.keys()) if (this.deps.pane(id)?.anchorPaneId === paneId) await this.flush(id)
  }

  acknowledge(id: string, keys: readonly string[]): void {
    for (const key of keys) this.owed.get(id)?.delete(key)
  }

  retain(liveIds: ReadonlySet<string>): void {
    for (const id of this.pushed.keys()) if (!liveIds.has(id)) { this.pushed.delete(id); this.owed.delete(id) }
  }

  private async flush(id: string): Promise<void> {
    const pane = this.deps.pane(id), owed = this.owed.get(id)
    if (!pane || !owed?.size) return
    const paneId = pane.anchorPaneId
    if (this.sending.has(paneId)) return
    const canvas = pane.content?.kind === 'canvas'
    const chat = this.deps.owns(paneId)
    if (!canvas && !chat) return
    const status = this.deps.status(paneId)
    if (!chat && (!status || status.provider === 'unknown' || status.status !== 'done')) return
    const notes = [...owed.values()], keys = [...owed.keys()]
    const eventIds = this.deps.eventIds?.(id, keys) ?? []
    const prompt = canvas
      ? canvasPushPrompt(this.deps.title(pane), id, notes, this.deps.repoRoot)
      : redlinePushPrompt(this.deps.title(pane), id, notes.length, this.deps.repoRoot)
    const text = eventIds.length ? `${prompt}\n${tileEventMarker(eventIds)}` : prompt
    this.sending.add(paneId)
    let delivered = false
    try {
      // Availability can change while another canvas owns the anchor.
      const available = this.deps.status(paneId)
      if (this.deps.pane(id)?.anchorPaneId !== paneId || chat !== this.deps.owns(paneId) || (!chat && (!available || available.status !== 'done' || available.provider === 'unknown'))) return
      if (chat) {
        if (!this.deps.sendChat(paneId, text, `${canvas ? 'canvas' : 'redline'}-${randomUUID()}`, !canvas)) return
      } else await this.deps.sendTerminal(paneId, text)
      delivered = true
      if (eventIds.length) this.deps.delivered?.(eventIds)
      for (const key of keys) { this.pushed.get(id)?.add(key); owed.delete(key) }
      const pushed = this.pushed.get(id)
      while (pushed && pushed.size > 2_000) pushed.delete(pushed.values().next().value!)
    } catch { /* Keep owed notes for the next status change; never fail journal delivery. */ }
    finally {
      this.sending.delete(paneId)
      // Drain other canvases sharing this anchor only after paste AND submit finish.
      for (const other of this.owed.keys()) if (delivered && other !== id && this.deps.pane(other)?.anchorPaneId === paneId) await this.flush(other)
    }
  }
}

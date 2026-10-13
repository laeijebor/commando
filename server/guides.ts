import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AgentStatus, WebPane } from '../shared/protocol.js'
import { GUIDE_STEP_ID, guideSnapshot, MAX_GUIDE_NOTE, parseGuide, type GuideMark, type GuideSnapshot } from '../shared/guide.js'
import { canvasRepoRoot, clip, singleLine } from './canvas-push.js'
import { WebPaneError } from './web-panes.js'

export const MAX_GUIDE_RECORDS = 200
export const MAX_GUIDE_MARKS = 500
const MAX_GUIDE_BYTES = 1024 * 1024

type Delivered = Record<string, { checked: boolean; note?: string }>
type GuideRecord = { key: string; marks: Record<string, GuideMark>; delivered: Delivered; deliveredAt?: number; updatedAt: number }
type GuidePane = WebPane & { content: { kind: 'guide'; artifactId: string; file: string } }

export function defaultGuideStatePath(port = 4310): string {
  return join(homedir(), '.commando', `guide-state-${port}.json`)
}

const guideKey = (pane: GuidePane) => `${pane.content.artifactId}/${pane.content.file}`

/** Ticks and notes per guide file, so they survive tab close and agent edits. */
export class GuideStateStore {
  private records = new Map<string, GuideRecord>()
  constructor(private readonly path = defaultGuideStatePath()) {
    try {
      if (statSync(path).size > 16 * 1024 * 1024) return
      const entries: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(entries)) for (const entry of entries as GuideRecord[]) {
        if (!entry || typeof entry.key !== 'string' || typeof entry.marks !== 'object' || !entry.marks || typeof entry.delivered !== 'object' || !entry.delivered || !Number.isFinite(entry.updatedAt)) continue
        this.records.set(entry.key, entry)
      }
    } catch { /* A missing or corrupt store starts empty. */ }
  }

  get(key: string): GuideRecord {
    return structuredClone(this.records.get(key) ?? { key, marks: {}, delivered: {}, updatedAt: 0 })
  }

  update(key: string, change: (record: GuideRecord) => void): void {
    const record = this.get(key)
    change(record)
    record.updatedAt = Date.now()
    const next = new Map(this.records)
    next.delete(key)
    next.set(key, record)
    // Oldest-touched guides go first; a guide keeps only its most recent marks.
    while (next.size > MAX_GUIDE_RECORDS) next.delete(next.keys().next().value!)
    const ids = Object.keys(record.marks)
    if (ids.length > MAX_GUIDE_MARKS) for (const id of ids.sort((a, b) => record.marks[a].at - record.marks[b].at).slice(0, ids.length - MAX_GUIDE_MARKS)) delete record.marks[id]
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify([...next.values()]), { mode: 0o600 })
    renameSync(temporary, this.path)
    this.records = next
  }
}

export function guidePushPrompt(webPaneId: string, file: string, snapshot: Pick<GuideSnapshot, 'title' | 'steps' | 'changes'>, repoRoot = canvasRepoRoot): string {
  const done = snapshot.steps.filter((step) => step.checked).length
  const next = snapshot.steps.find((step) => !step.checked)
  const script = JSON.stringify(singleLine(resolve(repoRoot, 'scripts/commando-guide')))
  const header = [
    `Guide update from the user: "${clip(singleLine(snapshot.title || 'Guide'), 160)}" (webPaneId ${singleLine(webPaneId)}, file ${singleLine(file)}).`,
    `Progress ${done}/${snapshot.steps.length}${next ? ` · next open step: "${clip(singleLine(next.label), 160)}"` : ' · every step is done'}.`,
  ]
  const footer = `Full state: ${script} state ${singleLine(webPaneId)}. To respond, edit the guide file — the tab re-renders live and keeps ticks by step id.`
  const lines: string[] = []
  let length = header.join('\n').length + footer.length + 2
  for (const change of snapshot.changes) {
    const label = clip(singleLine(change.label), 200)
    const state = change.checkedChanged ? (change.checked ? (change.checkpoint ? '★ reached' : '✓ done') : '↺ unticked') : (change.checked ? '✓' : '○')
    const note = change.noteChanged && change.note ? ` — note: "${clip(singleLine(change.note), 400)}"` : change.noteChanged ? ' — note cleared' : ''
    const line = `- ${state}: ${label}${note}`
    if (length + line.length + 1 > 1_900) break
    lines.push(line); length += line.length + 1
  }
  const omitted = snapshot.changes.length - lines.length
  return [...header, 'Changes since the last update:', ...lines, ...(omitted ? [`… ${omitted} more change(s); read the full state.`] : []), footer].join('\n')
}

type Dependencies = {
  repoRoot?: string
  store: GuideStateStore
  pane: (id: string) => WebPane | undefined
  /** Absolute path of a guide file, or null when its artifact registration is gone. */
  resolveFile: (artifactId: string, file: string) => string | null
  changed: (artifactId: string, file: string) => void
  owns: (paneId: string) => boolean
  sendChat: (paneId: string, text: string, requestId: string) => boolean
  status: (paneId: string) => AgentStatus | undefined
  sendTerminal: (paneId: string, text: string) => Promise<void>
}

/** Guide tabs: user ticks, notes, and "Update agent" pushes when the agent is idle. */
export class Guides {
  /** Guide panes whose "Update agent" is waiting for the anchor agent to go idle. */
  private readonly owed = new Set<string>()
  private readonly sending = new Set<string>()
  constructor(private readonly deps: Dependencies) {}

  snapshot(webPaneId: string): GuideSnapshot {
    const pane = this.guidePane(webPaneId)
    const record = this.deps.store.get(guideKey(pane))
    const base = { marks: record.marks, waiting: this.owed.has(webPaneId), ...(record.deliveredAt ? { deliveredAt: record.deliveredAt } : {}) }
    const path = this.deps.resolveFile(pane.content.artifactId, pane.content.file)
    let markdown: string
    try {
      if (!path) throw new Error('The guide folder is no longer registered')
      if (statSync(path).size > MAX_GUIDE_BYTES) throw new Error('The guide file is larger than 1 MiB')
      markdown = readFileSync(path, 'utf8')
    } catch (error) {
      return { title: '', steps: [], changes: [], ...base, error: error instanceof Error ? error.message : 'The guide file cannot be read' }
    }
    return { ...guideSnapshot(parseGuide(markdown), record.marks, record.delivered), ...base }
  }

  mark(webPaneId: string, body: Record<string, unknown>): GuideSnapshot {
    const pane = this.guidePane(webPaneId)
    const { id, checked, note } = body
    if (typeof id !== 'string' || !GUIDE_STEP_ID.test(id)) throw new WebPaneError(400, 'Invalid step id')
    if (checked !== undefined && typeof checked !== 'boolean') throw new WebPaneError(400, 'checked must be a boolean')
    if (note !== undefined && (typeof note !== 'string' || note.length > MAX_GUIDE_NOTE)) throw new WebPaneError(400, `note must be a string of at most ${MAX_GUIDE_NOTE} characters`)
    if (checked === undefined && note === undefined) throw new WebPaneError(400, 'checked or note is required')
    const step = this.snapshot(webPaneId).steps.find((candidate) => candidate.id === id)
    if (!step) throw new WebPaneError(404, 'Step does not exist')
    this.deps.store.update(guideKey(pane), (record) => {
      const nextNote = note === undefined ? step.note : (note as string).trim()
      record.marks[id] = { checked: checked ?? step.checked, ...(nextNote ? { note: nextNote } : {}), at: Date.now() }
    })
    this.deps.changed(pane.content.artifactId, pane.content.file)
    return this.snapshot(webPaneId)
  }

  /** Clear the user's ticks and notes (the agent's `[x]` steps stay done). */
  reset(webPaneId: string): GuideSnapshot {
    const pane = this.guidePane(webPaneId)
    this.deps.store.update(guideKey(pane), (record) => { record.marks = {} })
    this.deps.changed(pane.content.artifactId, pane.content.file)
    return this.snapshot(webPaneId)
  }

  async requestUpdate(webPaneId: string): Promise<GuideSnapshot> {
    const pane = this.guidePane(webPaneId)
    if (!this.snapshot(webPaneId).changes.length) throw new WebPaneError(409, 'There are no changes to send')
    this.owed.add(webPaneId)
    this.deps.changed(pane.content.artifactId, pane.content.file)
    await this.flush(webPaneId)
    return this.snapshot(webPaneId)
  }

  cancelUpdate(webPaneId: string): GuideSnapshot {
    const pane = this.guidePane(webPaneId)
    if (this.owed.delete(webPaneId)) this.deps.changed(pane.content.artifactId, pane.content.file)
    return this.snapshot(webPaneId)
  }

  async statusChanged(paneId: string): Promise<void> {
    for (const id of [...this.owed]) if (this.deps.pane(id)?.anchorPaneId === paneId) await this.flush(id)
  }

  retain(liveIds: ReadonlySet<string>): void {
    for (const id of this.owed) if (!liveIds.has(id)) this.owed.delete(id)
  }

  private guidePane(webPaneId: string): GuidePane {
    const pane = this.deps.pane(webPaneId)
    if (!pane) throw new WebPaneError(404, 'Web pane does not exist')
    if (pane.content?.kind !== 'guide') throw new WebPaneError(409, 'Not a guide tab')
    return pane as GuidePane
  }

  private async flush(webPaneId: string): Promise<void> {
    const pane = this.deps.pane(webPaneId)
    if (pane?.content?.kind !== 'guide' || !this.owed.has(webPaneId)) return
    const anchor = pane.anchorPaneId
    if (this.sending.has(anchor)) return
    const chat = this.deps.owns(anchor)
    const status = this.deps.status(anchor)
    if (!chat && (!status || status.provider === 'unknown' || status.status !== 'done')) return
    const guide = pane as GuidePane
    const snapshot = this.snapshot(webPaneId)
    if (!snapshot.changes.length) { this.owed.delete(webPaneId); this.deps.changed(guide.content.artifactId, guide.content.file); return }
    const file = this.deps.resolveFile(guide.content.artifactId, guide.content.file) ?? guide.content.file
    const text = guidePushPrompt(webPaneId, file, snapshot, this.deps.repoRoot)
    this.sending.add(anchor)
    try {
      if (chat) {
        if (!this.deps.sendChat(anchor, text, `guide-${randomUUID()}`)) return
      } else await this.deps.sendTerminal(anchor, text)
      // Advance the baseline to exactly what the agent was told.
      this.deps.store.update(guideKey(guide), (record) => {
        for (const change of snapshot.changes) record.delivered[change.id] = { checked: change.checked, ...(change.note ? { note: change.note } : {}) }
        record.deliveredAt = Date.now()
      })
      this.owed.delete(webPaneId)
      this.deps.changed(guide.content.artifactId, guide.content.file)
    } catch { /* Stay owed; the next idle status retries. */ }
    finally { this.sending.delete(anchor) }
  }
}

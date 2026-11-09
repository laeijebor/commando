import { isRedlineArtifactUrl } from '../shared/chat-tile-events.js'
import { isDeckPath } from '../shared/deck.js'
import { isCommandoTargetId } from '../shared/pane-target.js'
import { MAX_WEB_PANE_TITLE_LENGTH, type ClosedWebPane, type ClosedWebPaneKind, type WebPane } from '../shared/protocol.js'

export const CLOSED_WEB_PANE_TTL_MS = 14 * 24 * 60 * 60 * 1_000
export const MAX_CLOSED_WEB_PANES_PER_TARGET = 30
const MAX_CLOSED_WEB_PANES = 600

/** A closed tab, owned by its pane's stable target id so it survives restarts and restores. */
export type ClosedWebPaneEntry = { targetId: string; pane: WebPane; closedAt: number; title?: string }

/** Simulators belong to their lease, unconfirmed tabs were never shown, and DevTools targets die with their page. */
export function revivable(pane: WebPane): boolean {
  return pane.content?.kind !== 'simulator' && pane.status === 'open' && !/devtools/i.test(pane.url)
}

export function closedWebPaneKind(pane: WebPane): ClosedWebPaneKind {
  if (pane.content?.kind === 'canvas') return isDeckPath(pane.content.manifest) ? 'slides' : 'canvas'
  if (pane.content?.kind === 'guide') return 'guide'
  return isRedlineArtifactUrl(pane.url) ? 'redline' : 'page'
}

function fallbackTitle(pane: WebPane): string {
  const file = (path: string) => path.split('/').filter(Boolean).pop() ?? path
  if (pane.content?.kind === 'canvas') return file(pane.content.manifest)
  if (pane.content?.kind === 'guide') return file(pane.content.file)
  try {
    const url = new URL(pane.url)
    return isRedlineArtifactUrl(pane.url) ? decodeURIComponent(file(url.pathname)) : `${url.host}${url.pathname}`
  } catch {
    return pane.url
  }
}

/** Mirrors open()'s reuse identity, so closing the same thing twice keeps one entry. */
function contentKey(pane: WebPane): string {
  if (pane.content?.kind === 'canvas') return `canvas:${pane.content.artifactId}:${pane.content.manifest}`
  if (pane.content?.kind === 'guide') return `guide:${pane.content.artifactId}:${pane.content.file}`
  return `url:${pane.engine}:${pane.url}`
}

/** Recently closed tabs per pane target, newest first, bounded by age and count. */
export class ClosedWebPanes {
  private entries: ClosedWebPaneEntry[] = []

  constructor(private readonly now: () => number) {}

  /** Replaces the list with persisted entries; returns true when trimming dropped any. */
  load(entries: readonly ClosedWebPaneEntry[]): boolean {
    this.entries = [...entries].sort((a, b) => b.closedAt - a.closedAt)
    return this.trim()
  }

  record(targetId: string, pane: WebPane, title?: string): boolean {
    if (!isCommandoTargetId(targetId) || !revivable(pane)) return false
    const key = contentKey(pane)
    const label = title?.trim().slice(0, MAX_WEB_PANE_TITLE_LENGTH)
    this.entries = [
      { targetId, pane: { ...pane }, closedAt: this.now(), ...(label ? { title: label } : {}) },
      ...this.entries.filter((entry) => entry.pane.id !== pane.id && !(entry.targetId === targetId && contentKey(entry.pane) === key)),
    ]
    this.trim()
    return true
  }

  /** Removes and returns an entry for reopening. */
  take(targetId: string, id: string): ClosedWebPaneEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.targetId === targetId && candidate.pane.id === id)
    if (entry) this.entries = this.entries.filter((candidate) => candidate !== entry)
    return entry
  }

  forget(targetId: string, id: string): boolean {
    return this.take(targetId, id) !== undefined
  }

  /** Closed tabs keep their canvas discussions until they expire. */
  ids(): string[] {
    return this.entries.map((entry) => entry.pane.id)
  }

  list(): ClosedWebPaneEntry[] {
    return [...this.entries]
  }

  byTarget(): Record<string, ClosedWebPane[]> {
    const cutoff = this.now() - CLOSED_WEB_PANE_TTL_MS
    const result: Record<string, ClosedWebPane[]> = {}
    for (const { targetId, pane, closedAt, title } of this.entries) {
      if (closedAt <= cutoff) continue
      ;(result[targetId] ??= []).push({ id: pane.id, kind: closedWebPaneKind(pane), title: title ?? fallbackTitle(pane), url: pane.url, closedAt })
    }
    return result
  }

  trim(): boolean {
    const cutoff = this.now() - CLOSED_WEB_PANE_TTL_MS
    const counts = new Map<string, number>()
    const kept = this.entries.filter((entry) => {
      if (entry.closedAt <= cutoff) return false
      const count = (counts.get(entry.targetId) ?? 0) + 1
      counts.set(entry.targetId, count)
      return count <= MAX_CLOSED_WEB_PANES_PER_TARGET
    }).slice(0, MAX_CLOSED_WEB_PANES)
    const changed = kept.length !== this.entries.length
    this.entries = kept
    return changed
  }
}

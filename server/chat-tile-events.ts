import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { tileEventItems, tileFileName, type ChatTileEvent, type ChatTileSource } from '../shared/chat-tile-events.js'
import type { WebPane, WebPaneFeedbackNote } from '../shared/protocol.js'

export const TILE_EVENTS_PER_PANE = 100
/** Across all panes, so the file stays far below the size the loader accepts. */
export const TILE_EVENTS_TOTAL = 1_000
export const TILE_EVENTS_BYTES = 8 * 1024 * 1024

export function defaultChatTileEventsPath(port = 4310): string {
  return join(homedir(), '.commando', `chat-tile-events-${port}.json`)
}

/** The server's copy also keeps which feedback notes a Send carried. */
type StoredEvent = ChatTileEvent & { deliveryKeys?: string[] }

type Options = {
  path?: string
  publish?: (paneId: string, events: ChatTileEvent[]) => void
  now?: () => number
  newId?: () => string
}

const isEvent = (value: unknown): value is StoredEvent => {
  const event = value as StoredEvent | null
  return Boolean(event) && typeof event!.id === 'string' && (event!.kind === 'opened' || event!.kind === 'sent') &&
    typeof event!.paneId === 'string' && typeof event!.webPaneId === 'string' &&
    (event!.source === 'redline' || event!.source === 'canvas') && typeof event!.fileName === 'string' && Number.isFinite(event!.at)
}

const forClient = ({ deliveryKeys: _keys, ...event }: StoredEvent): ChatTileEvent => event

/**
 * Redline/canvas moments shown as cards in a Commando chat: an agent opened a
 * tile, or the user sent answers from one. Display only — the feedback journal
 * stays the source of truth for delivery.
 */
export class ChatTileEvents {
  private readonly path: string
  private readonly publishPane: (paneId: string, events: ChatTileEvent[]) => void
  private readonly now: () => number
  private readonly newId: () => string
  private readonly panes = new Map<string, StoredEvent[]>()

  constructor(options: Options = {}) {
    this.path = options.path ?? defaultChatTileEventsPath()
    this.publishPane = options.publish ?? (() => undefined)
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => `te-${randomUUID().slice(0, 12)}`)
    try {
      if (statSync(this.path).size > TILE_EVENTS_BYTES) return
      const entries: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (Array.isArray(entries)) for (const entry of entries) if (isEvent(entry)) this.list(entry.paneId).push(entry)
    } catch { /* A missing or corrupt store starts empty. */ }
  }

  forPane(paneId: string): ChatTileEvent[] {
    return (this.panes.get(paneId) ?? []).map(forClient)
  }

  snapshots(): { paneId: string; events: ChatTileEvent[] }[] {
    return [...this.panes.keys()].map((paneId) => ({ paneId, events: this.forPane(paneId) }))
  }

  opened(pane: WebPane, source: ChatTileSource, title?: string, sessionId?: string): ChatTileEvent {
    return this.add({ ...this.base(pane, source, title, sessionId), kind: 'opened' })
  }

  /**
   * Records one Send. Notes already on record (a retried Send) are left out;
   * returns undefined when nothing new was sent.
   */
  sent(pane: WebPane, source: ChatTileSource, notes: readonly WebPaneFeedbackNote[], options: { title?: string; status?: 'sent' | 'waiting' | 'collected'; sessionId?: string } = {}): ChatTileEvent | undefined {
    const known = new Set(this.list(pane.anchorPaneId).filter((event) => event.webPaneId === pane.id).flatMap((event) => event.deliveryKeys ?? []))
    const fresh = notes.filter((note) => !note.deliveryKey || !known.has(note.deliveryKey))
    if (!fresh.length) return undefined
    const keys = fresh.flatMap((note) => note.deliveryKey ? [note.deliveryKey] : [])
    return this.add({
      ...this.base(pane, source, options.title, options.sessionId),
      kind: 'sent',
      items: tileEventItems(fresh),
      ...(fresh.some((note) => note.handoff?.kind === 'build') ? { build: true } : {}),
      status: options.status ?? 'sent',
      ...(options.status === 'collected' ? { collectedAt: this.now() } : {}),
      ...(keys.length ? { deliveryKeys: keys } : {}),
    })
  }

  /** Ids of the Sends that carried these notes, oldest first. */
  idsFor(webPaneId: string, deliveryKeys: readonly string[]): string[] {
    const wanted = new Set(deliveryKeys)
    return this.all().filter((event) => event.webPaneId === webPaneId && event.deliveryKeys?.some((key) => wanted.has(key))).map((event) => event.id)
  }

  /** A pushed prompt reached the agent: no longer waiting. */
  delivered(ids: readonly string[]): void {
    const wanted = new Set(ids)
    this.update((event) => wanted.has(event.id) && event.status === 'waiting' ? { ...event, status: 'sent' } : undefined)
  }

  /** A poll was handed the tile's whole backlog: the agent has everything sent from it. */
  drained(webPaneId: string): void {
    const at = this.now()
    this.update((event) => event.webPaneId === webPaneId && event.kind === 'sent' && event.status !== 'collected'
      ? { ...event, status: 'collected', collectedAt: at }
      : undefined)
  }

  /** Fills in titles that were not known when the event was recorded. */
  retitle(webPaneId: string, title: string): void {
    const trimmed = title.trim()
    if (!trimmed) return
    this.update((event) => event.webPaneId === webPaneId && !event.title ? { ...event, title: trimmed } : undefined)
  }

  private base(pane: WebPane, source: ChatTileSource, title?: string, sessionId?: string) {
    const trimmed = title?.trim()
    return {
      id: this.newId(),
      paneId: pane.anchorPaneId,
      ...(sessionId ? { sessionId } : {}),
      webPaneId: pane.id,
      source,
      ...(trimmed ? { title: trimmed.slice(0, 300) } : {}),
      fileName: tileFileName(pane.url),
      at: this.now(),
    }
  }

  private add(event: StoredEvent): ChatTileEvent {
    const list = this.list(event.paneId)
    list.push(event)
    if (list.length > TILE_EVENTS_PER_PANE) list.splice(0, list.length - TILE_EVENTS_PER_PANE)
    this.trimOldest()
    this.save()
    this.publishPane(event.paneId, this.forPane(event.paneId))
    return forClient(event)
  }

  private update(change: (event: StoredEvent) => StoredEvent | undefined): void {
    const touched = new Set<string>()
    for (const [paneId, list] of this.panes) {
      list.forEach((event, index) => {
        const next = change(event)
        if (next) { list[index] = next; touched.add(paneId) }
      })
    }
    if (!touched.size) return
    this.save()
    for (const paneId of touched) this.publishPane(paneId, this.forPane(paneId))
  }

  private trimOldest(): void {
    const all = this.all()
    if (all.length <= TILE_EVENTS_TOTAL) return
    const dropped = new Set(all.sort((a, b) => a.at - b.at).slice(0, all.length - TILE_EVENTS_TOTAL).map((event) => event.id))
    for (const [paneId, list] of this.panes) {
      const kept = list.filter((event) => !dropped.has(event.id))
      if (kept.length) this.panes.set(paneId, kept)
      else this.panes.delete(paneId)
    }
  }

  private list(paneId: string): StoredEvent[] {
    let list = this.panes.get(paneId)
    if (!list) { list = []; this.panes.set(paneId, list) }
    return list
  }

  private all(): StoredEvent[] {
    return [...this.panes.values()].flat()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(this.all()), { mode: 0o600 })
      renameSync(temporary, this.path)
    } catch (error) {
      console.warn('[commando] could not save chat tile events', error)
    }
  }
}

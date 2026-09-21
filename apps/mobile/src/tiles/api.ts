import type {
  WebPaneEngine,
  WebPanePendingNote,
  WebPanePendingSnapshot,
  WebPanePlacement,
} from '@commando/protocol'

import { daemonFetch, DaemonHttpError } from '../hosts/api'
import type { Host } from '../hosts/types'
import type { TileInspectRect } from './protocol'

/** A pending note as the app submits it — the daemon assigns id and revision. */
export type PendingNoteDraft = {
  selector: string
  tag: string
  text?: string
  rect: TileInspectRect
  comment: string
  pageUrl?: string
  queueKey?: string
}

export type PendingSendTarget = { id: number; revision: number }

/**
 * Normalises a pending body, tolerating a daemon older than this app. A
 * missing `knownUpTo` must read as "everything is unknown", not zero, or the
 * caller would think the daemon had already accounted for its notes.
 */
export function toPendingSnapshot(body: unknown): WebPanePendingSnapshot {
  const raw = (body ?? {}) as Partial<WebPanePendingSnapshot>
  return {
    ...(typeof raw.revision === 'number' ? { revision: raw.revision } : {}),
    notes: Array.isArray(raw.notes) ? (raw.notes as WebPanePendingNote[]) : [],
    knownUpTo: typeof raw.knownUpTo === 'number' ? raw.knownUpTo : Number.POSITIVE_INFINITY,
    dropped: typeof raw.dropped === 'number' ? raw.dropped : 0,
  }
}

async function call(
  host: Host,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const response = await daemonFetch(host, path, init)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Tile request failed (${response.status})`
    throw new DaemonHttpError(response.status, message)
  }
  return body
}

function tilePath(webPaneId: string, suffix = ''): string {
  return `/api/web-panes/${encodeURIComponent(webPaneId)}${suffix}`
}

/** `POST /api/web-panes` — opens a tile beside an anchor pane. */
export async function openTile(
  host: Host,
  input: { url: string; anchor: string; placement?: WebPanePlacement; engine?: WebPaneEngine },
): Promise<{ webPaneId: string; status: 'open' | 'pending'; engine: WebPaneEngine }> {
  const body = await call(host, '/api/web-panes', {
    method: 'POST',
    body: {
      url: input.url,
      anchor: input.anchor,
      ...(input.placement ? { placement: input.placement } : {}),
      // Chromium is the only engine the phone can render, so it is the default.
      engine: input.engine ?? 'chromium',
    },
  })
  return body as { webPaneId: string; status: 'open' | 'pending'; engine: WebPaneEngine }
}

/** `POST …/:id/confirm` — the owner approving an external origin. */
export async function confirmTile(host: Host, webPaneId: string, allowOrigin: boolean): Promise<void> {
  await call(host, tilePath(webPaneId, '/confirm'), { method: 'POST', body: { allowOrigin } })
}

export async function closeTile(host: Host, webPaneId: string): Promise<void> {
  await call(host, tilePath(webPaneId), { method: 'DELETE' })
}

export async function navigateTile(host: Host, webPaneId: string, url: string): Promise<void> {
  await call(host, tilePath(webPaneId, '/navigate'), { method: 'POST', body: { url } })
}

export async function fetchPendingNotes(host: Host, webPaneId: string): Promise<WebPanePendingSnapshot> {
  return toPendingSnapshot(await call(host, tilePath(webPaneId, '/pending')))
}

export async function addPendingNote(
  host: Host,
  webPaneId: string,
  note: PendingNoteDraft,
): Promise<WebPanePendingSnapshot> {
  return toPendingSnapshot(await call(host, tilePath(webPaneId, '/pending'), {
    method: 'POST',
    body: { note },
  }))
}

/**
 * `PATCH …/pending/:noteId` — the optimistic update the editor makes. The
 * revision the draft was based on goes with it, so an answer the page
 * re-queued underneath the editor is rejected rather than overwritten.
 */
export async function updatePendingNote(
  host: Host,
  webPaneId: string,
  noteId: number,
  expectedRevision: number,
  change: { answer?: string; note?: string },
): Promise<WebPanePendingSnapshot> {
  return toPendingSnapshot(await call(host, tilePath(webPaneId, `/pending/${noteId}`), {
    method: 'PATCH',
    body: { expectedRevision, ...change },
  }))
}

export async function removePendingNote(
  host: Host,
  webPaneId: string,
  noteId: number,
): Promise<WebPanePendingSnapshot> {
  return toPendingSnapshot(await call(host, tilePath(webPaneId, `/pending/${noteId}`), { method: 'DELETE' }))
}

function sendBody(
  targets: readonly PendingSendTarget[] | undefined,
  expectedQueueRevision: number | undefined,
): Record<string, unknown> {
  return {
    ...(targets && targets.length > 0 ? { items: targets } : {}),
    ...(expectedQueueRevision !== undefined ? { expectedQueueRevision } : {}),
  }
}

/**
 * `POST …/pending/send` — hands the queue to the agent. The queue revision
 * the strip was rendered from goes with it so a send cannot swallow an answer
 * that arrived while the owner was reading.
 */
export async function sendPendingNotes(
  host: Host,
  webPaneId: string,
  options: { targets?: readonly PendingSendTarget[]; expectedQueueRevision?: number } = {},
): Promise<WebPanePendingSnapshot> {
  return toPendingSnapshot(await call(host, tilePath(webPaneId, '/pending/send'), {
    method: 'POST',
    body: sendBody(options.targets, options.expectedQueueRevision),
  }))
}

/**
 * `POST …/pending/send-build` — the same send plus the build handoff. The
 * daemon must echo `intent: 'build'`; an older one silently drops the handoff,
 * which would look like a successful send that never builds.
 */
export async function sendPendingNotesAndBuild(
  host: Host,
  webPaneId: string,
  options: { targets?: readonly PendingSendTarget[]; expectedQueueRevision: number },
): Promise<WebPanePendingSnapshot> {
  const body = await call(host, tilePath(webPaneId, '/pending/send-build'), {
    method: 'POST',
    body: sendBody(options.targets, options.expectedQueueRevision),
  })
  if (typeof body !== 'object' || body === null || (body as { intent?: unknown }).intent !== 'build') {
    throw new Error('The daemon did not acknowledge the build handoff. Update Commando before retrying.')
  }
  return toPendingSnapshot(body)
}

export async function dismissDroppedAnswers(
  host: Host,
  webPaneId: string,
): Promise<WebPanePendingSnapshot> {
  return toPendingSnapshot(await call(host, tilePath(webPaneId, '/pending/dropped'), {
    method: 'POST',
    body: {},
  }))
}

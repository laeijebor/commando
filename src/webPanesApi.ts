import type { WebPaneEngine, WebPaneFeedbackNote, WebPanePendingNote, WebPanePendingSnapshot, WebPanePlacement } from '../shared/protocol'

/** A pending note as the client submits it — the daemon assigns the id. */
export type PendingNoteDraft = Omit<WebPanePendingNote, 'id' | 'revision' | 'attachments'>
export type PendingSendTarget = { id: number; revision: number }

export interface WebPanesApiClient {
  open(
    url: string,
    anchor: string,
    placement?: WebPanePlacement,
    engine?: WebPaneEngine,
  ): Promise<{ webPaneId: string; status: 'open' | 'pending' }>
  confirm(webPaneId: string, allowOrigin: boolean): Promise<void>
  close(webPaneId: string): Promise<void>
  cdp(webPaneId: string): Promise<{ target: string; devtoolsFrontendUrl: string }>
  submitFeedback(webPaneId: string, notes: WebPaneFeedbackNote[]): Promise<void>
  pendingNotes(webPaneId: string): Promise<WebPanePendingSnapshot>
  addPendingNote(webPaneId: string, note: PendingNoteDraft): Promise<WebPanePendingSnapshot>
  updatePendingNote(
    webPaneId: string,
    noteId: number,
    expectedRevision: number,
    change: { answer?: string; note?: string },
  ): Promise<WebPanePendingSnapshot>
  uploadPendingAttachment(
    webPaneId: string,
    noteId: number,
    expectedRevision: number,
    file: File,
  ): Promise<WebPanePendingSnapshot>
  removePendingAttachment(
    webPaneId: string,
    noteId: number,
    expectedRevision: number,
    attachmentId: string,
  ): Promise<WebPanePendingSnapshot>
  removePendingNote(webPaneId: string, noteId: number): Promise<WebPanePendingSnapshot>
  sendPendingNotes(
    webPaneId: string,
    targets?: readonly number[] | readonly PendingSendTarget[],
  ): Promise<WebPanePendingSnapshot>
  pendingAttachmentUrl(webPaneId: string, attachmentId: string): string
  dismissPendingDropped(webPaneId: string): Promise<WebPanePendingSnapshot>
  move(webPaneId: string, anchor: string, placement: 'right' | 'below'): Promise<void>
  navigate(webPaneId: string, url: string): Promise<void>
}

type ApiErrorBody = { error?: unknown }

/** Normalizes a pending response body, tolerating an older daemon's shape. */
function toSnapshot(body: unknown): WebPanePendingSnapshot {
  const raw = body as Partial<WebPanePendingSnapshot> | null
  return {
    ...(typeof raw?.revision === 'number' ? { revision: raw.revision } : {}),
    notes: Array.isArray(raw?.notes) ? (raw.notes as WebPanePendingNote[]) : [],
    knownUpTo: typeof raw?.knownUpTo === 'number' ? raw.knownUpTo : Number.POSITIVE_INFINITY,
    dropped: typeof raw?.dropped === 'number' ? raw.dropped : 0,
  }
}

function apiError(status: number, body: unknown): Error {
  const message =
    typeof body === 'object' && body !== null && typeof (body as ApiErrorBody).error === 'string'
      ? (body as { error: string }).error
      : `Web pane request failed (${status})`
  return new Error(message)
}

export function createWebPanesApi(
  token: string,
  fetcher: typeof fetch = fetch,
): WebPanesApiClient {
  const parseResponse = async (response: Response): Promise<unknown> => {
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok) throw apiError(response.status, body)
    return body
  }

  const request = async (path: string, init: RequestInit): Promise<unknown> => {
    const response = await fetcher(`/api/web-panes${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
    return await parseResponse(response)
  }

  const upload = async (path: string, expectedRevision: number, file: File): Promise<unknown> => {
    const response = await fetcher(`/api/web-panes${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': file.type,
        'X-Pending-Revision': String(expectedRevision),
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    })
    return await parseResponse(response)
  }

  return {
    open: async (url, anchor, placement, engine) => {
      const body = await request('', {
        method: 'POST',
        body: JSON.stringify({
          url,
          anchor,
          ...(placement ? { placement } : {}),
          ...(engine ? { engine } : {}),
        }),
      }) as { webPaneId: string; status: 'open' | 'pending' }
      return body
    },
    confirm: async (webPaneId, allowOrigin) => {
      await request(`/${encodeURIComponent(webPaneId)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ allowOrigin }),
      })
    },
    close: async (webPaneId) => {
      await request(`/${encodeURIComponent(webPaneId)}`, { method: 'DELETE' })
    },
    cdp: async (webPaneId) => {
      return await request(`/${encodeURIComponent(webPaneId)}/cdp`, { method: 'GET' }) as {
        target: string
        devtoolsFrontendUrl: string
      }
    },
    submitFeedback: async (webPaneId, notes) => {
      await request(`/${encodeURIComponent(webPaneId)}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ notes }),
      })
    },
    pendingNotes: async (webPaneId) => {
      return toSnapshot(await request(`/${encodeURIComponent(webPaneId)}/pending`, { method: 'GET' }))
    },
    addPendingNote: async (webPaneId, note) => {
      return toSnapshot(await request(`/${encodeURIComponent(webPaneId)}/pending`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }))
    },
    updatePendingNote: async (webPaneId, noteId, expectedRevision, change) => {
      return toSnapshot(await request(`/${encodeURIComponent(webPaneId)}/pending/${noteId}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision, ...change }),
      }))
    },
    uploadPendingAttachment: async (webPaneId, noteId, expectedRevision, file) => {
      return toSnapshot(await upload(
        `/${encodeURIComponent(webPaneId)}/pending/${noteId}/attachments`,
        expectedRevision,
        file,
      ))
    },
    removePendingAttachment: async (webPaneId, noteId, expectedRevision, attachmentId) => {
      return toSnapshot(await request(
        `/${encodeURIComponent(webPaneId)}/pending/${noteId}/attachments/${encodeURIComponent(attachmentId)}`,
        {
          method: 'DELETE',
          headers: { 'X-Pending-Revision': String(expectedRevision) },
        },
      ))
    },
    removePendingNote: async (webPaneId, noteId) => {
      return toSnapshot(await request(`/${encodeURIComponent(webPaneId)}/pending/${noteId}`, {
        method: 'DELETE',
      }))
    },
    sendPendingNotes: async (webPaneId, targets) => {
      return toSnapshot(await request(`/${encodeURIComponent(webPaneId)}/pending/send`, {
        method: 'POST',
        body: JSON.stringify(
          targets === undefined
            ? {}
            : targets.every((target) => typeof target === 'number')
              ? { ids: targets }
              : { items: targets },
        ),
      }))
    },
    pendingAttachmentUrl: (webPaneId, attachmentId) => {
      const path = `/api/web-panes/${encodeURIComponent(webPaneId)}/attachments/${encodeURIComponent(attachmentId)}`
      return token ? `${path}?token=${encodeURIComponent(token)}` : path
    },
    dismissPendingDropped: async (webPaneId) => {
      return toSnapshot(await request(`/${encodeURIComponent(webPaneId)}/pending/dropped`, {
        method: 'POST',
        body: JSON.stringify({}),
      }))
    },
    move: async (webPaneId, anchor, placement) => {
      await request(`/${encodeURIComponent(webPaneId)}/move`, {
        method: 'POST',
        body: JSON.stringify({ anchor, placement }),
      })
    },
    navigate: async (webPaneId, url) => {
      await request(`/${encodeURIComponent(webPaneId)}/navigate`, {
        method: 'POST',
        body: JSON.stringify({ url }),
      })
    },
  }
}

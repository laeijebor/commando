import type { CanvasSpotlightRequest, CanvasNoteContext, CanvasThread, WebPaneEngine, WebPaneFeedbackNote, WebPanePendingNote, WebPanePendingSendIntent, WebPanePendingSnapshot, WebPanePlacement } from '../shared/protocol'
import { parsePendingSent, type RedlinePageResponse } from '../shared/redline-response'

/** A pending note as the client submits it — the daemon assigns the id. */
export type PendingNoteDraft = Omit<WebPanePendingNote, 'id' | 'revision' | 'attachments'>
export type PendingSendTarget = { id: number; revision: number }
export type PendingSendOptions = {
  intent?: WebPanePendingSendIntent
  expectedQueueRevision: number
}

export interface WebPanesApiClient {
  open(
    url: string,
    anchor: string,
    placement?: WebPanePlacement,
    engine?: WebPaneEngine,
  ): Promise<{ webPaneId: string; status: 'open' | 'pending'; reused?: boolean }>
  setActiveTab(webPaneId: string, anchorPaneId?: string): Promise<void>
  dismissPrTab(anchorPaneId: string, key: string, signature: string, nextKey?: string): Promise<void>
  restorePrTab(anchorPaneId: string, key: string, select?: boolean): Promise<void>
  clearUnseen(webPaneId: string): Promise<void>
  confirm(webPaneId: string, allowOrigin: boolean): Promise<void>
  close(webPaneId: string): Promise<void>
  cdp(webPaneId: string): Promise<{ target: string; devtoolsFrontendUrl: string }>
  submitFeedback(webPaneId: string, notes: WebPaneFeedbackNote[]): Promise<void>
  threads(webPaneId: string): Promise<CanvasThread[]>
  replyThread(webPaneId: string, threadId: string, text: string): Promise<void>
  setThreadStatus(webPaneId: string, threadId: string, status: 'open' | 'resolved'): Promise<void>
  answerSpotlight(webPaneId: string, requestId: string, decision: 'accept' | 'dismiss'): Promise<void>
  /** `sentPage` reads that page's sent answers instead of the tile's own page. */
  pendingNotes(webPaneId: string, sentPage?: string): Promise<WebPanePendingSnapshot>
  addPendingNote(webPaneId: string, note: PendingNoteDraft): Promise<WebPanePendingSnapshot>
  addPendingResponse(
    webPaneId: string,
    pageUrl: string,
    response: RedlinePageResponse,
    canvas?: CanvasNoteContext,
  ): Promise<WebPanePendingSnapshot>
  updatePendingNote(
    webPaneId: string,
    noteId: number,
    expectedRevision: number,
    change: { answer?: string; note?: string; response?: RedlinePageResponse },
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
    options?: PendingSendOptions,
  ): Promise<WebPanePendingSnapshot>
  pendingAttachmentUrl(webPaneId: string, attachmentId: string): string
  dismissPendingDropped(webPaneId: string): Promise<WebPanePendingSnapshot>
  /** Tells the daemon which page the tile shows, returning that page's sent answers. */
  setPendingPage(webPaneId: string, url: string): Promise<WebPanePendingSnapshot>
  dock(webPaneId: string, dock: 'panel' | 'split', anchorSize?: { cols: number; rows: number }): Promise<void>
  move(webPaneId: string, anchor: string, placement: 'right' | 'below'): Promise<void>
  navigate(webPaneId: string, url: string): Promise<void>
  answerNavigateRequest(webPaneId: string, requestId: string, decision: 'accept' | 'dismiss'): Promise<void>
}

type ApiErrorBody = { error?: unknown }

/** Normalizes a pending response body, tolerating an older daemon's shape. */
function toSnapshot(body: unknown): WebPanePendingSnapshot {
  const raw = body as Partial<WebPanePendingSnapshot> | null
  const sent = parsePendingSent(raw?.sent)
  return {
    ...(typeof raw?.revision === 'number' ? { revision: raw.revision } : {}),
    notes: Array.isArray(raw?.notes) ? (raw.notes as WebPanePendingNote[]) : [],
    knownUpTo: typeof raw?.knownUpTo === 'number' ? raw.knownUpTo : Number.POSITIVE_INFINITY,
    dropped: typeof raw?.dropped === 'number' ? raw.dropped : 0,
    ...(sent ? { sent } : {}),
  }
}

function apiError(status: number, body: unknown): Error {
  const message =
    typeof body === 'object' && body !== null && typeof (body as ApiErrorBody).error === 'string'
      ? (body as { error: string }).error
      : `Web pane request failed (${status})`
  return Object.assign(new Error(message), { status })
}

export function createOwnerJsonRequest(token: string, fetcher: typeof fetch = fetch) {
  return async (url: string, init: RequestInit): Promise<unknown> => {
    const response = await fetcher(url, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok) throw apiError(response.status, body)
    return body
  }
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

  const ownerRequest = createOwnerJsonRequest(token, fetcher)
  const request = (path: string, init: RequestInit) => ownerRequest(`/api/web-panes${path}`, init)

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
    dismissPrTab: async (anchorPaneId, key, signature, nextKey) => { await request('/pr-tabs/dismiss', { method: 'POST', body: JSON.stringify({ anchorPaneId, key, signature, ...(nextKey !== undefined ? { nextKey } : {}) }) }) },
    restorePrTab: async (anchorPaneId, key, select) => { await request('/pr-tabs/restore', { method: 'POST', body: JSON.stringify({ anchorPaneId, key, ...(select !== undefined ? { select } : {}) }) }) },
    setActiveTab: async (id, anchorPaneId) => { await request(`/${encodeURIComponent(id)}/active-tab`, { method: 'POST', ...(anchorPaneId ? { body: JSON.stringify({ anchorPaneId }) } : {}) }) },
    clearUnseen: async (id) => { await request(`/${encodeURIComponent(id)}/seen`, { method: 'POST' }) },
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
    threads: async (webPaneId) => {
      const body = await request(`/${encodeURIComponent(webPaneId)}/threads`, { method: 'GET' }) as { threads?: CanvasThread[] }
      return body.threads ?? []
    },
    replyThread: async (id, threadId, text) => {
      await request(`/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/replies`, { method: 'POST', body: JSON.stringify({ text, author: 'user' }) })
    },
    setThreadStatus: async (id, threadId, status) => {
      await request(`/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/status`, { method: 'POST', body: JSON.stringify({ status }) })
    },
    answerSpotlight: async (id, requestId, decision) => {
      await request(`/${encodeURIComponent(id)}/spotlight-requests/${encodeURIComponent(requestId)}`, { method: 'POST', body: JSON.stringify({ decision }) })
    },
    pendingNotes: async (webPaneId, sentPage) => {
      const query = sentPage ? `?sentPage=${encodeURIComponent(sentPage)}` : ''
      return toSnapshot(await request(`/${encodeURIComponent(webPaneId)}/pending${query}`, { method: 'GET' }))
    },
    addPendingNote: async (webPaneId, note) => {
      return toSnapshot(await request(`/${encodeURIComponent(webPaneId)}/pending`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }))
    },
    addPendingResponse: async (webPaneId, pageUrl, response, canvas) => {
      return toSnapshot(await request(`/${encodeURIComponent(webPaneId)}/pending/response`, {
        method: 'POST',
        body: JSON.stringify({ pageUrl, response, ...(canvas ? { canvas } : {}) }),
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
    sendPendingNotes: async (webPaneId, targets, options) => {
      const body: Record<string, unknown> = targets === undefined
        ? {}
        : targets.every((target) => typeof target === 'number')
          ? { ids: targets }
          : { items: targets }
      if (options !== undefined) body.expectedQueueRevision = options.expectedQueueRevision
      const action = options?.intent === 'build' ? 'send-build' : 'send'
      const response = await request(`/${encodeURIComponent(webPaneId)}/pending/${action}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (
        options?.intent === 'build' &&
        (typeof response !== 'object' || response === null || (response as { intent?: unknown }).intent !== 'build')
      ) {
        throw new Error('The daemon did not acknowledge the build handoff. Update Commando before retrying.')
      }
      return toSnapshot(response)
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
    setPendingPage: async (webPaneId, url) => {
      return toSnapshot(await request(`/${encodeURIComponent(webPaneId)}/pending/page`, {
        method: 'POST',
        body: JSON.stringify({ url }),
      }))
    },
    dock: async (webPaneId, dock, anchorSize) => {
      await request(`/${encodeURIComponent(webPaneId)}/dock`, {
        method: 'POST',
        body: JSON.stringify({ dock, ...(anchorSize ? { anchorSize } : {}) }),
      })
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
    answerNavigateRequest: async (webPaneId, requestId, decision) => {
      await request(`/${encodeURIComponent(webPaneId)}/navigate-requests/${encodeURIComponent(requestId)}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      })
    },
  }
}

export type CanvasChange = { artifactId: string; changed: string[] }
type ChannelArgs<T> = [T] extends [void] ? [] : [value: T]
export function createChannel<T>() {
  const listeners = new Set<(...args: ChannelArgs<T>) => void>()
  return {
    publish: (...args: ChannelArgs<T>) => { for (const listener of listeners) listener(...args) },
    subscribe: (listener: (...args: ChannelArgs<T>) => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
const changes = createChannel<CanvasChange>()
export const publishCanvasChange = changes.publish
export const subscribeCanvasChanges = changes.subscribe
const threads = createChannel<string>()
export const publishCanvasThreadsChanged = threads.publish
export const subscribeCanvasThreads = threads.subscribe
const pending = createChannel<string>()
export const publishCanvasPendingChanged = pending.publish
export const subscribeCanvasPending = pending.subscribe
const guideStates = createChannel<{ artifactId: string; file: string }>()
export const publishGuideStateChanged = guideStates.publish
export const subscribeGuideStates = guideStates.subscribe
const refresh = createChannel<void>()
export const publishCanvasRefresh = () => refresh.publish()
export const subscribeCanvasRefresh = refresh.subscribe

let canvasSpotlights: Record<string, CanvasSpotlightRequest> = {}
const spotlights = createChannel<Record<string, CanvasSpotlightRequest>>()
export function publishCanvasSpotlights(requests: Record<string, CanvasSpotlightRequest>): void {
  canvasSpotlights = requests
  spotlights.publish(requests)
}
export function subscribeCanvasSpotlights(listener: (requests: Record<string, CanvasSpotlightRequest>) => void): () => void {
  const unsubscribe = spotlights.subscribe(listener)
  listener(canvasSpotlights)
  return unsubscribe
}

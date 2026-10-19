import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasFrame, CanvasSection } from '../shared/canvas-manifest'
import type { CanvasThread, WebPanePendingNote, WebPanePendingSnapshot } from '../shared/protocol'
import type { RedlinePageResponse } from '../shared/redline-response'
import { canvasNoteContext, canvasRedlineResponse, canvasSectionStatusNote, type CanvasDraft } from './canvasComments'
import { createWebPanesApi, subscribeCanvasThreads, subscribeCanvasPending, subscribeCanvasRefresh } from './webPanesApi'

const EMPTY: WebPanePendingSnapshot = { revision: 0, notes: [], knownUpTo: 0, dropped: 0 }
/** `questionsPage` is the page canvas-level answers belong to; its sent answers ride along in each snapshot. */
export function useCanvasComments(webPaneId: string | undefined, token: string, frames: CanvasFrame[], sections: CanvasSection[], questionsPage?: string) {
  const api = useMemo(() => createWebPanesApi(token), [token])
  const [snapshot, setSnapshot] = useState(EMPTY)
  const [threads, setThreads] = useState<CanvasThread[]>([])
  const [draft, setDraft] = useState<CanvasDraft | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false), lifetime = useRef(0), threadRequest = useRef(0)
  const apply = useCallback((next: WebPanePendingSnapshot) => setSnapshot((current) =>
    (next.revision ?? 0) >= (current.revision ?? 0) ? next : current), [])
  const refreshThreads = useCallback(async () => {
    if (!webPaneId) return
    const generation = lifetime.current, request = ++threadRequest.current
    const next = await api.threads(webPaneId)
    if (generation === lifetime.current && request === threadRequest.current) setThreads(next)
  }, [api, webPaneId])
  useEffect(() => {
    const generation = ++lifetime.current
    setSnapshot(EMPTY); setThreads([]); setDraft(null); setActive(null); setError('')
    lock.current = false; setBusy(false)
    if (!webPaneId) return
    const accept = (next: WebPanePendingSnapshot) => { if (generation === lifetime.current) apply(next) }
    const fail = (reason: unknown) => { if (generation === lifetime.current) setError(String((reason as Error).message)) }
    // Re-asserting the page is idempotent and survives a daemon restart forgetting it.
    const load = () => void (questionsPage ? api.setPendingPage(webPaneId, questionsPage) : api.pendingNotes(webPaneId)).then(accept).catch(fail)
    load()
    void refreshThreads().catch(fail)
    const unsubscribe = subscribeCanvasPending((id) => { if (id === webPaneId) load() })
    const unthreads = subscribeCanvasThreads((id) => { if (id === webPaneId) void refreshThreads().catch(fail) })
    const unrefresh = subscribeCanvasRefresh(() => {
      load()
      void refreshThreads().catch(fail)
    })
    return () => { ++lifetime.current; unsubscribe(); unthreads(); unrefresh() }
  }, [webPaneId, token, api, apply, refreshThreads, questionsPage])

  const mutate = async (work: () => Promise<void>) => {
    if (!webPaneId || lock.current) return
    const generation = lifetime.current
    lock.current = true; setBusy(true); setError('')
    try { await work(); return true } catch (reason) {
      if (generation === lifetime.current) {
        setError(String((reason as Error).message))
        // A stale send must be reviewed against a fresh queue, never retried automatically.
        try { const next = await api.pendingNotes(webPaneId); if (generation === lifetime.current) apply(next) } catch { /* Keep the original error. */ }
      }
    } finally { if (generation === lifetime.current) { lock.current = false; setBusy(false) } }
  }
  const send = async (notes: WebPanePendingNote[], current: WebPanePendingSnapshot) => {
    if (!webPaneId || !notes.length) return
    const generation = lifetime.current
    const next = await api.sendPendingNotes(webPaneId, notes.map((n) => ({ id: n.id, revision: n.revision ?? 1 })),
      current.revision !== undefined ? { expectedQueueRevision: current.revision } : undefined)
    if (generation !== lifetime.current) return
    apply(next)
    await refreshThreads()
    if (generation === lifetime.current) setActive(null)
  }
  const queueDraft = (comment: string, sendThis: boolean) => mutate(async () => {
    if (!draft || !webPaneId || !comment.trim()) return
    const generation = lifetime.current
    const { hit, canvas, pageUrl } = draft
    const next = await api.addPendingNote(webPaneId, { selector: hit.selector, tag: hit.tag, text: hit.text,
      rect: { x: hit.rect.x, y: hit.rect.y, width: hit.rect.w, height: hit.rect.h }, comment: comment.trim(), canvas, pageUrl })
    if (generation !== lifetime.current) return
    apply(next)
    const added = [...next.notes].reverse().find((n) => n.canvas?.frameId === canvas.frameId && n.comment === comment.trim() && n.id > snapshot.knownUpTo)
    setDraft(null); setActive(added ? `pending:${added.id}` : null)
    if (sendThis && added) await send([added], next)
    else setActive(null)
  })
  const queued = snapshot.notes.filter((note) => note.canvas)
  const sectionStatus = (section: CanvasSection, status: CanvasSection['status'], pageUrl: string) => mutate(async () => {
    if (!webPaneId) return
    const frame = frames.find((f) => section.frames.includes(f.id))
    if (!frame) return
    const generation = lifetime.current
    const note = canvasSectionStatusNote(frame, section, status, pageUrl)
    const next = await api.addPendingNote(webPaneId, note)
    if (generation !== lifetime.current) return
    apply(next)
    const added = [...next.notes].reverse().find((n) => n.id > snapshot.knownUpTo && n.comment === note.comment && n.canvas?.frameId === frame.id)
    if (added) await send([added], next)
  })
  const relay = (frameId: string, payload: unknown, pageUrl: string) => {
    const response = canvasRedlineResponse(payload), frame = frames.find((f) => f.id === frameId)
    if (!response || !frame || !webPaneId) return
    const generation = lifetime.current
    const point = { x: Math.min(frame.w, Math.max(0, response.rect?.x ?? 0)), y: Math.min(frame.h, Math.max(0, response.rect?.y ?? 0)) }
    void api.addPendingResponse(webPaneId, pageUrl, response, canvasNoteContext(frame, sections, point))
      .then((next) => { if (generation === lifetime.current) apply(next) })
      .catch((reason: Error) => { if (generation === lifetime.current) setError(reason.message) })
  }
  const later = (work: () => Promise<WebPanePendingSnapshot>) => {
    const generation = lifetime.current
    void work().then((next) => { if (generation === lifetime.current) apply(next) })
      .catch((reason: Error) => { if (generation === lifetime.current) setError(reason.message) })
  }
  /** Queues an answer to a canvas question note; a same-key answer replaces the unsent one. */
  const answer = (response: RedlinePageResponse) => {
    if (webPaneId && questionsPage) later(() => api.addPendingResponse(webPaneId, questionsPage, response))
  }
  const remove = (noteId: number) => { if (webPaneId) later(() => api.removePendingNote(webPaneId, noteId)) }
  return { snapshot, queued, threads, draft, active, busy, error, relay, sectionStatus, answer, remove,
    openDraft: (next: CanvasDraft) => { setDraft(next); setActive('draft'); setError('') },
    updateDraftComment: (comment: string) => setDraft((current) => current ? { ...current, comment } : current),
    open: setActive, close: () => { setActive(null); setDraft(null) }, queueDraft,
    reply: (threadId: string, text: string) => mutate(async () => {
      if (!webPaneId) return
      await api.replyThread(webPaneId, threadId, text)
      await refreshThreads()
    }),
    status: (threadId: string, status: 'open' | 'resolved') => mutate(async () => {
      if (!webPaneId) return
      await api.setThreadStatus(webPaneId, threadId, status)
      await refreshThreads()
    }),
    sendThis: (note: WebPanePendingNote) => mutate(() => send([note], snapshot)) }
}

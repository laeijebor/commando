import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef } from 'react'
import type { CanvasAnnotation } from '../shared/canvas-manifest'
import type { WebPanePendingSnapshot } from '../shared/protocol'
import type { RedlinePageQuestionSnapshot } from '../shared/redline-response'
import { openCanvasQuestions } from './canvasQuestions'
import type { PendingQueueApi } from './pendingQueueApi'
import type { TileReviewSurface } from './TileReviewLayer'
import type { useCanvasComments } from './useCanvasComments'
import { createWebPanesApi } from './webPanesApi'

/** Same canvas queue adapter: answers belong to the manifest, even while a different slide is shown. */
export function useSlidesReview(webPaneId: string | undefined, token: string, page: string, annotations: CanvasAnnotation[], comments: ReturnType<typeof useCanvasComments>, reveal: (selector: string) => void) {
  const questions = useMemo(() => openCanvasQuestions(annotations), [annotations])
  const state = useRef({ questions, page, sent: comments.questionSent })
  const listeners = useRef({ pending: new Set<(snapshot: WebPanePendingSnapshot) => void>(), questions: new Set<(page: string, snapshot: RedlinePageQuestionSnapshot) => void>() })
  useLayoutEffect(() => { state.current = { questions, page, sent: comments.questionSent } })
  const questionSnapshot = (): RedlinePageQuestionSnapshot => ({ type: 'questions', version: 1, questions: state.current.questions })
  useEffect(() => { for (const listener of listeners.current.questions) listener(page, questionSnapshot()) }, [questions, page])
  useEffect(() => {
    if (!comments.snapshot.revision && !comments.snapshot.notes.length) return
    for (const listener of listeners.current.pending) listener({ ...comments.snapshot, sent: comments.questionSent })
  }, [comments.snapshot, comments.questionSent])
  const onReveal = useEffectEvent(reveal)
  const surface = useMemo<TileReviewSurface>(() => ({
    inspect: () => {}, resolveSelectors: (_items, receive) => receive([]),
    subscribePending: (listener) => { listeners.current.pending.add(listener); return () => { listeners.current.pending.delete(listener) } },
    subscribeQuestions: (listener) => { listeners.current.questions.add(listener); listener(state.current.page, questionSnapshot()); return () => { listeners.current.questions.delete(listener) } },
    revealSelector: (selector) => onReveal(selector),
  }), [])
  const queue = useMemo<PendingQueueApi | null>(() => {
    if (!webPaneId) return null
    const api = createWebPanesApi(token)
    const ours = (work: Promise<WebPanePendingSnapshot>) => work.then((snapshot) => ({ ...snapshot, sent: state.current.sent }))
    return {
      list: () => api.pendingNotes(webPaneId, page),
      add: (note) => ours(api.addPendingNote(webPaneId, note)),
      addResponse: (pageUrl, response) => ours(api.addPendingResponse(webPaneId, pageUrl, response)),
      update: (id, revision, change) => ours(api.updatePendingNote(webPaneId, id, revision, change)),
      upload: (id, revision, file) => ours(api.uploadPendingAttachment(webPaneId, id, revision, file)),
      removeAttachment: (id, revision, attachment) => ours(api.removePendingAttachment(webPaneId, id, revision, attachment)),
      attachmentUrl: (id) => api.pendingAttachmentUrl(webPaneId, id),
      remove: (id) => ours(api.removePendingNote(webPaneId, id)),
      send: (targets, options) => ours(api.sendPendingNotes(webPaneId, targets, options)),
      dismissDropped: () => ours(api.dismissPendingDropped(webPaneId)),
    }
  }, [webPaneId, token, page])
  return { surface, queue }
}

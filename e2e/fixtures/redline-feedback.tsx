/** Browser QA harness: actual review UI/SDK boundaries with a deterministic
 * in-memory transport. No daemon, tmux, or user queue is touched. */
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { TileReviewLayer, type TileReviewSurface } from '../../src/TileReviewLayer'
import type { PendingQueueApi } from '../../src/pendingQueueApi'
import type { WebPanePendingNote, WebPanePendingSnapshot } from '../../shared/protocol'
import type { RedlinePageQuestionSnapshot, RedlinePageResponse } from '../../shared/redline-response'
import { questionShapeOf, redlinePageKey } from '../../shared/redline-response'
import { inspectPageAt, resolvePageSelectors, revealPageSelector } from '../../shared/tile-inspect'

const pageUrl = 'https://redline.test/document'
const initial: WebPanePendingSnapshot = { revision: 1, knownUpTo: 1, dropped: 0, notes: [{
  id: 1, revision: 1, pageUrl, selector: '#ordinary-evidence', tag: 'p', comment: 'Check the hierarchy',
  rect: { x: 0, y: 0, width: 0, height: 0 }, attachments: [],
}] }
let snapshot: WebPanePendingSnapshot = JSON.parse(localStorage.getItem('redline-feedback-e2e') || JSON.stringify(initial))
const pendingListeners = new Set<(snapshot: WebPanePendingSnapshot) => void>()
const questionListeners = new Set<(url: string, snapshot: RedlinePageQuestionSnapshot) => void>()
let questions: RedlinePageQuestionSnapshot = { type: 'questions', version: 1, questions: [] }
let frame: HTMLIFrameElement
const sentIntents: string[] = []

function sync() {
  localStorage.setItem('redline-feedback-e2e', JSON.stringify(snapshot))
  const win = frame?.contentWindow as any
  if (win) {
    const pending = { version: 1, controls: snapshot.notes.filter(note => note.response).map(note => ({ queueKey: note.queueKey, selector: note.selector, response: note.response })), sent: snapshot.sent?.answers || [] }
    win.__commandoRedlinePendingSnapshot = pending
    win.dispatchEvent(new win.CustomEvent('commando:redline-pending', { detail: pending }))
  }
  for (const listener of pendingListeners) listener(snapshot)
}
function changed() {
  snapshot = { ...snapshot, revision: (snapshot.revision || 0) + 1 }
  sync()
  return Promise.resolve(snapshot)
}
function addResponse(url: string, response: RedlinePageResponse) {
  const existing = snapshot.notes.find(note => response.queueKey ? note.queueKey === response.queueKey : note.selector === response.selector)
  const note: WebPanePendingNote = {
    id: existing?.id ?? ++snapshot.knownUpTo, revision: (existing?.revision || 0) + 1,
    pageUrl: url, queueKey: response.queueKey, selector: response.selector || '', tag: 'redline',
    comment: `${response.question}: ${response.answer}`, response, questionShape: response.shape,
    rect: response.rect || { x: 0, y: 0, width: 0, height: 0 }, attachments: existing?.attachments || [],
  }
  snapshot.notes = [...snapshot.notes.filter(item => item.id !== note.id), note]
  return changed()
}
const api: PendingQueueApi = {
  list: async () => snapshot,
  setPage: async () => snapshot,
  add: async note => {
    snapshot.notes.push({ ...note, id: ++snapshot.knownUpTo, revision: 1, pageUrl })
    return changed()
  },
  addResponse,
  update: async (id, revision, change) => {
    const note = snapshot.notes.find(item => item.id === id)!
    if (note.revision !== revision) throw new Error('Stale revision')
    note.revision = revision + 1
    if (change.response) { note.response = change.response; note.questionShape = change.response.shape }
    else if (note.response) note.response = { ...note.response, answer: change.answer ?? note.response.answer, note: change.note ?? note.response.note }
    else note.comment = change.answer ?? note.comment
    return changed()
  },
  upload: async (id, revision, file) => {
    const note = snapshot.notes.find(item => item.id === id)!
    if (note.revision !== revision) throw new Error('Stale revision')
    note.revision = revision + 1
    note.attachments = [...note.attachments || [], { id: 'image-1', name: file.name, contentType: file.type, size: file.size }]
    return changed()
  },
  removeAttachment: async (id, revision, attachmentId) => {
    const note = snapshot.notes.find(item => item.id === id)!
    note.revision = revision + 1
    note.attachments = note.attachments?.filter(item => item.id !== attachmentId)
    return changed()
  },
  attachmentUrl: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5VAAAAAASUVORK5CYII=',
  remove: async id => { snapshot.notes = snapshot.notes.filter(item => item.id !== id); return changed() },
  dismissDropped: async () => { snapshot.dropped = 0; return changed() },
  send: async (targets, options) => {
    sentIntents.push(options?.intent || 'send')
    const ids = targets?.map(target => typeof target === 'number' ? target : target.id)
    const sending = snapshot.notes.filter(note => !ids || ids.includes(note.id))
    snapshot.sent = { page: redlinePageKey(pageUrl), answers: [
      ...snapshot.sent?.answers || [],
      ...sending.filter(note => note.response).map(note => ({ queueKey: note.queueKey, selector: note.selector, shape: note.questionShape || questionShapeOf(questions.questions.find(question => question.queueKey === note.queueKey)!), response: note.response!, sentAt: Date.now() })),
    ] }
    snapshot.notes = snapshot.notes.filter(note => !sending.includes(note))
    return changed()
  },
}

const surface: TileReviewSurface = {
    inspect: (x, y, grade, receive) => receive(inspectPageAt(frame.contentDocument!, x, y, grade)),
    resolveSelectors: (items, receive) => receive(resolvePageSelectors(frame.contentDocument!, [...items])),
    subscribePending: listener => { pendingListeners.add(listener); listener(snapshot); return () => { pendingListeners.delete(listener) } },
    subscribeQuestions: listener => { questionListeners.add(listener); listener(pageUrl, questions); return () => { questionListeners.delete(listener) } },
    revealSelector: selector => { revealPageSelector(frame.contentDocument!, selector) },
  }

function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [review, setReview] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const input = inputRef.current
    if (!input || !frameRef.current) return
    const observer = new ResizeObserver(() => {
      // Mirrors the native and streamed renderer: reserve real reading space.
      const bounds = input.getBoundingClientRect()
      frameRef.current!.style.width = `${bounds.width}px`
      frameRef.current!.style.height = `${bounds.height}px`
    })
    observer.observe(input)
    return () => observer.disconnect()
  }, [])

  return <>
    <button id="review-toggle" onClick={() => setReview(value => !value)}>Review this page</button>
    <div ref={containerRef} className={`web-pane-native-slot${review ? ' is-reviewing' : ''}`} style={{ height: 'calc(100vh - 40px)' }}>
      <iframe ref={frameRef} src="/document" title="Reviewed document" onLoad={() => {
        frame = frameRef.current!
        const win = frame.contentWindow as any
        win.__commandoRedlineQueue = (payload: string) => {
          const envelope = JSON.parse(payload)
          if (envelope.type === 'questions') {
            questions = envelope
            for (const listener of questionListeners) listener(pageUrl, questions)
          } else void addResponse(pageUrl + win.location.hash, envelope)
        }
        questions = win.__commandoRedlineQuestionSnapshot
        sync()
        setReady(true)
      }} style={{ display: 'block', border: 0, width: '100%', height: '100%' }} />
      <div ref={inputRef} className="web-pane-native-review-input" />
      {ready && <TileReviewLayer webPaneId="w-redline-browser-qa" pageUrl={pageUrl}
        containerRef={containerRef} inputRef={inputRef} reviewMode={review} active={review}
        pendingQueue={api} surface={surface} />}
    </div>
  </>
}
;(window as any).feedbackFixture = { getSnapshot: () => snapshot, sentIntents }
createRoot(document.getElementById('root')!).render(<App />)

import { useEffect, useRef, useState } from 'react'
import { ASIDE_REPORT_PROMPT, asideKey, asideReportText, type AsideReport, type ChatAsideRecord, type ChatState } from '../../shared/agent-chat'
import type { ChatAsideServices, ChatThreadBindings } from './ChatPane'
import { Button } from './ui/button'
import { CHAT_SEND_REFUSAL_MS, type ChatSendError } from './ChatComposer'
import { useHost } from '../HostContext'
import { appendDraftText, loadDraft, loadReportSends, updateDraftReports, type PendingAsideReference } from './draftStore'

type Delivery = 'queue' | 'draft' | 'reference'
type Report = AsideReport & {
  delivery: Delivery
  close: boolean
  drafting: boolean
  error?: string
  before: Set<string>
  sessionId?: string
  requestId?: string
  waiting?: boolean
}
export type AsideReportDraft = { id: number; text: string; savedText: string }

/** Owned by the Main pane, not the mounted thread: drafting continues across tab switches. */
export function useAsideReports(asides: ChatAsideServices | undefined, chat: ChatState, sendError?: ChatSendError) {
  const { paneId, asides: records, items, session: { sessionId, queue } } = chat
  const [reports, setReports] = useState<Record<string, Report>>({})
  const [draft, setDraft] = useState<AsideReportDraft>()
  const { activeHost } = useHost()
  const draftId = sessionId && (activeHost === 'local' ? sessionId : `${activeHost}:${sessionId}`)
  const [saved, setSaved] = useState(() => ({ id: draftId, references: loadDraft(draftId).references ?? [] }))
  if (saved.id !== draftId) {
    setSaved({ id: draftId, references: loadDraft(draftId).references ?? [] })
    setReports({})
    setDraft(undefined)
  }
  const references = saved.id === draftId ? saved.references : loadDraft(draftId).references ?? []
  const saveReferences = (references: PendingAsideReference[]) => {
    updateDraftReports(draftId, { references })
    setSaved({ id: draftId, references })
  }
  const appendDraft = (text: string) => {
    const savedText = appendDraftText(draftId, text)
    const id = ++sequence.current
    setDraft((current) => ({ id, text: [current?.text, text].filter(Boolean).join('\n\n'), savedText }))
  }
  const sequence = useRef(0)
  useEffect(() => {
    // Report sends survive a pane remount; their text is recovered here once.
    for (const { requestId } of sendError?.refused ?? []) {
      const sends = loadReportSends(draftId)
      const report = sends.find((send) => send.requestId === requestId)
      if (!report || Date.now() - report.at > CHAT_SEND_REFUSAL_MS) continue
      updateDraftReports(draftId, { reportSends: sends.filter((send) => send.requestId !== requestId) })
      appendDraft(report.text)
    }
  }, [sendError, draftId])
  useEffect(() => {
    // The protocol has no send ack: a new queue entry or user message is its echo.
    const echoes = [...items.flatMap((item) => item.kind === 'user_message' && !item.parentToolUseId ? [{ id: item.id, text: item.text }] : []), ...(queue ?? [])]
    const sends = loadReportSends(draftId)
    const pending = sends.filter((send) => !echoes.some((item) => item.text === send.text && !send.before?.includes(item.id)))
    if (pending.length !== sends.length) updateDraftReports(draftId, { reportSends: pending })
  }, [draftId, items, queue])
  const update = (id: string, change: Partial<Report>) => setReports((current) => current[id] ? { ...current, [id]: { ...current[id]!, ...change } } : current)
  const cancel = (id: string) => setReports((current) => {
    const next = { ...current }
    delete next[id]
    return next
  })
  useEffect(() => {
    if (!asides) return
    for (const report of Object.values(reports)) {
      if (!report.drafting) continue
      const key = asideKey(paneId, report.asideId)
      const chat = asides.chats[key]
      const refused = asides.bindings(key).sendError
      const refusal = refused?.refused.some((entry) => entry.requestId === report.requestId)
      const record = records?.find((aside) => aside.id === report.asideId)
      if ((records && record?.status !== 'open') || (chat && (chat.session.status === 'closed' || chat.session.status === 'error' || chat.session.sessionId !== report.sessionId)) || refusal) {
        update(report.asideId, { drafting: false, error: refusal ? refused?.message : chat?.session.error || 'Drafting stopped or the aside closed. Write the report yourself.' })
        continue
      }
      if (!chat || chat.hostConnected === false) {
        if (!report.waiting) update(report.asideId, { waiting: true })
        continue
      }
      if (report.waiting) update(report.asideId, { waiting: false })
      const promptIndex = chat.items.findIndex((item) => !report.before.has(item.id) && !item.parentToolUseId && item.kind === 'user_message' && item.text === ASIDE_REPORT_PROMPT)
      const prompt = chat.items[promptIndex]
      const replies = prompt ? chat.items.slice(promptIndex + 1).filter((item) => item.kind === 'assistant_message' && !item.parentToolUseId && item.turnId === prompt.turnId && !report.before.has(item.id)) : []
      const reply = replies.at(-1)
      const failure = chat.items.find((item) => !report.before.has(item.id) && !item.parentToolUseId && item.kind === 'notice' && (item.level === 'error' || item.text === 'Interrupted'))
      if (chat.session.status === 'idle' && prompt) {
        if (!failure && reply?.kind === 'assistant_message' && reply.status === 'completed' && reply.text.trim()) update(report.asideId, { drafting: false, body: reply.text })
        else if (failure || (reply && reply.status !== 'running')) update(report.asideId, { drafting: false, error: failure?.kind === 'notice' ? failure.text : 'Drafting failed or was interrupted. Write the report yourself.' })
      } else if (chat.session.status === 'idle' && failure) {
        update(report.asideId, { drafting: false, error: failure?.kind === 'notice' ? failure.text : 'Drafting was interrupted. Write the report yourself.' })
      }
    }
  }, [asides, paneId, reports, records])
  const start = (aside: ChatAsideRecord) => {
    if (!asides || reports[aside.id]) return
    const key = asideKey(paneId, aside.id)
    const chat = asides.chats[key]
    if (!chat || chat.session.status !== 'idle') return
    let requestId: string | void = undefined
    let error: string | undefined
    try { requestId = asides.bindings(key).onSend(ASIDE_REPORT_PROMPT) }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    setReports((current) => ({ ...current, [aside.id]: {
      asideId: aside.id, title: chat.session.title || aside.title, body: '', delivery: 'queue', close: true,
      drafting: !error, error, before: new Set(chat.items.map((item) => item.id)), sessionId: chat.session.sessionId,
      ...(requestId ? { requestId } : {}),
    } }))
  }
  const rememberSend = (requestId: string | void, text: string) => {
    const sends = loadReportSends(draftId)
    const before = [...items.filter((item) => item.kind === 'user_message' && !item.parentToolUseId && item.text === text), ...(queue ?? []).filter((item) => item.text === text)].map((item) => item.id)
    if (requestId) updateDraftReports(draftId, { reportSends: [...sends, { requestId, text, at: Date.now(), before }] })
  }
  const deliver = (report: Report, onSend: ChatThreadBindings['onSend']) => {
    const text = asideReportText(report)
    if (report.delivery === 'queue') {
      const requestId = onSend(text, undefined, { delivery: 'queue' })
      rememberSend(requestId, text)
    }
    else if (report.delivery === 'draft') {
      appendDraft(text)
      asides?.select(undefined)
    } else {
      saveReferences([...references, { asideId: report.asideId, title: report.title, body: report.body, close: report.close }])
      asides?.select(undefined)
    }
    cancel(report.asideId)
  }
  return { reports, start, update, cancel, deliver, rememberSend, draft, consumeDraft: () => setDraft(undefined), references,
    removeReference: (index: number) => saveReferences(references.filter((_, i) => i !== index)),
    clearReferences: () => saveReferences([]) }
}

export function AsideReportSheet({ report, disabled, onChange, onCancel, onSend }: {
  report: Report
  disabled: boolean
  onChange: (change: Partial<Report>) => void
  onCancel: () => void
  onSend: () => void
}) {
  return <div className="chat-aside-report-sheet" role="region" aria-label="Report to Main">
    <header><strong>Report to Main</strong><span>Edit the aside’s report before sending</span></header>
    <div className="chat-aside-report-body">
      <div className="mb-2">From aside “{report.title}”</div>
      {report.error ? <div role="alert" className="mb-2 text-destructive">{report.error}</div> : null}
      {report.drafting ? <div className="flex items-center gap-2"><span role="status">{report.waiting ? 'Waiting for the aside to reconnect…' : 'Drafting…'}</span><Button size="xs" variant="ghost-muted" onClick={() => onChange({ drafting: false, body: '' })}>Write it myself</Button></div>
        : <><textarea autoFocus aria-label="Report text" value={report.body} onChange={(event) => onChange({ body: event.target.value })} />
          {report.error ? <Button size="xs" variant="ghost-muted" onClick={() => onChange({ error: undefined, body: '' })}>Write it myself</Button> : null}</>}
      <fieldset className="chat-aside-report-delivery"><legend className="sr-only">Delivery</legend>
        {([
          ['queue', 'Queue for Main after its current turn'],
          ['draft', "Put in Main's composer as a draft"],
          ['reference', 'Attach as reference (sent with your next Main message)'],
        ] as const).map(([value, label]) => <label key={value}><input type="radio" name={`report-delivery-${report.asideId}`} checked={report.delivery === value} onChange={() => onChange({ delivery: value })} />{label}</label>)}
      </fieldset>
    </div>
    <footer><label><input type="checkbox" checked={report.close} onChange={(event) => onChange({ close: event.target.checked })} />Close aside after sending</label>
      <Button size="xs" variant="ghost-muted" onClick={onCancel}>Cancel</Button>
      <Button size="xs" disabled={disabled || report.drafting || !report.body.trim()} onClick={onSend}>Send to Main</Button></footer>
  </div>
}

import { useEffect, useMemo, useState } from 'react'
import type { CanvasSpotlightRequest } from '../shared/protocol'
import { createWebPanesApi, subscribeCanvasSpotlights } from './webPanesApi'

export function CanvasSpotlightToast({ webPaneId, token, onShow }: {
  webPaneId?: string; token: string; onShow: (request: CanvasSpotlightRequest) => void
}) {
  const [request, setRequest] = useState<CanvasSpotlightRequest>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const api = useMemo(() => createWebPanesApi(token), [token])
  useEffect(() => subscribeCanvasSpotlights((requests) => setRequest(webPaneId ? requests[webPaneId] : undefined)), [webPaneId])
  useEffect(() => { setError(''); setBusy(false) }, [request?.id])
  if (!request || !webPaneId) return null
  const answer = async (decision: 'accept' | 'dismiss') => {
    setBusy(true); setError('')
    try {
      await api.answerSpotlight(webPaneId, request.id, decision)
      if (decision === 'accept') onShow(request)
      setRequest((current) => current?.id === request.id ? undefined : current)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="web-pane-navigate-request canvas-spotlight" role="alertdialog" aria-label="Agent spotlight">
    <p className="web-pane-navigate-request-lede"><strong>{request.requestedBy ?? 'An agent'}</strong> wants to show you <b>{request.label ?? request.labelId ?? request.frame}</b>{request.message && <> — {request.message}</>}</p>
    {error && <p role="alert">{error}</p>}
    <div className="web-pane-confirm-actions">
      <button type="button" className="web-pane-action" disabled={busy} onClick={() => { void answer('accept') }}>Show me</button>
      <button type="button" className="web-pane-action is-ghost" disabled={busy} onClick={() => { void answer('dismiss') }}>Dismiss</button>
    </div>
  </div>
}

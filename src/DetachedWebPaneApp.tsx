import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, PictureInPicture2 } from 'lucide-react'

import type { ServerMessage, WebPane, WebPaneFeedbackInfo } from '../shared/protocol'
import { getAuthBootstrap, getAuthUser } from './authClient'
import { getNativeWindowBridge } from './nativeWindowBridge'
import { SessionTokenBroker } from './sessionTokenBroker'
import { getInitialToken, storeToken } from './sessionTokenStorage'
import { useDaemon } from './useDaemon'
import { createWebPanesApi } from './webPanesApi'
import { WebPaneCard } from './WebPaneCard'

export function DetachedWebPaneApp({ webPaneId }: { webPaneId: string }) {
  const [token, setToken] = useState(getInitialToken)
  const [sessionAuthenticated, setSessionAuthenticated] = useState(false)
  const [authReady, setAuthReady] = useState(false)
  const [webPane, setWebPane] = useState<WebPane | null>(null)
  const [feedback, setFeedback] = useState<WebPaneFeedbackInfo | undefined>()
  const [receivedWebPanes, setReceivedWebPanes] = useState(false)
  const [actionError, setActionError] = useState('')
  const tokenBrokerRef = useRef<SessionTokenBroker | null>(null)
  const nativeWindowBridge = getNativeWindowBridge()

  useEffect(() => {
    const broker = new SessionTokenBroker()
    tokenBrokerRef.current = broker
    let active = true
    const accept = (sharedToken: string) => {
      if (!active || !sharedToken) return
      storeToken(sharedToken)
      broker.setToken(sharedToken)
      setToken(sharedToken)
    }
    const removeListener = broker.onToken(accept)
    if (token) broker.setToken(token)
    else void broker.requestToken().then(accept)
    return () => {
      active = false
      removeListener()
      broker.close()
      if (tokenBrokerRef.current === broker) tokenBrokerRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void getAuthBootstrap()
      .then(async (bootstrap) => bootstrap.enabled ? await getAuthUser() : null)
      .then((user) => {
        if (!cancelled) setSessionAuthenticated(user !== null)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAuthReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleServerMessage = (message: ServerMessage) => {
    if (message.type !== 'web_panes') return
    setReceivedWebPanes(true)
    setWebPane(message.webPanes.find((candidate) => candidate.id === webPaneId) ?? null)
    setFeedback(message.feedback?.[webPaneId])
  }
  const { connection } = useDaemon(token, sessionAuthenticated, handleServerMessage)
  const api = createWebPanesApi(token)

  useEffect(() => {
    if (!receivedWebPanes || webPane) return
    nativeWindowBridge?.reattach(webPaneId)
  }, [nativeWindowBridge, receivedWebPanes, webPane, webPaneId])

  const run = async (operation: () => Promise<void>, fallback: string) => {
    setActionError('')
    try {
      await operation()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : fallback)
    }
  }

  if (!webPane) {
    const missing = receivedWebPanes
    const unauthenticated = authReady && !token && !sessionAuthenticated
    return (
      <main className="detached-web-pane-state">
        {missing ? <PictureInPicture2 aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}
        <h1>{missing ? 'Web pane closed' : 'Opening web pane'}</h1>
        <p>
          {missing
            ? 'This window will close and the workspace will reclaim the pane.'
            : unauthenticated
              ? 'Waiting for the main Commando window to share its session.'
              : connection.detail}
        </p>
        {nativeWindowBridge && (
          <button
            type="button"
            className="web-pane-action is-ghost"
            onClick={() => nativeWindowBridge.reattach(webPaneId)}
          >
            Return to workspace
          </button>
        )}
      </main>
    )
  }

  return (
    <main className="detached-web-pane-app">
      <WebPaneCard
        webPane={webPane}
        wsToken={token}
        connected={connection.phase === 'live'}
        feedback={feedback}
        detachedWindow
        keepStreamingWhenHidden
        onReattach={nativeWindowBridge ? () => nativeWindowBridge.reattach(webPaneId) : undefined}
        onClose={() => void run(() => api.close(webPaneId), 'Unable to close web pane')}
        onConfirm={(allowOrigin) => void run(
          () => api.confirm(webPaneId, allowOrigin),
          'Unable to open web pane',
        )}
        onNavigate={(url) => void run(
          () => api.navigate(webPaneId, url),
          'Unable to change web pane URL',
        )}
        pendingQueue={{
          list: () => api.pendingNotes(webPaneId),
           add: (note) => api.addPendingNote(webPaneId, note),
          addResponse: (pageUrl, response) => api.addPendingResponse(webPaneId, pageUrl, response),
          update: (noteId, revision, change) => api.updatePendingNote(
            webPaneId,
            noteId,
            revision,
            change,
          ),
          upload: (noteId, revision, file) => api.uploadPendingAttachment(
            webPaneId,
            noteId,
            revision,
            file,
          ),
          removeAttachment: (noteId, revision, attachmentId) => api.removePendingAttachment(
            webPaneId,
            noteId,
            revision,
            attachmentId,
          ),
          attachmentUrl: (attachmentId) => api.pendingAttachmentUrl(webPaneId, attachmentId),
          remove: (noteId) => api.removePendingNote(webPaneId, noteId),
          send: (ids) => api.sendPendingNotes(webPaneId, ids),
          dismissDropped: () => api.dismissPendingDropped(webPaneId),
        }}
      />
      {actionError && <div className="detached-web-pane-error" role="alert">{actionError}</div>}
    </main>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WebPane, WebPanePendingSnapshot } from '../shared/protocol'
import { redlinePendingSnapshotForPage } from '../shared/redline-response'
import type { NativeWebViewAttachment, NativeWebViewBridge } from './nativeWebViewBridge'
import {
  clippingRect,
  computeNativeTerminalVisibleRegions,
  isVisibleElement,
} from './NativeTerminalPane'
import type { PendingQueueApi } from './pendingQueueApi'
import { TileReviewLayer, type TileReviewSurface } from './TileReviewLayer'
import { subscribeWebTilePending } from './webTilePendingSubscription'

const FRAME_PUBLISH_FALLBACK_MS = 100

/**
 * Desktop-shell tier of a web pane tile: reserves the tile's rectangle in the
 * DOM and drives a native WKWebView over it through the native web-view
 * bridge, publishing CSS-pixel frames + visible regions exactly like the
 * native terminal panes so overlays keep occluding correctly. Calls
 * onFallback when the native side fails, so the card can drop to the iframe.
 */
export function NativeWebViewTile({
  bridge,
  webPane,
  reloadKey,
  reviewMode = false,
  wsToken = '',
  pendingQueue,
  connected = true,
  onLoaded,
  onReviewFallback,
  onFallback,
}: {
  bridge: NativeWebViewBridge
  webPane: WebPane
  reloadKey: number
  reviewMode?: boolean
  wsToken?: string
  pendingQueue?: PendingQueueApi
  connected?: boolean
  onLoaded?: () => void
  onReviewFallback?: () => void
  onFallback: () => void
}) {
  const slotRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const attachmentIdRef = useRef<string | null>(null)
  const attachmentRef = useRef<NativeWebViewAttachment | null>(null)
  const pendingQueueRef = useRef(pendingQueue)
  const [attachment, setAttachment] = useState<NativeWebViewAttachment | null>(null)
  const [pageUrl, setPageUrl] = useState(webPane.url)
  const pageUrlRef = useRef(pageUrl)
  const latestPendingRevisionRef = useRef<number | undefined>(undefined)
  const loadedRef = useRef(onLoaded)
  const fallbackRef = useRef(onFallback)
  const reviewFallbackRef = useRef(onReviewFallback)
  const reviewModeRef = useRef(reviewMode)
  const reviewFallbackSentRef = useRef(false)
  loadedRef.current = onLoaded
  fallbackRef.current = onFallback
  reviewFallbackRef.current = onReviewFallback
  reviewModeRef.current = reviewMode
  pendingQueueRef.current = pendingQueue
  pageUrlRef.current = pageUrl
  const presentPendingSnapshot = useCallback((
    target: NativeWebViewAttachment,
    snapshot: WebPanePendingSnapshot,
    targetUrl: string,
  ) => {
    const latestRevision = latestPendingRevisionRef.current
    if (
      snapshot.revision !== undefined &&
      latestRevision !== undefined &&
      snapshot.revision < latestRevision
    ) return
    if (snapshot.revision !== undefined) latestPendingRevisionRef.current = snapshot.revision
    target.presentPendingSnapshot(targetUrl, redlinePendingSnapshotForPage(snapshot, targetUrl))
  }, [])
  const requestReviewFallback = useCallback(() => {
    if (reviewFallbackSentRef.current) return
    reviewFallbackSentRef.current = true
    reviewFallbackRef.current?.()
  }, [])

  useEffect(() => {
    let active = true
    let attachment
    setPageUrl(webPane.url)
    try {
      attachment = bridge.attach(webPane.id, webPane.url, (event) => {
        if (!active) return
        if (event.type === 'webview.loaded') {
          if (event.url) setPageUrl(event.url)
          loadedRef.current?.()
        }
        if (event.type === 'webview.pageResponse') {
          const queue = pendingQueueRef.current
          if (!queue?.addResponse) return
          void queue.addResponse(event.url, event.response).then((snapshot) => {
            const current = attachmentRef.current
            if (current?.supportsPageResponses) {
              presentPendingSnapshot(current, snapshot, pageUrlRef.current)
            }
          }).catch(() => undefined)
        }
        if (event.type === 'webview.failed') fallbackRef.current()
      }, { pageResponses: typeof pendingQueueRef.current?.addResponse === 'function' })
    } catch {
      fallbackRef.current()
      return
    }
    attachmentIdRef.current = attachment.attachmentId
    attachmentRef.current = attachment
    setAttachment(attachment)
    return () => {
      active = false
      if (attachmentIdRef.current === attachment.attachmentId) attachmentIdRef.current = null
      if (attachmentRef.current === attachment) attachmentRef.current = null
      setAttachment((current) => current === attachment ? null : current)
      attachment.detach()
    }
  }, [bridge, presentPendingSnapshot, webPane.id, webPane.url])

  useEffect(() => {
    latestPendingRevisionRef.current = undefined
  }, [webPane.id])

  useEffect(() => {
    if (!attachment?.supportsPageResponses) return
    let cancelled = false
    void pendingQueueRef.current?.list().then((snapshot) => {
      if (!cancelled) {
        presentPendingSnapshot(attachment, snapshot, pageUrl)
      }
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [attachment, pageUrl, presentPendingSnapshot])

  useEffect(() => {
    const attachmentId = attachmentIdRef.current
    if (reloadKey > 0 && attachmentId) bridge.reload(attachmentId)
  }, [bridge, reloadKey])

  useEffect(() => {
    if (!attachment) return
    if (!reviewMode) {
      reviewFallbackSentRef.current = false
      attachment.presentReviewHighlights([])
      attachment.setReviewInput(false)
      return
    }
    if (!attachment.supportsReview || !attachment.setReviewInput(true)) {
      requestReviewFallback()
      return
    }
    return () => {
      attachment.presentReviewHighlights([])
      attachment.setReviewInput(false)
    }
  }, [attachment, requestReviewFallback, reviewMode])

  const reviewSurface = useMemo<TileReviewSurface>(() => ({
    inspect: (x, y, grade, receive) => {
      if (!attachment) {
        receive({ ok: false, error: 'Native review surface is unavailable' })
        return
      }
      void attachment.inspectAtPoint(x, y, grade).then(receive, (error: unknown) => {
        receive({
          ok: false,
          error: error instanceof Error ? error.message : 'Native inspection failed',
        })
      })
    },
    resolveSelectors: (items, receive, reject) => {
      if (!attachment) {
        reject?.(new Error('Native review surface is unavailable'))
        return
      }
      void attachment.resolveSelectors(items).then(receive, reject)
    },
    subscribePending: (listener) => connected
      ? subscribeWebTilePending(webPane.id, wsToken, (snapshot) => {
          if (attachment?.supportsPageResponses) {
            presentPendingSnapshot(attachment, snapshot, pageUrlRef.current)
          }
          listener(snapshot)
        })
      : () => undefined,
    presentHighlights: ({ hover, queued }) => {
      if (!attachment) return
      const ok = attachment.presentReviewHighlights([
        ...(hover ? [{ rect: hover, kind: 'hover' as const }] : []),
        ...queued,
      ])
      if (!ok && attachment.supportsReview && reviewModeRef.current) requestReviewFallback()
    },
  }), [attachment, connected, presentPendingSnapshot, requestReviewFallback, webPane.id, wsToken])

  useEffect(() => {
    const slot = slotRef.current
    if (!slot || typeof ResizeObserver === 'undefined') return

    let frame: number | null = null
    let fallbackTimer: number | null = null
    let fingerprint = ''
    const publish = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = null
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
      fallbackTimer = null
      const attachmentId = attachmentIdRef.current
      if (!attachmentId) return
      const bounds = slot.getBoundingClientRect()
      const clip = clippingRect(slot)
      const occluders = [...document.querySelectorAll('[data-native-terminal-occluder]')]
        .filter(isVisibleElement)
        .map((element) => element.getBoundingClientRect())
      const visibleRegions = isVisibleElement(slot)
        ? computeNativeTerminalVisibleRegions(bounds, clip, occluders)
        : []
      const payload = {
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
        scale: Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
          ? window.devicePixelRatio
          : 1,
        visible: visibleRegions.length > 0,
        visibleRegions,
        resizeOwner: false,
        order: 0,
      }
      const nextFingerprint = JSON.stringify(payload)
      if (nextFingerprint === fingerprint) return
      fingerprint = nextFingerprint
      if (!bridge.frame(attachmentId, payload)) fallbackRef.current()
    }
    const schedule = () => {
      if (frame !== null || fallbackTimer !== null) return
      frame = window.requestAnimationFrame(publish)
      fallbackTimer = window.setTimeout(publish, FRAME_PUBLISH_FALLBACK_MS)
    }
    const resizeObserver = new ResizeObserver(schedule)
    for (let element: HTMLElement | null = slot; element; element = element.parentElement) {
      resizeObserver.observe(element)
    }
    const mutationObserver = new MutationObserver(schedule)
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'data-native-terminal-occluder'],
      childList: true,
      subtree: true,
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
    }
  }, [bridge])

  return (
    <div
      ref={slotRef}
      className={`web-pane-native-slot${reviewMode ? ' is-reviewing' : ''}`}
      data-web-pane-native={webPane.id}
    >
      <div ref={inputRef} className="web-pane-native-review-input" />
      {pendingQueue && attachment && (
        <TileReviewLayer
          webPaneId={webPane.id}
          pageUrl={pageUrl}
          reviewMode={reviewMode}
          active={reviewMode && attachment?.supportsReview === true}
          containerRef={slotRef}
          inputRef={inputRef}
          pendingQueue={pendingQueue}
          surface={reviewSurface}
        />
      )}
    </div>
  )
}

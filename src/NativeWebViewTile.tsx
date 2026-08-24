import { useEffect, useRef } from 'react'
import type { WebPane } from '../shared/protocol'
import type { NativeWebViewBridge } from './nativeWebViewBridge'
import {
  clippingRect,
  computeNativeTerminalVisibleRegions,
  isVisibleElement,
} from './NativeTerminalPane'

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
  onLoaded,
  onFallback,
}: {
  bridge: NativeWebViewBridge
  webPane: WebPane
  reloadKey: number
  onLoaded?: () => void
  onFallback: () => void
}) {
  const slotRef = useRef<HTMLDivElement>(null)
  const attachmentIdRef = useRef<string | null>(null)
  const loadedRef = useRef(onLoaded)
  const fallbackRef = useRef(onFallback)
  loadedRef.current = onLoaded
  fallbackRef.current = onFallback

  useEffect(() => {
    let active = true
    let attachment
    try {
      attachment = bridge.attach(webPane.id, webPane.url, (event) => {
        if (!active) return
        if (event.type === 'webview.loaded') loadedRef.current?.()
        if (event.type === 'webview.failed') fallbackRef.current()
      })
    } catch {
      fallbackRef.current()
      return
    }
    attachmentIdRef.current = attachment.attachmentId
    return () => {
      active = false
      if (attachmentIdRef.current === attachment.attachmentId) attachmentIdRef.current = null
      attachment.detach()
    }
  }, [bridge, webPane.id, webPane.url])

  useEffect(() => {
    const attachmentId = attachmentIdRef.current
    if (reloadKey > 0 && attachmentId) bridge.reload(attachmentId)
  }, [bridge, reloadKey])

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

  return <div ref={slotRef} className="web-pane-native-slot" data-web-pane-native={webPane.id} />
}

import { type FocusEvent, useEffect, useRef, useState } from 'react'

import type { PaneTerminalSink } from './paneStream'
import {
  encodeBase64Bytes,
  NATIVE_TERMINAL_KEY_SHORTCUTS,
  NATIVE_TERMINAL_FRAME_LIMITS,
  type NativeTerminalAttachmentEvent,
  type NativeTerminalBridge,
  type NativeTerminalVisibleRegion,
} from './nativeTerminalBridge'

type NativeTerminalPaneProps = {
  bridge: NativeTerminalBridge
  paneId: string
  connected: boolean
  resizeOwner: boolean
  measurementKey?: string
  order: number
  ariaLabel: string
  onFocus: () => void
  onInputBytes: (data: string) => void
  onPaste: (data: string) => void
  onSelectionCopied: () => void
  onOpenMenu: (x: number, y: number) => void
  onResize: (cols: number, rows: number) => void
  onFailure: () => void
  registerSink: (paneId: string, sink: PaneTerminalSink) => () => void
  registerFocusable: (paneId: string, node: HTMLElement | null) => void
}

const SEED_TIMEOUT_MS = 1_500
const FRAME_PUBLISH_FALLBACK_MS = 100
export const MAX_NATIVE_TERMINAL_VISIBLE_REGIONS = NATIVE_TERMINAL_FRAME_LIMITS.maxVisibleRegions
let attachmentSequence = 0

function nextAttachmentId(pageId: string): string {
  attachmentSequence += 1
  return `${pageId}:${attachmentSequence}`
}

export function isVisibleElement(element: Element): boolean {
  if (!(element instanceof HTMLElement) || element.hidden || !element.isConnected) return false
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  if (
    style.opacity === '0' &&
    !element.hasAttribute('data-native-terminal-occluder') &&
    !element.hasAttribute('data-native-terminal-hit-blocker')
  ) return false
  const bounds = element.getBoundingClientRect()
  return bounds.width > 0 && bounds.height > 0
}

export type RectEdges = Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>

function rectanglesIntersect(left: RectEdges, right: RectEdges): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
}

function intersectRect(left: RectEdges, right: RectEdges): RectEdges | null {
  const intersection = {
    left: Math.max(left.left, right.left),
    top: Math.max(left.top, right.top),
    right: Math.min(left.right, right.right),
    bottom: Math.min(left.bottom, right.bottom),
  }
  return intersection.left < intersection.right && intersection.top < intersection.bottom
    ? intersection
    : null
}

function subtractRect(source: RectEdges, occluder: RectEdges): RectEdges[] {
  const overlap = intersectRect(source, occluder)
  if (!overlap) return [source]

  return [
    { left: source.left, top: source.top, right: source.right, bottom: overlap.top },
    { left: source.left, top: overlap.bottom, right: source.right, bottom: source.bottom },
    { left: source.left, top: overlap.top, right: overlap.left, bottom: overlap.bottom },
    { left: overlap.right, top: overlap.top, right: source.right, bottom: overlap.bottom },
  ].filter((region) => region.left < region.right && region.top < region.bottom)
}

function regionPayload(region: RectEdges): NativeTerminalVisibleRegion {
  return {
    x: region.left,
    y: region.top,
    width: region.right - region.left,
    height: region.bottom - region.top,
  }
}

export function computeNativeTerminalVisibleRegions(
  bounds: RectEdges,
  clip: RectEdges,
  occluders: readonly RectEdges[],
  maximumCount = MAX_NATIVE_TERMINAL_VISIBLE_REGIONS,
): NativeTerminalVisibleRegion[] {
  if (maximumCount < 1) return []
  const scale = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1
  const tolerance = 1 / scale
  const base = intersectRect(bounds, {
    left: clip.left - tolerance,
    top: clip.top - tolerance,
    right: clip.right + tolerance,
    bottom: clip.bottom + tolerance,
  })
  if (!base) return []

  let regions = [base]
  for (const occluder of occluders) {
    if (!rectanglesIntersect(bounds, occluder)) continue
    regions = regions.flatMap((region) => subtractRect(region, occluder)).slice(0, maximumCount)
    if (regions.length === 0) break
  }
  return regions.map(regionPayload)
}

function clipsAxis(value: string): boolean {
  return value === 'auto' || value === 'clip' || value === 'hidden' || value === 'scroll' || value === 'overlay'
}

export function clippingRect(element: HTMLElement): RectEdges {
  let clip: RectEdges = {
    left: 0,
    top: 0,
    right: Math.max(0, window.innerWidth),
    bottom: Math.max(0, window.innerHeight),
  }
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor)
    const clipX = clipsAxis(style.overflowX || style.overflow)
    const clipY = clipsAxis(style.overflowY || style.overflow)
    if (!clipX && !clipY) continue
    const bounds = ancestor.getBoundingClientRect()
    const contentLeft = bounds.left + ancestor.clientLeft
    const contentTop = bounds.top + ancestor.clientTop
    if (clipX) {
      clip = {
        ...clip,
        left: Math.max(clip.left, contentLeft),
        right: Math.min(clip.right, contentLeft + ancestor.clientWidth),
      }
    }
    if (clipY) {
      clip = {
        ...clip,
        top: Math.max(clip.top, contentTop),
        bottom: Math.min(clip.bottom, contentTop + ancestor.clientHeight),
      }
    }
  }
  return clip
}

export function NativeTerminalPane({
  bridge,
  paneId,
  connected,
  resizeOwner,
  measurementKey = '',
  order,
  ariaLabel,
  onFocus,
  onInputBytes,
  onPaste,
  onSelectionCopied,
  onOpenMenu,
  onResize,
  onFailure,
  registerSink,
  registerFocusable,
}: NativeTerminalPaneProps) {
  const [nativeReadable, setNativeReadable] = useState(false)
  const placeholderRef = useRef<HTMLDivElement>(null)
  const attachmentIdRef = useRef<string | null>(null)
  const connectedRef = useRef(connected)
  const focusRef = useRef(onFocus)
  const inputBytesRef = useRef(onInputBytes)
  const pasteRef = useRef(onPaste)
  const selectionCopiedRef = useRef(onSelectionCopied)
  const openMenuRef = useRef(onOpenMenu)
  const resizeRef = useRef(onResize)
  const ariaLabelRef = useRef(ariaLabel)
  const attachedMetadataRef = useRef({ ariaLabel, accessibilityEnabled: connected })
  const failureRef = useRef(onFailure)
  const activeFailureRef = useRef<() => void>(() => {})
  connectedRef.current = connected
  focusRef.current = onFocus
  inputBytesRef.current = onInputBytes
  pasteRef.current = onPaste
  selectionCopiedRef.current = onSelectionCopied
  openMenuRef.current = onOpenMenu
  resizeRef.current = onResize
  ariaLabelRef.current = ariaLabel
  failureRef.current = onFailure

  useEffect(() => {
    registerFocusable(paneId, placeholderRef.current)
    return () => registerFocusable(paneId, null)
  }, [paneId, registerFocusable])

  useEffect(() => {
    const attachmentId = nextAttachmentId(bridge.pageId)
    const placeholder = placeholderRef.current
    let active = true
    let failed = false
    let seedRevision: number | null = null
    let seedTimer: number | undefined

    setNativeReadable(false)

    attachmentIdRef.current = attachmentId
    attachedMetadataRef.current = {
      ariaLabel: ariaLabelRef.current,
      accessibilityEnabled: connectedRef.current,
    }
    if (placeholder) placeholder.dataset.nativeTerminalAttachmentId = attachmentId

    const fail = () => {
      if (!active || failed) return
      failed = true
      failureRef.current()
    }
    activeFailureRef.current = fail
    const receive = (event: NativeTerminalAttachmentEvent) => {
      if (!active) return
      switch (event.type) {
        case 'pane.seeded':
          if (event.payload.revision !== seedRevision) return
          if (seedTimer !== undefined) window.clearTimeout(seedTimer)
          seedTimer = undefined
          seedRevision = null
          setNativeReadable(true)
          break
        case 'pane.input_bytes':
          if (connectedRef.current) inputBytesRef.current(event.payload.data)
          break
        case 'pane.paste_text':
          if (connectedRef.current) pasteRef.current(event.payload.data)
          break
        case 'pane.resize':
          resizeRef.current(event.payload.cols, event.payload.rows)
          break
        case 'pane.focus_changed':
          if (event.payload.focused) focusRef.current()
          break
        case 'pane.selection_copied':
          selectionCopiedRef.current()
          break
        case 'pane.context_menu':
          openMenuRef.current(event.payload.x, event.payload.y)
          break
        case 'pane.detached':
        case 'pane.failed':
          fail()
          break
        case 'pane.attached':
          break
      }
    }

    let attachment
    try {
      attachment = bridge.attach(paneId, attachmentId, {
        ...attachedMetadataRef.current,
        keyShortcuts: [...NATIVE_TERMINAL_KEY_SHORTCUTS],
      }, receive)
    } catch {
      fail()
      return () => {
        active = false
        if (activeFailureRef.current === fail) activeFailureRef.current = () => {}
        if (attachmentIdRef.current === attachmentId) attachmentIdRef.current = null
      }
    }

    const sink: PaneTerminalSink = {
      reset: (message) => {
        if (!active || failed) return
        seedRevision = message.revision
        if (seedTimer !== undefined) window.clearTimeout(seedTimer)
        const posted = bridge.reset(attachmentId, {
          data: encodeBase64Bytes(message.data),
          cols: message.cols,
          rows: message.rows,
          revision: message.revision,
        })
        if (!posted) {
          fail()
          return
        }
        seedTimer = window.setTimeout(fail, SEED_TIMEOUT_MS)
      },
      write: (data, revision) => {
        if (!active || failed || !bridge.data(attachmentId, encodeBase64Bytes(data), revision)) fail()
      },
    }
    const unregisterSink = registerSink(paneId, sink)
    void attachment.ready.catch(() => fail())

    return () => {
      active = false
      if (activeFailureRef.current === fail) activeFailureRef.current = () => {}
      if (seedTimer !== undefined) window.clearTimeout(seedTimer)
      unregisterSink()
      attachment.detach()
      if (attachmentIdRef.current === attachmentId) attachmentIdRef.current = null
      if (placeholder?.dataset.nativeTerminalAttachmentId === attachmentId) {
        delete placeholder.dataset.nativeTerminalAttachmentId
      }
    }
  }, [bridge, paneId, registerSink])

  useEffect(() => {
    const attachmentId = attachmentIdRef.current
    const metadata = { ariaLabel, accessibilityEnabled: connected }
    if (
      !attachmentId ||
      (attachedMetadataRef.current.ariaLabel === metadata.ariaLabel &&
        attachedMetadataRef.current.accessibilityEnabled === metadata.accessibilityEnabled)
    ) return
    attachedMetadataRef.current = metadata
    if (!bridge.updateMetadata(attachmentId, {
      ...metadata,
      keyShortcuts: [...NATIVE_TERMINAL_KEY_SHORTCUTS],
    })) activeFailureRef.current()
  }, [ariaLabel, bridge, connected])

  useEffect(() => {
    const placeholder = placeholderRef.current
    if (!placeholder || typeof ResizeObserver === 'undefined') return

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
      const bounds = placeholder.getBoundingClientRect()
      const clip = clippingRect(placeholder)
      const occluders = [...document.querySelectorAll('[data-native-terminal-occluder]')]
        .filter(isVisibleElement)
        .map((element) => element.getBoundingClientRect())
      const hitBlockers = [...document.querySelectorAll('[data-native-terminal-hit-blocker]')]
        .filter(isVisibleElement)
        .map((element) => element.getBoundingClientRect())
      const placeholderVisible = isVisibleElement(placeholder)
      const visibleRegions = placeholderVisible
        ? computeNativeTerminalVisibleRegions(bounds, clip, occluders)
        : []
      const hitRegions = placeholderVisible && hitBlockers.length > 0
        ? computeNativeTerminalVisibleRegions(bounds, clip, [...occluders, ...hitBlockers])
        : visibleRegions
      const payload = {
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
        scale: Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
        visible: visibleRegions.length > 0,
        visibleRegions,
        hitRegions,
        resizeOwner,
        order,
      }
      const nextFingerprint = JSON.stringify(payload)
      if (nextFingerprint === fingerprint) return
      fingerprint = nextFingerprint
      if (!bridge.frame(attachmentId, payload)) activeFailureRef.current()
    }
    const schedule = () => {
      if (frame !== null || fallbackTimer !== null) return
      frame = window.requestAnimationFrame(publish)
      fallbackTimer = window.setTimeout(publish, FRAME_PUBLISH_FALLBACK_MS)
    }
    const resizeObserver = new ResizeObserver(schedule)
    for (let element: HTMLElement | null = placeholder; element; element = element.parentElement) {
      resizeObserver.observe(element)
    }
    const mutationObserver = new MutationObserver(schedule)
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'data-native-terminal-occluder', 'data-native-terminal-hit-blocker'],
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
  }, [bridge, measurementKey, order, resizeOwner])

  const handleFocus = (_event: FocusEvent<HTMLDivElement>) => {
    focusRef.current()
    const attachmentId = attachmentIdRef.current
    if (attachmentId && !bridge.focus(attachmentId)) activeFailureRef.current()
  }

  const hideProxy = connected && nativeReadable

  return (
    <div
      ref={placeholderRef}
      className="terminal-source-grid native-terminal-placeholder"
      role={hideProxy ? undefined : 'application'}
      tabIndex={hideProxy ? -1 : 0}
      aria-hidden={hideProxy ? 'true' : undefined}
      aria-label={hideProxy ? undefined : ariaLabel}
      aria-disabled={hideProxy ? undefined : !connected}
      aria-keyshortcuts={hideProxy ? undefined : NATIVE_TERMINAL_KEY_SHORTCUTS.join(' ')}
      data-native-terminal-pane={paneId}
      onFocus={handleFocus}
    />
  )
}

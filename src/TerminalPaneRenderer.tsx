import { useCallback, useEffect, useRef, useState } from 'react'

import { NativeTerminalPane } from './NativeTerminalPane'
import { getNativeTerminalBridge, type NativeTerminalBridge } from './nativeTerminalBridge'
import type { PaneTerminalSink } from './paneStream'
import { XtermPane, type XtermPaneProps } from './XtermPane'

export const PANE_RESET_RETRY_MS = 2_100
export const PANE_RESET_MAX_REQUESTS = 5

type ResetWatchdog = {
  active: boolean
  seeded: boolean
  requests: number
  timer: number | null
}

type TerminalPaneRendererProps = XtermPaneProps & {
  order: number
  useXtermFallback?: boolean
  onInputBytes: (data: string) => void
  onOpenMenu: (x: number, y: number) => void
  onRequestReset: () => void
}

export function TerminalPaneRenderer({
  order,
  useXtermFallback = false,
  onInputBytes,
  onOpenMenu,
  onRequestReset,
  ...xtermProps
}: TerminalPaneRendererProps) {
  const bridge = getNativeTerminalBridge()
  const [nativeBridge, setNativeBridge] = useState<NativeTerminalBridge | null>(null)
  const connectedRef = useRef(xtermProps.connected)
  const requestResetRef = useRef(onRequestReset)
  const registerSinkRef = useRef(xtermProps.registerSink)
  const activeWatchdogRef = useRef<ResetWatchdog | null>(null)
  const previousConnectedRef = useRef(xtermProps.connected)
  const scheduleResetRef = useRef<(watchdog: ResetWatchdog) => void>(() => {})
  const deferResetRef = useRef<(watchdog: ResetWatchdog) => void>(() => {})
  connectedRef.current = xtermProps.connected
  requestResetRef.current = onRequestReset
  registerSinkRef.current = xtermProps.registerSink

  scheduleResetRef.current = (watchdog) => {
    if (
      !watchdog.active ||
      watchdog.seeded ||
      !connectedRef.current ||
      watchdog.requests >= PANE_RESET_MAX_REQUESTS
    ) return
    watchdog.requests += 1
    requestResetRef.current()
    if (
      !watchdog.active ||
      watchdog.seeded ||
      !connectedRef.current ||
      watchdog.requests >= PANE_RESET_MAX_REQUESTS
    ) return
    watchdog.timer = window.setTimeout(
      () => {
        watchdog.timer = null
        scheduleResetRef.current(watchdog)
      },
      PANE_RESET_RETRY_MS,
    )
  }

  deferResetRef.current = (watchdog) => {
    if (!watchdog.active || watchdog.seeded || !connectedRef.current) return
    watchdog.timer = window.setTimeout(() => {
      watchdog.timer = null
      scheduleResetRef.current(watchdog)
    }, 0)
  }

  const registerRendererSink = useCallback((paneId: string, sink: PaneTerminalSink) => {
    const previous = activeWatchdogRef.current
    if (previous) {
      previous.active = false
      if (previous.timer !== null) window.clearTimeout(previous.timer)
    }

    const watchdog: ResetWatchdog = {
      active: true,
      seeded: false,
      requests: 0,
      timer: null,
    }
    activeWatchdogRef.current = watchdog
    const unregister = registerSinkRef.current(paneId, {
      reset: (message) => {
        watchdog.seeded = true
        if (watchdog.timer !== null) window.clearTimeout(watchdog.timer)
        watchdog.timer = null
        sink.reset(message)
      },
      write: sink.write,
    })
    deferResetRef.current(watchdog)

    return () => {
      watchdog.active = false
      if (watchdog.timer !== null) window.clearTimeout(watchdog.timer)
      watchdog.timer = null
      if (activeWatchdogRef.current === watchdog) activeWatchdogRef.current = null
      unregister()
    }
  }, [])

  useEffect(() => {
    let active = true
    if (!bridge) {
      setNativeBridge(null)
      return
    }
    void bridge.connect().then((result) => {
      if (active) setNativeBridge(result.available ? bridge : null)
    })
    return () => {
      active = false
    }
  }, [bridge])

  useEffect(() => {
    const wasConnected = previousConnectedRef.current
    previousConnectedRef.current = xtermProps.connected
    if (wasConnected === xtermProps.connected) return

    const watchdog = activeWatchdogRef.current
    if (!watchdog) return
    if (watchdog.timer !== null) window.clearTimeout(watchdog.timer)
    watchdog.timer = null
    watchdog.seeded = false
    watchdog.requests = 0
    if (xtermProps.connected) deferResetRef.current(watchdog)
  }, [xtermProps.connected])

  if (useXtermFallback || !nativeBridge) {
    return <XtermPane {...xtermProps} registerSink={registerRendererSink} />
  }

  return (
    <NativeTerminalPane
      bridge={nativeBridge}
      paneId={xtermProps.paneId}
      connected={xtermProps.connected}
      resizeOwner={xtermProps.resizeOwner}
      order={order}
      ariaLabel={xtermProps.ariaLabel}
      onFocus={xtermProps.onFocus}
      onInputBytes={onInputBytes}
      onPaste={xtermProps.onPaste}
      onSelectionCopied={xtermProps.onSelectionCopied}
      onOpenMenu={onOpenMenu}
      onResize={xtermProps.onResize}
      onFailure={() => setNativeBridge(null)}
      registerSink={registerRendererSink}
      registerFocusable={xtermProps.registerFocusable}
    />
  )
}

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'

import type { DaemonClient, PaneStreamMessage } from '../daemon/client'
import type { ConnectionPhase } from '../daemon/state'
import {
  fitDimensions,
  metricsFromEvent,
  resetCommand,
  writeCommand,
  type TerminalEvent,
  type TerminalMetrics,
} from './bridge'
import type { TerminalSurfaceHandle } from './TerminalSurface'

export type PaneTerminalOptions = {
  client: DaemonClient | undefined
  paneId: string | undefined
  /** False while the screen is blurred: the pane is unsubscribed and released. */
  focused: boolean
  fit: boolean
  fontSize: number
  phase: ConnectionPhase
  surface: RefObject<TerminalSurfaceHandle | null>
}

export type PaneTerminalState = {
  /** The pane's own grid, as the last `pane_reset` reported it. */
  source: { cols: number; rows: number } | null
  /** The grid "Fit to phone" would ask for, once the page has measured itself. */
  fitted: { cols: number; rows: number } | null
  seeded: boolean
  atBottom: boolean
  copied: boolean
  onEvent: (event: TerminalEvent) => void
  onNeedsReseed: () => void
  scrollToBottom: () => void
}

/**
 * Wires one pane's stream to the WebView: subscribe on focus, forward
 * `pane_reset` / `pane_data` down, take and release the resize lease for "Fit
 * to phone", and lift selection, measurements and scroll state back out.
 */
export function usePaneTerminal({
  client,
  paneId,
  focused,
  fit,
  fontSize,
  phase,
  surface,
}: PaneTerminalOptions): PaneTerminalState {
  const [source, setSource] = useState<{ cols: number; rows: number } | null>(null)
  const [metrics, setMetrics] = useState<TerminalMetrics | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [seeded, setSeeded] = useState(false)
  const [copied, setCopied] = useState(false)
  const sentFit = useRef<string | null>(null)

  useEffect(() => {
    if (!client || !paneId || !focused) return
    setSeeded(false)
    const handler = (message: PaneStreamMessage): void => {
      const handle = surface.current
      if (!handle) return
      if (message.type === 'pane_reset') {
        setSource({ cols: message.cols, rows: message.rows })
        handle.send(resetCommand(message))
        handle.send({ type: 'options', fontSize })
        return
      }
      handle.send(writeCommand(message))
    }
    // The disposer re-subscribes with the remaining panes and drops any resize
    // lease this screen was holding, which is what blur and unmount need.
    return client.subscribePane(paneId, handler)
    // `fontSize` is read inside the handler but must not re-subscribe: a
    // resubscribe costs a full reseed. Its own effect pushes changes down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, paneId, focused, surface])

  useEffect(() => {
    surface.current?.send({ type: 'options', fontSize })
  }, [fontSize, surface])

  // A socket that went away took its leases with it, so the next fit has to be
  // sent again even if the measurements did not change.
  useEffect(() => {
    if (phase !== 'live') sentFit.current = null
  }, [phase])

  const fitted = fit ? fitDimensions(metrics) : null

  useEffect(() => {
    if (!client || !paneId || !focused) return
    if (!fit) {
      client.releaseResize(paneId)
      sentFit.current = null
      if (source) surface.current?.send({ type: 'resize', cols: source.cols, rows: source.rows })
      return
    }
    if (!fitted || phase !== 'live') return
    const key = `${fitted.cols}x${fitted.rows}`
    if (sentFit.current === key) return
    sentFit.current = key
    client.resizePane(paneId, fitted.cols, fitted.rows)
  }, [client, paneId, focused, fit, fitted?.cols, fitted?.rows, phase, source, surface])

  useEffect(() => () => {
    if (client && paneId) client.releaseResize(paneId)
  }, [client, paneId])

  const onEvent = useCallback((event: TerminalEvent) => {
    switch (event.type) {
      case 'cells':
        setMetrics(metricsFromEvent(event))
        return
      case 'selection':
        void Clipboard.setStringAsync(event.text).then(() => {
          setCopied(true)
          void Haptics.selectionAsync()
          setTimeout(() => setCopied(false), 1_400)
        })
        return
      case 'scroll':
        setAtBottom(event.atBottom)
        return
      case 'seeded':
        setSeeded(true)
        setAtBottom(true)
        return
      default:
        return
    }
  }, [])

  const onNeedsReseed = useCallback(() => {
    if (client && paneId) client.requestPaneReset(paneId)
  }, [client, paneId])

  const scrollToBottom = useCallback(() => {
    surface.current?.scrollToBottom()
  }, [surface])

  return { source, fitted, seeded, atBottom, copied, onEvent, onNeedsReseed, scrollToBottom }
}

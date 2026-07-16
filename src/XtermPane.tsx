import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { type FocusEvent, useEffect, useRef } from 'react'

import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  TERMINAL_SCROLLBACK_LINES,
  type PaneTerminalState,
  type SpecialKey,
} from '../shared/protocol'
import type { PaneTerminalSink } from './paneStream'
import { semanticKeyForEvent } from './terminalInput'

type XtermPaneProps = {
  paneId: string
  cols: number
  rows: number
  terminalState: PaneTerminalState
  connected: boolean
  resizeOwner: boolean
  measurementKey: string
  ariaLabel: string
  onFocus: () => void
  onInput: (data: string) => void
  onKey: (key: SpecialKey) => void
  onPaste: (data: string) => void
  onSelectionCopied: () => void
  onResize: (cols: number, rows: number) => void
  registerSink: (paneId: string, sink: PaneTerminalSink) => () => void
  registerFocusable: (paneId: string, node: HTMLElement | null) => void
}

const RESIZE_DEBOUNCE_MS = 80

type ClipboardWriter = Pick<Clipboard, 'writeText'>

const TERMINAL_THEME = {
  background: '#232136',
  foreground: '#e0def4',
  cursor: '#e0def4',
  cursorAccent: '#232136',
  selectionBackground: '#44415a',
  selectionForeground: '#e0def4',
  selectionInactiveBackground: '#393552',
  black: '#393552',
  red: '#eb6f92',
  green: '#3e8fb0',
  yellow: '#f6c177',
  blue: '#9ccfd8',
  magenta: '#c4a7e7',
  cyan: '#ea9a97',
  white: '#e0def4',
  brightBlack: '#6e6a86',
  brightRed: '#eb6f92',
  brightGreen: '#3e8fb0',
  brightYellow: '#f6c177',
  brightBlue: '#9ccfd8',
  brightMagenta: '#c4a7e7',
  brightCyan: '#ea9a97',
  brightWhite: '#e0def4',
} as const

function sourceDimension(value: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : minimum
}

export async function copyTerminalSelection(
  selection: string,
  clipboard: ClipboardWriter | undefined,
): Promise<boolean> {
  if (!selection || !clipboard) return false
  try {
    await clipboard.writeText(selection)
    return true
  } catch {
    // Preserve the selection so the user can still copy it explicitly.
    return false
  }
}

export function terminalDimensionsForViewport(
  viewportWidth: number,
  viewportHeight: number,
  cellWidth: number,
  cellHeight: number,
): { cols: number; rows: number } | null {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(cellWidth) ||
    !Number.isFinite(cellHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    cellWidth <= 0 ||
    cellHeight <= 0
  ) return null
  return {
    cols: Math.max(
      MIN_TERMINAL_COLS,
      Math.min(MAX_TERMINAL_COLS, Math.floor(viewportWidth / cellWidth)),
    ),
    rows: Math.max(
      MIN_TERMINAL_ROWS,
      Math.min(MAX_TERMINAL_ROWS, Math.floor(viewportHeight / cellHeight)),
    ),
  }
}

export function XtermPane({
  paneId,
  cols,
  rows,
  terminalState,
  connected,
  resizeOwner,
  measurementKey,
  ariaLabel,
  onFocus,
  onInput,
  onKey,
  onPaste,
  onSelectionCopied,
  onResize,
  registerSink,
  registerFocusable,
}: XtermPaneProps) {
  const sourceGridRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const connectedRef = useRef(connected)
  const inputRef = useRef(onInput)
  const keyRef = useRef(onKey)
  const pasteRef = useRef(onPaste)
  const selectionCopiedRef = useRef(onSelectionCopied)
  const resizeRef = useRef(onResize)
  const terminalStateRef = useRef(terminalState)
  connectedRef.current = connected
  inputRef.current = onInput
  keyRef.current = onKey
  pasteRef.current = onPaste
  selectionCopiedRef.current = onSelectionCopied
  resizeRef.current = onResize
  terminalStateRef.current = terminalState

  useEffect(() => {
    registerFocusable(paneId, sourceGridRef.current)
    return () => registerFocusable(paneId, null)
  }, [paneId, registerFocusable])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      cols: sourceDimension(cols, 2),
      rows: sourceDimension(rows, 1),
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      disableStdin: !connectedRef.current,
      drawBoldTextInBrightColors: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 10,
      lineHeight: 1,
      minimumContrastRatio: 1,
      macOptionClickForcesSelection: true,
      altClickMovesCursor: false,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      scrollOnUserInput: true,
      theme: TERMINAL_THEME,
    })
    terminal.open(host)
    terminalRef.current = terminal
    const qaEnabled = new URLSearchParams(window.location.search).get('qa') === '1'
    if (qaEnabled) {
      window.__commandoQaTerminals ??= new Map()
      window.__commandoQaTerminals.set(paneId, terminal)
    }

    const textarea = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    textarea?.setAttribute('aria-label', ariaLabel)

    const dataSubscription = terminal.onData((data) => {
      if (connectedRef.current) inputRef.current(data)
    })
    const selectionSubscription = terminal.onSelectionChange(() => {
      void copyTerminalSelection(terminal.getSelection(), navigator.clipboard).then((copied) => {
        if (copied) selectionCopiedRef.current()
      })
    })
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.metaKey && event.key.toLowerCase() === 'k') {
        return false
      }
      if (
        (event.key === 'PageUp' || event.key === 'PageDown') &&
        !terminalStateRef.current.alternateOn
      ) {
        event.preventDefault()
        event.stopPropagation()
        const sourceGrid = sourceGridRef.current
        const buffer = terminal.buffer.active
        if (event.key === 'PageUp') {
          if (sourceGrid && sourceGrid.scrollTop > 0) {
            sourceGrid.scrollBy({ top: -sourceGrid.clientHeight, behavior: 'auto' })
          } else {
            terminal.scrollPages(-1)
          }
        } else if (buffer.viewportY < buffer.baseY) {
          terminal.scrollPages(1)
        } else if (sourceGrid) {
          sourceGrid.scrollBy({ top: sourceGrid.clientHeight, behavior: 'auto' })
        }
        return false
      }
      const key = semanticKeyForEvent(event)
      if (key) {
        event.preventDefault()
        if (connectedRef.current) keyRef.current(key)
        return false
      }
      return true
    })
    const handlePaste = (event: ClipboardEvent) => {
      if (!event.clipboardData) return
      const data = event.clipboardData.getData('text/plain')
      event.preventDefault()
      event.stopPropagation()
      if (connectedRef.current) pasteRef.current(data)
    }
    host.addEventListener('paste', handlePaste, true)
    terminal.attachCustomWheelEventHandler((event) => {
      const paneState = terminalStateRef.current
      if (paneState.mouseAnyFlag) return true

      event.preventDefault()
      event.stopPropagation()
      const sourceGrid = sourceGridRef.current
      if (!sourceGrid) return false

      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        sourceGrid.scrollLeft += event.deltaX || event.deltaY
        return false
      }

      if (paneState.alternateOn) {
        const key = event.deltaY < 0 ? 'Up' : 'Down'
        const repeats = Math.max(1, Math.min(6, Math.ceil(Math.abs(event.deltaY) / 40)))
        if (connectedRef.current) {
          for (let index = 0; index < repeats; index += 1) keyRef.current(key)
        }
        return false
      }

      const buffer = terminal.buffer.active
      if (event.deltaY < 0) {
        if (sourceGrid.scrollTop > 0) sourceGrid.scrollTop += event.deltaY
        else terminal.scrollLines(-3)
      } else if (event.deltaY > 0) {
        if (buffer.viewportY < buffer.baseY) terminal.scrollLines(3)
        else sourceGrid.scrollTop += event.deltaY
      }
      return false
    })

    const sink: PaneTerminalSink = {
      reset: (message) => {
        terminalStateRef.current = message.terminalState
        terminal.options.cursorBlink = message.terminalState.cursorBlinking
        terminal.options.cursorStyle =
          message.terminalState.cursorShape === 'default'
            ? 'block'
            : message.terminalState.cursorShape
        terminal.resize(
          sourceDimension(message.cols, 2),
          sourceDimension(message.rows, 1),
        )
        terminal.reset()
        terminal.write(message.data, () => {
          sourceGridRef.current?.setAttribute(
            'data-terminal-seeded',
            String(message.revision),
          )
        })
      },
      write: (data) => terminal.write(data),
    }
    const unregisterSink = registerSink(paneId, sink)

    return () => {
      unregisterSink()
      dataSubscription.dispose()
      selectionSubscription.dispose()
      host.removeEventListener('paste', handlePaste, true)
      window.__commandoQaTerminals?.delete(paneId)
      terminalRef.current = null
      terminal.dispose()
    }
  }, [paneId, registerSink])

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.disableStdin = !connected
  }, [connected])

  useEffect(() => {
    const textarea = hostRef.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    textarea?.setAttribute('aria-label', ariaLabel)
  }, [ariaLabel])

  useEffect(() => {
    const sourceGrid = sourceGridRef.current
    if (!resizeOwner || !sourceGrid || typeof ResizeObserver === 'undefined') return

    let frame: number | null = null
    let timer: number | null = null
    let lastDimensions = ''
    const measure = () => {
      frame = null
      const terminal = terminalRef.current
      const screen = hostRef.current?.querySelector<HTMLElement>('.xterm-screen')
      if (!terminal || !screen || terminal.cols < 1 || terminal.rows < 1) return
      const screenBounds = screen.getBoundingClientRect()
      const dimensions = terminalDimensionsForViewport(
        sourceGrid.clientWidth,
        sourceGrid.clientHeight,
        screenBounds.width / terminal.cols,
        screenBounds.height / terminal.rows,
      )
      if (!dimensions) return
      const fingerprint = `${dimensions.cols}x${dimensions.rows}`
      if (fingerprint === lastDimensions) return
      lastDimensions = fingerprint
      resizeRef.current(dimensions.cols, dimensions.rows)
    }
    const scheduleMeasurement = () => {
      if (timer !== null) window.clearTimeout(timer)
      if (frame !== null) window.cancelAnimationFrame(frame)
      timer = window.setTimeout(() => {
        timer = null
        frame = window.requestAnimationFrame(measure)
      }, RESIZE_DEBOUNCE_MS)
    }
    const observer = new ResizeObserver(scheduleMeasurement)
    observer.observe(sourceGrid)
    scheduleMeasurement()
    return () => {
      observer.disconnect()
      if (timer !== null) window.clearTimeout(timer)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [cols, measurementKey, paneId, resizeOwner, rows])

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    onFocus()
    if (event.target === event.currentTarget) terminalRef.current?.focus()
  }

  return (
    <div
      ref={sourceGridRef}
      className="terminal-source-grid"
      role="application"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-disabled={!connected}
      aria-keyshortcuts="PageUp PageDown"
      onFocus={handleFocus}
    >
      <div ref={hostRef} className="xterm-host" />
    </div>
  )
}

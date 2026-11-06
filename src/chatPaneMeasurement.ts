import { useEffect, useRef, type RefObject } from 'react'
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, terminalDimensionsForViewport } from './XtermPane'

const PROBE_TEXT = 'W'.repeat(32)
const MEASURE_DEBOUNCE_MS = 50

/**
 * Cell size of the terminal font, measured the way xterm measures it: a run of
 * `W`s in the terminal font, with the terminal's line height of 1.
 */
export function measureTerminalCell(doc: Document = document): { width: number; height: number } | null {
  const probe = doc.createElement('span')
  probe.textContent = PROBE_TEXT
  probe.setAttribute('aria-hidden', 'true')
  Object.assign(probe.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    visibility: 'hidden',
    whiteSpace: 'pre',
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: `${TERMINAL_FONT_SIZE}px`,
    fontKerning: 'none',
  })
  doc.body.appendChild(probe)
  const bounds = probe.getBoundingClientRect()
  probe.remove()
  const width = bounds.width / PROBE_TEXT.length
  const height = bounds.height
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * A pane showing the chat view has no terminal to measure, but tmux still
 * needs a size for it: in the browser-owned layout no window layout is sent
 * until every pane has reported one. Reports the grid a terminal would have
 * in the chat's place, so the agent's TUI is laid out for the space it
 * really gets and is already right when the pane switches back.
 */
export function useChatPaneMeasurement(
  elementRef: RefObject<HTMLElement | null>,
  active: boolean,
  measurementKey: string,
  /** tmux's current size for the pane: a change made elsewhere is corrected, as xterm does. */
  tmuxSize: string,
  onResize: (cols: number, rows: number) => void,
): void {
  const resizeRef = useRef(onResize)
  resizeRef.current = onResize

  useEffect(() => {
    const element = elementRef.current
    if (!active || !element || typeof ResizeObserver === 'undefined') return

    let timer: number | null = null
    let lastDimensions = ''
    const measure = () => {
      timer = null
      const cell = measureTerminalCell(element.ownerDocument)
      if (!cell) return
      const dimensions = terminalDimensionsForViewport(
        element.clientWidth,
        element.clientHeight,
        cell.width,
        cell.height,
      )
      if (!dimensions) return
      const fingerprint = `${dimensions.cols}x${dimensions.rows}`
      if (fingerprint === lastDimensions) return
      lastDimensions = fingerprint
      resizeRef.current(dimensions.cols, dimensions.rows)
    }
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(measure, MEASURE_DEBOUNCE_MS)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    schedule()
    return () => {
      observer.disconnect()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [active, elementRef, measurementKey, tmuxSize])
}

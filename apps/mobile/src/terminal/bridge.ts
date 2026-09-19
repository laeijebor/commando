import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  type PaneTerminalState,
  type ServerMessage,
} from '@commando/protocol'

/**
 * Everything that crosses the RN ↔ WebView boundary, as pure functions: RN
 * sends `TerminalCommand`s down with `injectJavaScript` and the page posts
 * `TerminalEvent`s back. The page itself (`page-script.js`) stays dumb on
 * purpose so the interesting parts are testable without a WebView.
 */
export type TerminalCommand =
  | {
      type: 'reset'
      /** Base64, exactly as the daemon sent it; the page decodes it. */
      data: string
      cols: number
      rows: number
      cursorShape: PaneTerminalState['cursorShape']
      cursorBlink: boolean
      revision: number
    }
  | { type: 'write'; data: string; revision: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'options'; fontSize: number }
  | { type: 'measure' }
  | { type: 'scroll_to_bottom' }
  | { type: 'clear_selection' }

export type TerminalEvent =
  | { type: 'ready' }
  | {
      type: 'cells'
      cellWidth: number
      cellHeight: number
      viewportWidth: number
      viewportHeight: number
      cols: number
      rows: number
    }
  | { type: 'selection'; text: string }
  | { type: 'scroll'; atBottom: boolean }
  | { type: 'seeded'; revision: number }
  | { type: 'error'; message: string }

type PaneResetMessage = Extract<ServerMessage, { type: 'pane_reset' }>
type PaneDataMessage = Extract<ServerMessage, { type: 'pane_data' }>

/**
 * `pane_reset` carries the seed as base64 and the pane's own grid. Both are
 * passed through untouched — decoding on the RN side would mean turning half a
 * megabyte of scrollback into a JS string twice over.
 */
export function resetCommand(message: PaneResetMessage): TerminalCommand {
  return {
    type: 'reset',
    data: message.data,
    cols: sourceDimension(message.cols, MIN_TERMINAL_COLS),
    rows: sourceDimension(message.rows, MIN_TERMINAL_ROWS),
    cursorShape: message.terminalState.cursorShape,
    cursorBlink: message.terminalState.cursorBlinking,
    revision: message.revision,
  }
}

export function writeCommand(message: PaneDataMessage): TerminalCommand {
  return { type: 'write', data: message.data, revision: message.revision }
}

function sourceDimension(value: number, minimum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : minimum
}

/**
 * JSON inside `injectJavaScript` still has to survive being parsed as a
 * JavaScript source line, so the two line terminators JSON leaves bare are
 * escaped. The trailing `true;` is what react-native-webview asks for: without
 * it the injected expression's value is returned across the bridge.
 */
export function encodeCommand(command: TerminalCommand): string {
  const payload = JSON.stringify(command)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `window.__commandoTerminal && window.__commandoTerminal.receive(${payload}); true;`
}

export function parseTerminalEvent(raw: unknown): TerminalEvent | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const event = parsed as { type?: unknown }
  if (typeof event.type !== 'string') return null
  switch (event.type) {
    case 'ready':
    case 'cells':
    case 'selection':
    case 'scroll':
    case 'seeded':
    case 'error':
      return parsed as TerminalEvent
    default:
      return null
  }
}

/** Base64 expands 3 bytes into 4 characters; this is ~4 MiB of pane output. */
const MAX_QUEUED_CHARS = 5_500_000

/**
 * The page is not ready the instant the screen mounts, and `pane_reset` often
 * arrives first. Commands are held until the page says `ready`, with two
 * rules: a reset supersedes everything queued before it, and a queue that
 * outgrows the cap is dropped in favour of asking the daemon to seed again.
 */
export class TerminalCommandQueue {
  private queued: TerminalCommand[] = []
  private ready = false
  private queuedChars = 0
  private dropped = false

  get size(): number {
    return this.queued.length
  }

  get isReady(): boolean {
    return this.ready
  }

  /** True when a queue overflow means the pane needs a fresh seed. */
  get needsReseed(): boolean {
    return this.dropped
  }

  /** Commands to send now — empty while the page is still loading. */
  push(command: TerminalCommand): TerminalCommand[] {
    if (this.ready) return [command]
    if (command.type === 'reset') {
      this.queued = []
      this.queuedChars = 0
      this.dropped = false
    }
    this.queued.push(command)
    this.queuedChars += commandChars(command)
    if (this.queuedChars > MAX_QUEUED_CHARS) {
      this.queued = []
      this.queuedChars = 0
      this.dropped = true
    }
    return []
  }

  /** The page reported `ready`: drain whatever piled up while it loaded. */
  markReady(): TerminalCommand[] {
    this.ready = true
    const drained = this.queued
    this.queued = []
    this.queuedChars = 0
    return drained
  }

  /**
   * The WebView started loading a document. Only the readiness flag is cleared:
   * whatever is still queued has not reached any page yet, and on iOS
   * `onLoadStart` routinely arrives *after* the first `pane_reset` — clearing
   * the queue here would throw the seed away and leave the pane blank, because
   * a reset is only sent once per subscription.
   *
   * Commands already injected into the previous document die with it, so a
   * reload that leaves nothing queued has to ask the daemon to seed again.
   */
  markLoading(): void {
    if (this.ready && this.queued.length === 0) this.dropped = true
    this.ready = false
  }

  clearReseed(): void {
    this.dropped = false
  }
}

function commandChars(command: TerminalCommand): number {
  return command.type === 'reset' || command.type === 'write' ? command.data.length : 0
}

/**
 * Cols and rows for a measured viewport, ported from
 * `terminalDimensionsForViewport` in `src/XtermPane.tsx` so "Fit to phone"
 * lands on the same grid the desktop's focused pane would.
 */
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

/** A measurement the page reported, kept so a resize can be recomputed. */
export type TerminalMetrics = {
  cellWidth: number
  cellHeight: number
  viewportWidth: number
  viewportHeight: number
}

export function metricsFromEvent(
  event: Extract<TerminalEvent, { type: 'cells' }>,
): TerminalMetrics {
  return {
    cellWidth: event.cellWidth,
    cellHeight: event.cellHeight,
    viewportWidth: event.viewportWidth,
    viewportHeight: event.viewportHeight,
  }
}

/** Cols/rows for the fit lease, or null when nothing has been measured yet. */
export function fitDimensions(
  metrics: TerminalMetrics | null,
): { cols: number; rows: number } | null {
  if (!metrics) return null
  return terminalDimensionsForViewport(
    metrics.viewportWidth,
    metrics.viewportHeight,
    metrics.cellWidth,
    metrics.cellHeight,
  )
}

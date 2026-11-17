import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpecialKey, TmuxPane } from '../shared/protocol'
import type { PaneTerminalSink } from './paneStream'
import { TerminalPaneRenderer } from './TerminalPaneRenderer'

export type PaneShellTerminal = {
  onInput: (paneId: string, data: string) => void
  onInputBytes: (paneId: string, data: string) => void
  onKey: (paneId: string, key: SpecialKey) => void
  onPaste: (paneId: string, data: string) => void
  onResize: (paneId: string, cols: number, rows: number) => void
  /** Gives up this client's hold on the shell's size, so another client can size it. */
  onRelease: (paneId: string) => void
  onRequestReset: (paneId: string) => void
  onSelectionCopied: () => void
  registerSink: (paneId: string, sink: PaneTerminalSink) => () => void
}

/** How long a started shell may take to show up in the daemon's snapshot. */
export const SHELL_APPEAR_TIMEOUT_MS = 8_000
const noop = () => {}

/**
 * A pane's Terminal tab: a shell of its own in the pane's folder. The shell is started the
 * first time the tab is shown, and streams only while the tab is on screen.
 */
export function PaneShellTab({ shell, visible, connected, streaming, resizeActive, ensureShell, onVisible, terminal }: {
  /** The shell's pane, once the daemon has started it and listed it. */
  shell: TmuxPane | undefined
  visible: boolean
  connected: boolean
  /** The app is subscribed to the shell's output. */
  streaming: boolean
  /** This window may size tmux panes right now. */
  resizeActive: boolean
  ensureShell: () => Promise<unknown>
  onVisible: (shellPaneId: string, visible: boolean) => void
  terminal: PaneShellTerminal
}) {
  const [error, setError] = useState<string | null>(null)
  /** The shell was listed and is gone: the user left it, so only they start another. */
  const [ended, setEnded] = useState(false)
  const autoStarted = useRef(false)
  const appearTimer = useRef<number | undefined>(undefined)
  const ensureShellRef = useRef(ensureShell)
  ensureShellRef.current = ensureShell
  const releaseRef = useRef(terminal.onRelease)
  releaseRef.current = terminal.onRelease
  const shellId = shell?.id

  const start = useCallback(() => {
    setError(null)
    setEnded(false)
    window.clearTimeout(appearTimer.current)
    ensureShellRef.current().then(() => {
      // A shell that dies at once is never listed; say so instead of waiting for ever.
      appearTimer.current = window.setTimeout(() => setError('The shell started but did not stay open'), SHELL_APPEAR_TIMEOUT_MS)
    }, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'The shell could not be started')
    })
  }, [])

  // Once per tab: a shell that exits, or keeps dying, is not restarted behind the user's back.
  useEffect(() => {
    if (!visible || shellId || !connected || autoStarted.current) return
    autoStarted.current = true
    start()
  }, [visible, shellId, connected, start])

  useEffect(() => {
    if (!shellId) return
    autoStarted.current = true
    window.clearTimeout(appearTimer.current)
    setError(null)
    return () => setEnded(true)
  }, [shellId])
  useEffect(() => () => window.clearTimeout(appearTimer.current), [])

  useEffect(() => {
    if (!visible || !shellId) return
    onVisible(shellId, true)
    return () => onVisible(shellId, false)
  }, [visible, shellId, onVisible])

  const shown = Boolean(shellId) && visible && streaming
  useEffect(() => {
    if (!shown || !shellId) return
    return () => releaseRef.current(shellId)
  }, [shown, shellId])

  if (!shell) {
    return <div className="pane-shell-tab is-pending">
      {error ? <p role="alert">{error} <button type="button" onClick={start}>Try again</button></p>
        : ended ? <p role="status">The shell ended. <button type="button" disabled={!connected} onClick={start}>Start a new shell</button></p>
        : <p role="status">{connected ? 'Starting a shell…' : 'Reconnect to start a shell.'}</p>}
    </div>
  }
  // The daemon refuses resets and resizes for a pane this client is not subscribed to, so the
  // terminal mounts with the subscription and is seeded afresh each time the tab is shown.
  if (!shown) return <div className="pane-shell-tab" />
  return <div className="terminal-pane-body pane-shell-tab">
    <TerminalPaneRenderer
      paneId={shell.id} cols={shell.width} rows={shell.height} terminalState={shell}
      connected={connected} resizeOwner={resizeActive} measurementKey={`shell:${resizeActive}`}
      ariaLabel={`Terminal tab input${connected ? '' : ', disconnected'}`}
      // The desktop app's native terminal views belong to the pane grid; a tab uses xterm.
      order={0} useXtermFallback
      onFocus={noop} onOpenMenu={noop} registerFocusable={noop}
      onInput={(data) => terminal.onInput(shell.id, data)}
      onInputBytes={(data) => terminal.onInputBytes(shell.id, data)}
      onKey={(key) => terminal.onKey(shell.id, key)}
      onPaste={(data) => terminal.onPaste(shell.id, data)}
      onResize={(cols, rows) => terminal.onResize(shell.id, cols, rows)}
      onRequestReset={() => terminal.onRequestReset(shell.id)}
      onSelectionCopied={terminal.onSelectionCopied}
      registerSink={terminal.registerSink} />
  </div>
}

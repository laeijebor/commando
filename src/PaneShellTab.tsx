import { useEffect, useState } from 'react'
import type { SpecialKey, TmuxPane } from '../shared/protocol'
import type { PaneTerminalSink } from './paneStream'
import { TerminalPaneRenderer } from './TerminalPaneRenderer'

export type PaneShellTerminal = {
  onInput: (paneId: string, data: string) => void
  onInputBytes: (paneId: string, data: string) => void
  onKey: (paneId: string, key: SpecialKey) => void
  onPaste: (paneId: string, data: string) => void
  onResize: (paneId: string, cols: number, rows: number) => void
  onRequestReset: (paneId: string) => void
  onSelectionCopied: () => void
  registerSink: (paneId: string, sink: PaneTerminalSink) => () => void
}

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
  const [attempt, setAttempt] = useState(0)
  const shellId = shell?.id

  useEffect(() => {
    if (!visible || shellId || !connected) return
    let current = true
    setError(null)
    ensureShell().catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : 'The shell could not be started')
    })
    return () => { current = false }
    // ensureShell is a new function each render; the pane it starts a shell for does not change.
  }, [visible, shellId, connected, attempt])

  useEffect(() => {
    if (!visible || !shellId) return
    onVisible(shellId, true)
    return () => onVisible(shellId, false)
  }, [visible, shellId, onVisible])

  if (!shell) {
    return <div className="pane-shell-tab is-pending">
      {error
        ? <p role="alert">{error} <button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></p>
        : <p role="status">{connected ? 'Starting a shell…' : 'Reconnect to start a shell.'}</p>}
    </div>
  }
  // The daemon refuses resets and resizes for a pane this client is not subscribed to, so the
  // terminal mounts with the subscription and is seeded afresh each time the tab is shown.
  if (!visible || !streaming) return <div className="pane-shell-tab" />
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

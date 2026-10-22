import { Bot, MessagesSquare, SquareTerminal, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { TmuxPane } from '../shared/protocol'
import { SESSION_AGENT_CHOICES, type SessionAgentProvider } from '../shared/tmux-create'
import './empty-pane.css'

export type EmptyPaneChoice = SessionAgentProvider | 'shell'

/** Stands in for a pane that a session started with nothing running, and launches into it. */
export function EmptyPane({ pane, pending, panelTrigger, focusRef, onClose, onLaunch }: {
  pane: TmuxPane
  pending: boolean
  panelTrigger?: ReactNode
  /** Lets a new empty pane take focus like a terminal pane. */
  focusRef?: (node: HTMLElement | null) => void
  /** Omitted for a session's only pane, which closing would leave empty anyway. */
  onClose?: () => void
  onLaunch: (choice: EmptyPaneChoice) => void
}) {
  return (
    <section ref={focusRef} tabIndex={-1} className="empty-pane" aria-label="Empty pane" data-pane-id={pane.id}>
      {(panelTrigger || onClose) && (
        <header className="empty-pane__head">
          {panelTrigger}
          {onClose && (
            <button type="button" className="icon-button compact" disabled={pending} onClick={onClose}
              aria-label="Close empty pane" aria-keyshortcuts="Meta+W" title="Close pane (⌘W)">
              <X aria-hidden="true" />
            </button>
          )}
        </header>
      )}
      <SquareTerminal className="empty-pane__mark" aria-hidden="true" />
      <h2>Nothing running yet</h2>
      <p className="empty-pane__path" title={pane.path}>{pane.path}</p>
      <div className="empty-pane__choices" role="group" aria-label="Start in this pane">
        {SESSION_AGENT_CHOICES.map((choice) => {
          const Icon = choice.value === 'shell' ? SquareTerminal : choice.value === 'claude-chat' ? MessagesSquare : Bot
          return (
            <button key={choice.value} type="button" disabled={pending} onClick={() => onLaunch(choice.value)}>
              <Icon aria-hidden="true" />
              {choice.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}

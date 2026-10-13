import { Bot, MessagesSquare, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'
import type { TmuxPane } from '../shared/protocol'
import { SESSION_AGENT_CHOICES, type SessionAgentProvider } from '../shared/tmux-create'
import './empty-pane.css'

export type EmptyPaneChoice = SessionAgentProvider | 'shell'

/** Stands in for a pane that a session started with nothing running, and launches into it. */
export function EmptyPane({ pane, pending, panelTrigger, onLaunch }: {
  pane: TmuxPane
  pending: boolean
  panelTrigger?: ReactNode
  onLaunch: (choice: EmptyPaneChoice) => void
}) {
  return (
    <section className="empty-pane" aria-label="Empty pane" data-pane-id={pane.id}>
      {panelTrigger && <header className="empty-pane__head">{panelTrigger}</header>}
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

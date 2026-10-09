import { useMemo } from 'react'
import { PlugZap } from 'lucide-react'
import type { ChatAnswer, ChatState } from '../../shared/agent-chat'
import { ChatComposer } from './ChatComposer'
import { ChatTimeline } from './ChatTimeline'
import { latestTodos, pendingRequests } from './timelineRows'
import './chat.css'

/** A chat pane: the agent host's turns as a narrow, readable column. */
export function ChatPane({
  chat,
  connected,
  focused,
  onFocus,
  onSend,
  onInterrupt,
  onAnswer,
}: {
  chat: ChatState
  /** Whether this browser is connected to the Commando daemon. */
  connected: boolean
  focused: boolean
  onFocus: () => void
  onSend: (text: string) => void
  onInterrupt: () => void
  onAnswer: (requestId: string, answer: ChatAnswer) => void
}) {
  const requests = useMemo(() => pendingRequests(chat.items), [chat.items])
  const todos = useMemo(() => latestTodos(chat.items), [chat.items])
  const working = chat.session.status === 'running'
  return (
    <section className="terminal-chat-shell commando-chat flex min-h-0 min-w-0 flex-col" onMouseDown={onFocus} aria-label="Agent chat" data-testid="chat-pane">
      {!connected ? (
        <div className="flex items-center gap-1.5 border-b border-border bg-warning-surface px-3 py-1.5 text-xs text-warning" role="status">
          <PlugZap className="size-3.5" aria-hidden="true" />
          Reconnecting to Commando… The agent keeps working in its pane.
        </div>
      ) : !chat.hostConnected ? (
        <div className="flex items-center gap-1.5 border-b border-border bg-warning-surface px-3 py-1.5 text-xs text-warning" role="status">
          <PlugZap className="size-3.5" aria-hidden="true" />
          The agent host is disconnected. It keeps working in its pane and will reconnect.
        </div>
      ) : null}
      {chat.session.status === 'error' && chat.session.error ? (
        <div className="border-b border-border px-3 py-1.5 text-xs text-destructive" role="alert">{chat.session.error}</div>
      ) : null}
      <ChatTimeline items={chat.items} cwd={chat.session.cwd} working={working} />
      <ChatComposer
        session={chat.session}
        hostConnected={connected && chat.hostConnected}
        requests={requests}
        {...(todos ? { todos } : {})}
        onSend={onSend}
        onInterrupt={onInterrupt}
        onAnswer={onAnswer}
        autoFocus={focused}
      />
    </section>
  )
}

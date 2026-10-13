import { useRef, useState } from 'react'
import type { AgentChatRequest } from '../shared/agent-chats'
import './agent-chat.css'

export function AgentChatRequestCard({ request, onAnswer }: {
  request: AgentChatRequest
  onAnswer: (id: string, decision: 'accepted' | 'dismissed') => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const summary = request.summary
  const answer = async (decision: 'accepted' | 'dismissed') => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError('')
    try { await onAnswer(request.id, decision) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to answer chat request') }
    finally { inFlight.current = false; setPending(false) }
  }
  return (
    <div className="agent-chat-request web-pane-navigate-request" role="alertdialog" aria-label="Agent wants to open a chat" data-native-terminal-occluder="" aria-busy={pending}>
      <p className="web-pane-navigate-request-lede"><strong>{request.requestedBy}</strong> wants to open a chat</p>
      <p className="web-pane-navigate-request-url">{summary.location === 'session' ? 'New session' : 'Pane'} {summary.title} · {summary.branch ?? 'no worktree'} · {summary.provider}{summary.permissionMode ? ` · ${summary.permissionMode}` : ''}</p>
      <p className="agent-chat-request-reason">{request.reason === 'rate' ? 'Over the rate limit' : 'Opened by another chat (depth limit)'}</p>
      <p className="agent-chat-request-preview">{summary.promptPreview}</p>
      {error ? <p className="agent-chat-request-error" role="alert">{error}</p> : null}
      <div className="web-pane-confirm-actions">
        <button type="button" className="web-pane-action" disabled={pending} onClick={() => void answer('accepted')}>Open</button>
        <button type="button" className="web-pane-action is-ghost" disabled={pending} onClick={() => void answer('dismissed')}>Dismiss</button>
      </div>
    </div>
  )
}

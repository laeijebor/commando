import { MessageSquarePlus } from 'lucide-react'
import type { AgentChatRequest } from '../shared/agent-chats'

export function AgentChatRequestBadge({ request, onSelect }: { request: AgentChatRequest; onSelect: (paneId: string) => void }) {
  const label = `${request.requestedBy} wants to open a chat`
  return <button type="button" className="agent-chat-request-badge" aria-label={label} title={label}
    onClick={(event) => { event.stopPropagation(); onSelect(request.callerPaneId) }}><MessageSquarePlus aria-hidden="true" /></button>
}

import type { AgentChatRequest } from '../shared/agent-chats'

export function AgentChatRequestBadge({ request, onSelect }: { request: AgentChatRequest; onSelect: (paneId: string) => void }) {
  return <button type="button" className="agent-chat-request-badge" title={`${request.requestedBy} wants to open a chat`}
    onClick={(event) => { event.stopPropagation(); onSelect(request.callerPaneId) }}>chat request</button>
}

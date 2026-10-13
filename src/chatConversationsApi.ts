import {
  CHAT_CONVERSATION_ROUTES,
  parseChatConversations,
  type ChatConversation,
  type ResumeChatConversationRequest,
} from '../shared/chat-conversations'

export type ChatConversationsApi = {
  list: () => Promise<ChatConversation[]>
  /** Resolves with the pane now running the conversation. */
  resume: (input: ResumeChatConversationRequest) => Promise<string>
}

async function failure(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null
  return new Error(typeof body?.error === 'string' && body.error ? body.error : `Request failed (${response.status})`)
}

export function createChatConversationsApi(token: string, fetcher: typeof fetch = fetch): ChatConversationsApi {
  const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  return {
    list: async () => {
      const response = await fetcher(CHAT_CONVERSATION_ROUTES.list, { credentials: 'same-origin', headers })
      if (!response.ok) throw await failure(response)
      return parseChatConversations(await response.json())
    },
    resume: async (input) => {
      const response = await fetcher(CHAT_CONVERSATION_ROUTES.resume, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw await failure(response)
      const body = await response.json() as { paneId?: unknown }
      if (typeof body.paneId !== 'string') throw new Error('The daemon did not say which pane runs the conversation')
      return body.paneId
    },
  }
}

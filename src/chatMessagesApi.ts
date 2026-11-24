import {
  CHAT_MESSAGE_SEARCH_ROUTE,
  parseSentMessageSearchResponse,
  type SentMessageSearchResponse,
} from '../shared/chat-messages'

export interface ChatMessagesApi {
  search: (query: string, options?: { limit?: number; signal?: AbortSignal }) => Promise<SentMessageSearchResponse>
}

export function createChatMessagesApi(token: string, fetcher: typeof fetch = fetch): ChatMessagesApi {
  const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  return {
    search: async (query, options) => {
      const params = new URLSearchParams({ q: query })
      if (options?.limit !== undefined) params.set('limit', String(options.limit))
      const response = await fetcher(`${CHAT_MESSAGE_SEARCH_ROUTE}?${params.toString()}`, {
        credentials: 'same-origin',
        headers,
        ...(options?.signal ? { signal: options.signal } : {}),
      })
      if (!response.ok) throw new Error(`Request failed (${response.status})`)
      return parseSentMessageSearchResponse(await response.json())
    },
  }
}

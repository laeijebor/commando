import { createContext, useContext } from 'react'
import type { ChatStashEntry, ChatStashInput } from '../../shared/chat-stash'

/** The daemon's stash as the composer sees it; the daemon pushes `entries` as they change. */
export interface ChatStash {
  /** Newest first. */
  entries: ChatStashEntry[]
  push: (input: ChatStashInput) => Promise<ChatStashEntry>
  /** Takes an entry out; null when another window took it first. */
  take: (id: string) => Promise<{ entry: ChatStashEntry; missingImages: number } | null>
}

export const ChatStashContext = createContext<ChatStash | null>(null)

/** Null where nothing provides a stash (tests, or a page without the daemon). */
export function useChatStash(): ChatStash | null {
  return useContext(ChatStashContext)
}

async function stashRequest<T>(token: string, path: string, init: RequestInit, fetcher: typeof fetch): Promise<{ status: number; body: T & { error?: string } }> {
  const response = await fetcher(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok && response.status !== 404) throw new Error(body.error ?? `The stash request failed (${response.status})`)
  return { status: response.status, body }
}

export function createChatStashApi(token: string, fetcher: typeof fetch = fetch): Pick<ChatStash, 'push' | 'take'> {
  return {
    push: async (input) => {
      const { status, body } = await stashRequest<{ entry?: ChatStashEntry }>(token, '/api/chat/stash', { method: 'POST', body: JSON.stringify(input) }, fetcher)
      if (status === 404 || !body.entry) throw new Error(body.error ?? 'Commando did not stash the draft')
      return body.entry
    },
    take: async (id) => {
      const { status, body } = await stashRequest<{ entry?: ChatStashEntry; missingImages?: number }>(token, `/api/chat/stash/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetcher)
      if (status === 404 || !body.entry) return null
      return { entry: body.entry, missingImages: body.missingImages ?? 0 }
    },
  }
}

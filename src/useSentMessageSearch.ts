import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatState } from '../shared/agent-chat'
import {
  canSearchSentMessages,
  searchLiveChatMessages,
  type SentMessageMatch,
} from '../shared/chat-messages'
import type { ChatMessagesApi } from './chatMessagesApi'

const DEFAULT_DEBOUNCE_MS = 140
const INDEXING_RETRY_MS = 1500

export interface PaneLookupInfo {
  sessionName?: string
  commandoSessionId?: string
  branch?: string
  paneTitle?: string
}

export interface SentMessageSearchState {
  active: boolean
  messages: SentMessageMatch[]
  loading: boolean
  indexing: boolean
}

/**
 * Searches sent user messages when the palette is open and the query has 3+ characters.
 * Returns instant matches from live open chats while fetching the full daemon index.
 */
export function useSentMessageSearch({
  open,
  query,
  connected,
  api,
  chats,
  lookupPane,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: {
  open: boolean
  query: string
  connected: boolean
  api: ChatMessagesApi
  chats: Readonly<Record<string, ChatState>>
  lookupPane: (paneId: string) => PaneLookupInfo
  debounceMs?: number
}): SentMessageSearchState {
  const trimmed = query.trim()
  const active = open && canSearchSentMessages(trimmed)
  const lookupRef = useRef(lookupPane)
  lookupRef.current = lookupPane

  const liveMatches = useMemo(
    () => (active ? searchLiveChatMessages(chats, trimmed, (paneId) => lookupRef.current(paneId)) : []),
    [active, chats, trimmed],
  )

  const [remote, setRemote] = useState<{ query: string; messages: SentMessageMatch[]; indexing: boolean } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!active || !connected) {
      setLoading(false)
      if (!active) setRemote(null)
      return
    }

    let cancelled = false
    let controller: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    setLoading(true)

    const runSearch = (allowRetry: boolean) => {
      controller?.abort()
      controller = new AbortController()
      void api.search(trimmed, { signal: controller.signal }).then(
        (response) => {
          if (cancelled) return
          const indexing = Boolean(response.indexing)
          setRemote({ query: trimmed, messages: response.messages, indexing })
          setLoading(false)
          if (indexing && allowRetry) {
            retryTimer = setTimeout(() => {
              if (!cancelled) runSearch(false)
            }, INDEXING_RETRY_MS)
          }
        },
        (error: unknown) => {
          if (cancelled) return
          if (error instanceof DOMException && error.name === 'AbortError') return
          setLoading(false)
        },
      )
    }

    const timer = setTimeout(() => runSearch(true), debounceMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
      if (retryTimer) clearTimeout(retryTimer)
      controller?.abort()
    }
  }, [active, connected, trimmed, api, debounceMs])

  if (!active) {
    return { active: false, messages: [], loading: false, indexing: false }
  }

  const hasFreshRemote = remote !== null && remote.query === trimmed
  return {
    active: true,
    messages: hasFreshRemote ? remote.messages : liveMatches,
    loading: connected && !hasFreshRemote && loading,
    indexing: hasFreshRemote && remote.indexing,
  }
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { History, LoaderCircle, Search } from 'lucide-react'
import type { ChatState } from '../shared/agent-chat'
import {
  CHAT_CONVERSATION_SCOPE_LABELS,
  chatConversationKey,
  groupChatConversations,
  type ChatConversation,
  type ChatConversationPlacement,
} from '../shared/chat-conversations'
import type { AgentStatus, TmuxPane } from '../shared/protocol'

/** Where an open conversation runs: a chat pane, or a terminal agent that reported its session. */
export type OpenConversationPanes = ReadonlyMap<string, { paneId: string; label: string }>

export function openConversationPanes(
  chats: Readonly<Record<string, ChatState>>,
  statuses: Readonly<Record<string, AgentStatus>>,
  label: (paneId: string) => string,
): Map<string, { paneId: string; label: string }> {
  const open = new Map<string, { paneId: string; label: string }>()
  for (const [paneId, status] of Object.entries(statuses)) {
    // Only a hook knows the session for sure; a guessed one could jump to the wrong pane.
    if (status.source !== 'hook' || !status.agentSessionId || (status.provider !== 'claude' && status.provider !== 'codex')) continue
    open.set(chatConversationKey(status.provider, status.agentSessionId), { paneId, label: label(paneId) })
  }
  for (const [paneId, chat] of Object.entries(chats)) {
    if (chat.session.sessionId) open.set(chatConversationKey(chat.session.provider, chat.session.sessionId), { paneId, label: label(paneId) })
  }
  return open
}

const MINUTE = 60_000
function age(updatedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - updatedAt) / MINUTE))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(updatedAt).toLocaleDateString()
}

function folder(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * ⌘P in a chat: past Claude and Codex conversations, this pane's worktree first,
 * then its repo, then everything else. Enter switches the pane to one, ⌘Enter
 * opens it beside; one that is already open is jumped to instead.
 */
export function ConversationPicker({ pane, current, open, busy, load, onPick, onJump, onClose, now = Date.now() }: {
  pane: TmuxPane
  /** The conversation this chat runs, if Claude has reported it. */
  current?: string
  open: OpenConversationPanes
  /** The chat is mid-turn: switching away stops it. */
  busy: boolean
  load: () => Promise<ChatConversation[]>
  onPick: (conversation: ChatConversation, placement: ChatConversationPlacement) => Promise<void>
  onJump: (paneId: string) => void
  onClose: () => void
  now?: number
}) {
  const [conversations, setConversations] = useState<ChatConversation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [pending, setPending] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    load().then((value) => { if (live) setConversations(value) }, (reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason))
    })
    input.current?.focus()
    return () => { live = false }
  }, [load])

  const groups = useMemo(() => groupChatConversations(conversations ?? [], pane, query), [conversations, pane, query])
  const rows = useMemo(() => groups.flatMap((group) => group.conversations), [groups])
  const selected = rows[Math.min(index, rows.length - 1)]
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(pane.path)?.[1]

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, rows.length])

  const pick = async (conversation: ChatConversation | undefined, placement: ChatConversationPlacement) => {
    if (!conversation || pending) return
    const key = chatConversationKey(conversation.provider, conversation.sessionId)
    if (key === current) { onClose(); return }
    const where = open.get(key)
    if (where) { onJump(where.paneId); return }
    setPending(true)
    setError(null)
    try {
      await onPick(conversation, placement)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length) setIndex((value) => (Math.min(value, rows.length - 1) + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void pick(selected, event.metaKey || event.ctrlKey ? 'split' : 'replace')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  let row = -1
  return (
    <div className="palette-backdrop" data-native-terminal-occluder="" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="command-palette conversation-picker" role="dialog" aria-modal="true" aria-label="Conversations">
        <div className="palette-search">
          <Search aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
            onKeyDown={onKeyDown}
            placeholder="Switch to a conversation…"
            aria-label="Search conversations"
            aria-controls="conversation-results"
            aria-activedescendant={selected ? `conversation-${selected.provider}-${selected.sessionId}` : undefined}
          />
          {pending ? <LoaderCircle className="spin" aria-label="Switching" /> : <kbd>Esc</kbd>}
        </div>
        {error ? <div className="conversation-picker-error" role="alert">{error}</div> : null}
        <div className="command-results" id="conversation-results" role="listbox" ref={list}>
          {conversations === null && !error ? <div className="palette-empty">Loading conversations…</div> : null}
          {conversations && !rows.length ? <div className="palette-empty">{query ? `No conversation matches "${query}".` : 'No past conversations found.'}</div> : null}
          {groups.map((group) => (
            <div role="group" aria-label={CHAT_CONVERSATION_SCOPE_LABELS[group.scope]} key={group.scope}>
              <div className="conversation-picker-group">{CHAT_CONVERSATION_SCOPE_LABELS[group.scope]}</div>
              {group.conversations.map((conversation) => {
                row += 1
                const position = row
                const key = chatConversationKey(conversation.provider, conversation.sessionId)
                const where = key === current ? 'This chat' : open.get(key) ? `Open in ${open.get(key)!.label}` : undefined
                const detail = [age(conversation.updatedAt, now), folder(conversation.cwd, home), conversation.branch].filter(Boolean).join(' · ')
                return (
                  <button
                    type="button"
                    id={`conversation-${conversation.provider}-${conversation.sessionId}`}
                    key={key}
                    role="option"
                    aria-selected={position === Math.min(index, rows.length - 1)}
                    className={position === Math.min(index, rows.length - 1) ? 'active' : ''}
                    onMouseEnter={() => setIndex(position)}
                    onClick={(event) => void pick(conversation, event.metaKey || event.ctrlKey ? 'split' : 'replace')}
                  >
                    <span className="command-icon"><History aria-hidden="true" /></span>
                    <span><strong>{conversation.title}</strong><small>{detail}</small></span>
                    <span className="command-kind">{where ?? (conversation.provider === 'codex' ? 'Codex' : 'Claude')}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <footer className="palette-footer">
          <span><kbd>Enter</kbd> {selected && open.has(chatConversationKey(selected.provider, selected.sessionId)) ? 'Jump to it' : busy ? 'Switch (stops this turn)' : 'Switch this pane'}</span>
          <span><kbd>⌘Enter</kbd> Open beside</span>
          <span><kbd>Esc</kbd> Close</span>
        </footer>
      </section>
    </div>
  )
}

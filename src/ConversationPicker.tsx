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
import type { TmuxPane } from '../shared/protocol'

/** Server-verified open panes, plus chat hosts that may have reported since the list loaded. */
export function openConversationPanes(
  chats: Readonly<Record<string, ChatState>>,
  conversations: readonly ChatConversation[],
  label: (paneId: string) => string,
): Map<string, { paneId: string; label: string }> {
  const open = new Map<string, { paneId: string; label: string }>()
  for (const conversation of conversations) {
    const paneId = conversation.openPaneId
    if (paneId) open.set(chatConversationKey(conversation.provider, conversation.sessionId), { paneId, label: label(paneId) })
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

function folder(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/**
 * ⌘P in a chat: past Claude and Codex conversations, this pane's worktree first,
 * then its repo, then everything else. Enter switches the pane to one, ⌘Enter
 * opens it beside; one that is already open is jumped to instead. It shows over
 * its pane only, leaving the rest of the workspace usable.
 */
export function ConversationPicker({ pane, current, chats, paneLabel, busy, load, onPick, onJump, onClose, now = Date.now() }: {
  pane: TmuxPane
  /** The conversation this chat runs, if Claude has reported it. */
  current?: string
  chats: Readonly<Record<string, ChatState>>
  paneLabel: (paneId: string) => string
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
  /** The highlighted row; null until the keys or mouse move it. */
  const [chosen, setIndex] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  // It covers only its pane, so a click anywhere else closes it like a menu. A click
  // into an embedded page never reaches this document; it only blurs the window.
  useEffect(() => {
    const onPointerDown = (event: Event) => {
      if (!(event.target instanceof Node) || !dialog.current?.contains(event.target)) close.current()
    }
    const onBlur = () => close.current()
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    let live = true
    load().then((value) => { if (live) setConversations(value) }, (reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason))
    })
    input.current?.focus()
    return () => { live = false }
  }, [load])

  const open = useMemo(() => openConversationPanes(chats, conversations ?? [], paneLabel), [chats, conversations, paneLabel])
  const groups = useMemo(() => groupChatConversations(conversations ?? [], pane, query), [conversations, pane, query])
  const rows = useMemo(() => groups.flatMap((group) => group.conversations), [groups])
  // Start on the first conversation that isn't this chat's own.
  const index = Math.min(chosen ?? Math.max(0, rows.findIndex((entry) => chatConversationKey(entry.provider, entry.sessionId) !== current)), Math.max(0, rows.length - 1))
  const selected = rows[index]

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
      if (rows.length) setIndex((index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void pick(selected, event.metaKey || event.ctrlKey ? 'split' : 'replace')
    }
  }

  let row = -1
  return (
    <div className="conversation-picker-backdrop" data-native-terminal-occluder="" role="presentation">
      <section className="command-palette conversation-picker" role="dialog" aria-label="Conversations" ref={dialog}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }}
      >
        <div className="palette-search">
          <Search aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setIndex(null) }}
            onKeyDown={onKeyDown}
            placeholder="Switch to a conversation…"
            aria-label="Search conversations"
            aria-controls="conversation-results"
            aria-activedescendant={selected ? `conversation-${selected.provider}-${selected.sessionId}` : undefined}
          />
          {pending ? <LoaderCircle className="spin" aria-label="Switching" /> : null}
          <button type="button" className="conversation-picker-close" aria-label="Close conversations" onClick={onClose}>
            <kbd>Esc</kbd>
          </button>
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
                const detail = [age(conversation.updatedAt, now), folder(conversation.cwd), conversation.branch].filter(Boolean).join(' · ')
                return (
                  <button
                    type="button"
                    id={`conversation-${conversation.provider}-${conversation.sessionId}`}
                    key={key}
                    role="option"
                    aria-selected={position === index}
                    className={position === index ? 'active' : ''}
                    onMouseMove={() => { if (index !== position) setIndex(position) }}
                    onClick={(event) => void pick(conversation, event.metaKey || event.ctrlKey ? 'split' : 'replace')}
                  >
                    <span className="command-icon"><History aria-hidden="true" /></span>
                    <span><strong>{conversation.title}</strong><small>{detail}</small></span>
                    <span className="command-kind">{where ?? ({ claude: 'Claude', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode' }[conversation.provider])}</span>
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

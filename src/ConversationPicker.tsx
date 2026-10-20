import { assignSessionIdentities, sessionIdentityForName, type SessionIdentities } from '../shared/session-identity'
import { SessionAvatar } from './SessionAvatar'
import { usePaletteDismiss } from './usePaletteDismiss'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { History, LoaderCircle, Search } from 'lucide-react'
import { PaletteBack } from './PanePalette'
import type { ChatState } from '../shared/agent-chat'
import {
  chatConversationProviderLabel,
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
  return path.replace(/\/+$/, '').split('/').pop() || '/'
}

/** Session-first conversation history; open conversations jump to their existing pane. */
export function ConversationPicker({ pane, sessionName, current, chats, paneLabel, busy, load, onPick, onJump, onClose, onBack, defaultPlacement = 'replace', initialSessionFilter, sessionIdentities = {}, now = Date.now() }: {
  pane: TmuxPane
  sessionName: string
  sessionIdentities?: SessionIdentities
  defaultPlacement?: ChatConversationPlacement
  initialSessionFilter?: { id: string; name: string }
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
  /** Back to the pane palette's menu (Backspace in an empty search). */
  onBack?: () => void
  now?: number
}) {
  const [conversations, setConversations] = useState<ChatConversation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string | null>(null)
  const [sessionFilter, setSessionFilter] = useState(initialSessionFilter)
  /** The highlighted row; null until the keys or mouse move it. */
  const [chosen, setIndex] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLElement>(null)
  usePaletteDismiss(dialog, onClose)

  useEffect(() => {
    let live = true
    load().then((value) => { if (live) setConversations(value) }, (reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason))
    })
    input.current?.focus()
    return () => { live = false }
  }, [load])

  const identities = useMemo(() => assignSessionIdentities(sessionIdentities, [sessionName, ...(conversations ?? []).flatMap((conversation) => conversation.session ? [conversation.session.name] : [])]), [sessionIdentities, sessionName, conversations])
  const open = useMemo(() => openConversationPanes(chats, conversations ?? [], paneLabel), [chats, conversations, paneLabel])
  const providers = useMemo(() => [...new Set((conversations ?? []).map(chatConversationProviderLabel))].sort(), [conversations])
  const groups = useMemo(() => groupChatConversations((conversations ?? []).filter((conversation) =>
    (!sessionFilter || conversation.session?.name === sessionFilter.name
      || (conversation.paneOpen && conversation.session?.id === sessionFilter.id)) &&
    (filter === null || (filter === 'closed' ? conversation.session && !conversation.paneOpen
      && chatConversationKey(conversation.provider, conversation.sessionId) !== current
      && !open.has(chatConversationKey(conversation.provider, conversation.sessionId)) : chatConversationProviderLabel(conversation) === filter))),
    { id: pane.sessionId, name: sessionName }, query), [conversations, pane.sessionId, sessionName, query, filter, sessionFilter, current, open])
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
    } else if (event.key === 'Backspace' && !query && onBack) {
      event.preventDefault()
      onBack()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void pick(selected, event.altKey ? 'session' : event.metaKey || event.ctrlKey ? 'split' : defaultPlacement)
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
          {onBack ? <PaletteBack onBack={onBack} /> : <Search aria-hidden="true" />}
          <input
            ref={input}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setIndex(null) }}
            onKeyDown={onKeyDown}
            placeholder="Find a conversation, session or PR…"
            aria-label="Search conversations"
            aria-controls="conversation-results"
            aria-activedescendant={selected ? `conversation-${selected.provider}-${selected.sessionId}` : undefined}
          />
          {pending ? <LoaderCircle className="spin" aria-label="Switching" /> : null}
          <button type="button" className="conversation-picker-close" aria-label="Close conversations" onClick={onClose}>
            <kbd>Esc</kbd>
          </button>
        </div>
        <div className="conversation-picker-filters" aria-label="Filter conversations">
          {sessionFilter ? <button type="button" aria-label={`Clear session filter: ${sessionFilter.name}`} aria-pressed="true"
            onClick={() => { setSessionFilter(undefined); setIndex(null) }}>Session: {sessionFilter.name} ×</button> : null}
          {[{ value: null, label: 'All' }, ...providers.map((label) => ({ value: label, label })), { value: 'closed', label: 'Closed panes' }].map((chip) => (
            <button key={chip.label} type="button" aria-pressed={filter === chip.value}
              onClick={() => { setFilter(filter === chip.value ? null : chip.value); setIndex(null); input.current?.focus() }}>{chip.label}</button>
          ))}
          {error ? <div className="conversation-picker-error" role="alert">{error}</div> : null}
        </div>
        <div className="command-results" id="conversation-results" role="listbox" ref={list}>
          {conversations === null && !error ? <div className="palette-empty">Loading conversations…</div> : null}
          {conversations && !rows.length ? <div className="palette-empty">{query ? `No conversation matches "${query}".` : 'No past conversations found.'}</div> : null}
          {groups.map((group) => {
            const name = group.id.startsWith('session:') ? group.id.slice('session:'.length) : null
            const identity = name === null ? null : sessionIdentityForName(identities, name)
            return (
            <div role="group" aria-label={group.label} key={group.id}>
              <div className="conversation-picker-group"><span className="conversation-picker-session">{identity ? <SessionAvatar identity={identity} /> : null}<span>{group.label}</span>{identity ? <span className="conversation-picker-codename">{identity.codename}</span> : null}</span><span>{group.conversations.length} {group.conversations.length === 1 ? 'chat' : 'chats'}</span></div>
              {group.conversations.map((conversation) => {
                row += 1
                const position = row
                const key = chatConversationKey(conversation.provider, conversation.sessionId)
                const where = key === current ? 'This chat' : open.get(key) ? `Open in ${open.get(key)!.label}`
                  : conversation.paneOpen ? '● open' : conversation.session ? 'closed pane' : undefined
                const folderName = folder(conversation.cwd)
                const detail = [age(conversation.updatedAt, now), folderName, conversation.branch !== folderName ? conversation.branch : undefined, conversation.profile].filter(Boolean).join(' · ')
                return (
                  <button
                    type="button"
                    id={`conversation-${conversation.provider}-${conversation.sessionId}`}
                    key={key}
                    role="option"
                    aria-selected={position === index}
                    className={position === index ? 'active' : ''}
                    onMouseMove={() => { if (index !== position) setIndex(position) }}
                    onClick={(event) => void pick(conversation, event.altKey ? 'session' : event.metaKey || event.ctrlKey ? 'split' : defaultPlacement)}
                  >
                    <span className="command-icon">{identity ? <SessionAvatar identity={identity} glyph size={22} /> : <History aria-hidden="true" />}</span>
                    <span>
                      <strong>{conversation.headline ?? conversation.agentTitle ?? conversation.title}</strong>
                      {conversation.headline ? <span className="conversation-picker-title">{conversation.agentTitle ?? conversation.title}</span> : null}
                      <small>{detail}</small>
                      {conversation.refs?.length ? <span className="conversation-picker-refs">{conversation.refs.slice(0, 3).map((ref, index) => (
                        <span key={index} title={ref.url}>{ref.label}</span>
                      ))}</span> : null}
                    </span>
                    <span className="command-kind">
                      <span>{chatConversationProviderLabel(conversation)}</span>
                      {where ? <span className={where === 'closed pane' ? 'conversation-picker-closed' : 'conversation-picker-open'}>{where}</span> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          )})}
        </div>
        <footer className="palette-footer">
          <span><kbd>Enter</kbd> {selected && open.has(chatConversationKey(selected.provider, selected.sessionId)) ? 'Jump to it' : defaultPlacement === 'session' ? 'In its session' : defaultPlacement === 'split' ? 'Open beside' : busy ? 'Switch (stops this turn)' : 'Switch this pane'}</span>
          <span><kbd>⌘Enter</kbd> Open beside</span>
          {selected?.session ? <span><kbd>⌥Enter</kbd> In its session</span> : null}
          <span><kbd>Esc</kbd> Close</span>
        </footer>
      </section>
    </div>
  )
}

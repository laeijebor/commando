import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { LayoutGrid, LoaderCircle, MessageSquare, RefreshCw, Search, Server, Terminal } from 'lucide-react'
import {
  buildSentMessageSnippet,
  formatSentMessageTime,
  normalizeMessageSearchText,
  type SentMessageMatch,
} from '../shared/chat-messages'

export type PaletteCommand = {
  id: string
  label: string
  detail: string
  kind: 'pane' | 'session' | 'action' | 'layout'
  run: () => void
}

function PaletteGlyph({ kind }: { kind: PaletteCommand['kind'] }) {
  if (kind === 'pane') return <Terminal aria-hidden="true" />
  if (kind === 'session') return <Server aria-hidden="true" />
  if (kind === 'layout') return <LayoutGrid aria-hidden="true" />
  return <RefreshCw aria-hidden="true" />
}

function folderName(path: string | undefined): string | undefined {
  if (!path) return undefined
  return path.replace(/\/+$/, '').split('/').pop() || undefined
}

function chatDetailsForMessage(message: SentMessageMatch): string[] {
  const parts: string[] = [message.providerLabel]
  const normalizedTitle = message.chatTitle ? normalizeMessageSearchText(message.chatTitle) : undefined
  const normalizedText = normalizeMessageSearchText(message.text)
  if (normalizedTitle && normalizedTitle !== normalizedText) {
    parts.push(normalizedTitle)
  }
  const folder = folderName(message.cwd)
  if (folder && folder !== message.sessionName) parts.push(folder)
  if (message.branch && message.branch !== folder && message.branch !== message.sessionName) {
    parts.push(message.branch)
  }
  if (message.openPaneId) parts.push('open')
  else if (message.paneOpen === false) parts.push('closed')
  return parts
}

function MessageSnippet({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => buildSentMessageSnippet(text, query), [text, query])
  return (
    <>
      {segments.map((segment, index) => segment.match
        ? <mark key={index} className="palette-match-highlight">{segment.text}</mark>
        : <span key={index}>{segment.text}</span>)}
    </>
  )
}

export function CommandPalette({
  query,
  onQueryChange,
  commands,
  messages,
  messagesActive,
  messagesLoading,
  messagesIndexing,
  onSelectMessage,
  onClose,
  now = Date.now(),
}: {
  query: string
  onQueryChange: (next: string) => void
  commands: readonly PaletteCommand[]
  messages: readonly SentMessageMatch[]
  messagesActive: boolean
  messagesLoading: boolean
  messagesIndexing: boolean
  onSelectMessage: (message: SentMessageMatch) => void
  onClose: () => void
  now?: number
}) {
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [])

  const normalizedQuery = query.trim().toLowerCase()
  const filteredCommands = useMemo(
    () => commands.filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(normalizedQuery)),
    [commands, normalizedQuery],
  )
  const shownMessages = messagesActive ? messages : []
  const totalCount = filteredCommands.length + shownMessages.length
  const safeIndex = Math.min(activeIndex, Math.max(totalCount - 1, 0))

  const activeDescendantId = safeIndex < filteredCommands.length
    ? filteredCommands[safeIndex]?.id
    : shownMessages[safeIndex - filteredCommands.length]
      ? `sent-message:${shownMessages[safeIndex - filteredCommands.length]!.id}`
      : undefined

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (selected && typeof selected.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'nearest' })
    }
  }, [safeIndex, totalCount])

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (totalCount > 0) setActiveIndex((current) => Math.min(current + 1, totalCount - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (totalCount > 0) setActiveIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (safeIndex < filteredCommands.length) {
        filteredCommands[safeIndex]?.run()
      } else {
        const message = shownMessages[safeIndex - filteredCommands.length]
        if (message) onSelectMessage(message)
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const captionLabel = normalizedQuery
    ? (messagesActive && filteredCommands.length === 0 ? 'Matching sent messages' : 'Matching commands')
    : 'Local cockpit commands'
  const captionCount = messagesActive && shownMessages.length > 0 && filteredCommands.length > 0
    ? `${filteredCommands.length} commands · ${shownMessages.length} messages`
    : `${totalCount} ${totalCount === 1 ? 'result' : 'results'}`

  return (
    <div
      className="palette-backdrop"
      data-native-terminal-occluder=""
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-search">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            id="command-query"
            name="command-query"
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Jump to a pane, session, action, or sent message..."
            aria-label="Search commands"
            aria-controls="command-results"
            aria-activedescendant={activeDescendantId}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-caption">
          <span>{captionLabel}</span>
          <span>{captionCount}</span>
        </div>
        <div className="command-results" id="command-results" role="listbox" ref={listRef}>
          {filteredCommands.map((command, index) => (
            <button
              type="button"
              id={command.id}
              className={index === safeIndex ? 'active' : ''}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={command.run}
              role="option"
              aria-selected={index === safeIndex}
              key={command.id}
            >
              <span className="command-icon"><PaletteGlyph kind={command.kind} /></span>
              <span><strong>{command.label}</strong><small>{command.detail}</small></span>
              <span className="command-kind">{command.kind}</span>
            </button>
          ))}

          {messagesActive ? (
            <div className="palette-messages-section" role="group" aria-label="Sent messages">
              <div className="palette-section-header">
                <span className="palette-section-title">
                  <span>Sent messages</span>
                  {messagesLoading || messagesIndexing ? (
                    <span className="palette-section-status">
                      <LoaderCircle className="spin" aria-hidden="true" />
                      {messagesLoading ? 'Searching…' : 'Indexing older chats…'}
                    </span>
                  ) : null}
                </span>
                <span>{shownMessages.length} {shownMessages.length === 1 ? 'message' : 'messages'}</span>
              </div>

              {shownMessages.map((message, offset) => {
                const index = filteredCommands.length + offset
                const details = chatDetailsForMessage(message)
                const sentLabel = formatSentMessageTime(message.sentAt, now)
                return (
                  <button
                    type="button"
                    id={`sent-message:${message.id}`}
                    className={`palette-message-option ${index === safeIndex ? 'active' : ''}`.trim()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => onSelectMessage(message)}
                    role="option"
                    aria-selected={index === safeIndex}
                    key={message.id}
                  >
                    <span className="command-icon"><MessageSquare aria-hidden="true" /></span>
                    <span className="palette-message-body">
                      <strong><MessageSnippet text={message.text} query={query} /></strong>
                      <small className="palette-message-meta">
                        {message.sessionName ? <span className="palette-message-session">{message.sessionName}</span> : null}
                        {message.sessionName && details.length ? <span aria-hidden="true"> · </span> : null}
                        <span>{details.join(' · ')}</span>
                      </small>
                    </span>
                    <span className="command-kind palette-message-time">
                      {sentLabel ? (
                        <time
                          dateTime={new Date(message.sentAt).toISOString()}
                          title={new Date(message.sentAt).toLocaleString()}
                        >
                          {sentLabel}
                        </time>
                      ) : null}
                    </span>
                  </button>
                )
              })}

              {shownMessages.length === 0 && !messagesLoading && filteredCommands.length > 0 ? (
                <div className="palette-section-empty">No sent messages match "{query}".</div>
              ) : null}
            </div>
          ) : null}

          {totalCount === 0 && !messagesLoading ? (
            <div className="palette-empty">
              {messagesActive ? `Nothing matches "${query}".` : `No local command matches "${query}".`}
            </div>
          ) : null}
        </div>
        <footer className="palette-footer">
          <span><kbd>Up/Down</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Run</span>
          <span><kbd>Esc</kbd> Close</span>
        </footer>
      </section>
    </div>
  )
}

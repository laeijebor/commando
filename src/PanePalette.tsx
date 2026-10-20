import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronLeft, Command, History, Plug } from 'lucide-react'
import { usePaletteDismiss } from './usePaletteDismiss'

/** ⌘P opens a pane's palette on its menu; each entry opens a screen in the same place. */
export type PanePaletteScreen = 'menu' | 'conversations' | 'mcp'

export interface PanePaletteEntry {
  screen: Exclude<PanePaletteScreen, 'menu'>
  label: string
  detail: string
  /** Why the entry can't open here; shown in its place. */
  unavailable?: string
  shortcut?: string
}

const ICONS: Record<PanePaletteEntry['screen'], ReactNode> = {
  conversations: <History aria-hidden="true" />,
  mcp: <Plug aria-hidden="true" />,
}

/** The menu's entries for a pane: chat panes add their agent's MCP servers. */
export function panePaletteEntries(chat: { provider: string; providerLabel: string; hostConnected: boolean; takesMcp: boolean } | undefined): PanePaletteEntry[] {
  const entries: PanePaletteEntry[] = [{ screen: 'conversations', label: 'Resume conversation', detail: 'Switch to or open a past chat', shortcut: '⌘P' }]
  if (!chat) return entries
  const unavailable = chat.provider !== 'claude' ? `Not available for ${chat.providerLabel} chats yet`
    : !chat.hostConnected ? "This chat's agent host is disconnected"
      : !chat.takesMcp ? 'Restart this chat to manage its MCP servers'
        : undefined
  return [...entries, { screen: 'mcp', label: 'MCP servers', detail: 'Connect, sign in to and turn off MCP servers for this agent', ...(unavailable ? { unavailable } : {}) }]
}

export function PaletteBack({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="pane-palette-back" aria-label="Back to the palette" title="Back (⌫)" onClick={onBack}>
      <ChevronLeft aria-hidden="true" />
    </button>
  )
}

/** The shell every pane palette screen shares: it covers its pane and closes on a click elsewhere. */
export function PanePaletteShell({ label, className = '', onClose, keepOnBlur, children }: {
  label: string
  className?: string
  onClose: () => void
  /** True while the window losing focus shouldn't close it (a page it just opened took focus). */
  keepOnBlur?: () => boolean
  children: ReactNode
}) {
  const dialog = useRef<HTMLElement>(null)
  usePaletteDismiss(dialog, onClose, keepOnBlur)
  return (
    <div className="conversation-picker-backdrop" data-native-terminal-occluder="" role="presentation">
      <section className={`command-palette conversation-picker pane-palette ${className}`.trim()} role="dialog" aria-label={label} ref={dialog}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }}
      >
        {children}
      </section>
    </div>
  )
}

export function PanePaletteMenu({ entries, onOpen, onClose }: {
  entries: readonly PanePaletteEntry[]
  onOpen: (screen: PanePaletteEntry['screen']) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? entries.filter((entry) => `${entry.label} ${entry.detail}`.toLowerCase().includes(needle)) : [...entries]
  }, [entries, query])
  const index = Math.min(chosen, Math.max(0, rows.length - 1))
  const open = (entry: PanePaletteEntry | undefined) => { if (entry && !entry.unavailable) onOpen(entry.screen) }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length) setChosen((index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      open(rows[index])
    }
  }

  return (
    <PanePaletteShell label="Pane palette" className="pane-palette-menu" onClose={onClose}>
      <div className="palette-search">
        <Command aria-hidden="true" />
        <input
          ref={input}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setChosen(0) }}
          onKeyDown={onKeyDown}
          placeholder="What do you want to do in this pane?"
          aria-label="Search pane actions"
          aria-controls="pane-palette-results"
          aria-activedescendant={rows[index] ? `pane-palette-${rows[index]!.screen}` : undefined}
        />
        <button type="button" className="conversation-picker-close" aria-label="Close palette" onClick={onClose}><kbd>Esc</kbd></button>
      </div>
      <div className="command-results" id="pane-palette-results" role="listbox">
        {rows.length ? null : <div className="palette-empty">Nothing matches "{query}".</div>}
        {rows.map((entry, position) => (
          <button
            type="button"
            role="option"
            id={`pane-palette-${entry.screen}`}
            key={entry.screen}
            aria-selected={position === index}
            aria-disabled={entry.unavailable ? true : undefined}
            className={`${position === index ? 'active' : ''} ${entry.unavailable ? 'unavailable' : ''}`.trim()}
            onMouseMove={() => { if (position !== index) setChosen(position) }}
            onClick={() => open(entry)}
          >
            <span className="command-icon">{ICONS[entry.screen]}</span>
            <span>
              <strong>{entry.label}</strong>
              <small>{entry.unavailable ?? entry.detail}</small>
            </span>
            <span className="command-kind">{entry.shortcut ? <kbd>{entry.shortcut}</kbd> : null}</span>
          </button>
        ))}
      </div>
      <footer className="palette-footer">
        <span><kbd>Enter</kbd> Open</span>
        <span><kbd>⌘P</kbd> Resume conversation</span>
        <span><kbd>Esc</kbd> Close</span>
      </footer>
    </PanePaletteShell>
  )
}

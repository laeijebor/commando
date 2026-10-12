import { useLayoutEffect, useRef } from 'react'
import { Image as ImageIcon, X } from 'lucide-react'
import type { ChatStashEntry } from '../../shared/chat-stash'
import { cn } from './cn'

// The stash list (Ctrl+Shift+S), in the look of the `/` and `@` menus.

export function stashAge(createdAt: number, now: number): string {
  const elapsed = Math.max(0, now - createdAt)
  if (elapsed < 60_000) return 'just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

/** The chat a draft came from: its title, or its folder, with the pane. */
export function stashSourceLabel(entry: ChatStashEntry, paneId: string): string {
  const { source } = entry
  const name = source.title ?? source.cwd?.split('/').filter(Boolean).pop()
  if (source.paneId === paneId) return name ? `${name} · this chat` : 'this chat'
  return name ? `${name} · ${source.paneId}` : source.paneId
}

function preview(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

export function StashMenu({ id, entries, activeId, paneId, now, onHighlight, onRestore, onRemove }: {
  id: string
  entries: ChatStashEntry[]
  activeId: string | null
  /** The composer's pane, to mark drafts stashed here. */
  paneId: string
  now: number
  onHighlight: (id: string) => void
  onRestore: (entry: ChatStashEntry) => void
  onRemove: (entry: ChatStashEntry) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!activeId || !list.current) return
    list.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(activeId)}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])
  return (
    <div ref={list} className="max-h-64 overflow-y-auto border-b border-border bg-popover py-1 text-sm" data-testid="stash-menu">
      {entries.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground" role="status">Nothing stashed. Ctrl+S puts a draft aside.</p>
      ) : (
        <div id={id} role="listbox" aria-label="Stashed drafts">
          <div className="mx-2 mt-1 mb-0.5 flex items-baseline gap-1.5 text-2xs">
            <span className="font-semibold uppercase tracking-wide text-icon-muted">Stashed drafts</span>
            <span className="truncate text-muted-foreground">Enter restores · Delete removes · Esc closes</span>
          </div>
          {entries.map((entry) => {
            const text = preview(entry.text)
            return (
              <div
                key={entry.id}
                id={`${id}-${entry.id}`}
                data-key={entry.id}
                role="option"
                aria-selected={entry.id === activeId}
                onMouseMove={() => { if (entry.id !== activeId) onHighlight(entry.id) }}
                // Keep focus (and the caret) in the textarea.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onRestore(entry)}
                className={cn('group mx-1 flex min-w-0 cursor-pointer items-baseline gap-2 rounded-[5px] px-2 py-1 text-xs', entry.id === activeId ? 'bg-accent' : 'hover:bg-accent')}
              >
                <span className={cn('min-w-0 flex-1 truncate', text ? 'text-foreground' : 'italic text-muted-foreground')}>{text || 'Images only'}</span>
                {entry.images.length ? (
                  <span className="flex shrink-0 items-center gap-0.5 self-center text-2xs text-muted-foreground" title={`${entry.images.length} image${entry.images.length === 1 ? '' : 's'}`}>
                    <ImageIcon className="size-3" aria-hidden="true" />
                    {entry.images.length}
                  </span>
                ) : null}
                <span className="max-w-[40%] shrink-0 truncate text-2xs text-icon-muted" title={entry.source.cwd}>{stashSourceLabel(entry, paneId)}</span>
                <span className="shrink-0 text-2xs tabular-nums text-icon-muted">{stashAge(entry.createdAt, now)}</span>
                <button
                  type="button"
                  className="shrink-0 cursor-pointer self-center text-muted-foreground opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100 hover:text-foreground"
                  aria-label="Remove from stash"
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation()
                    onRemove(entry)
                  }}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

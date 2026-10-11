import { useLayoutEffect, useRef } from 'react'
import { File, Folder, GitPullRequest, GitPullRequestDraft } from 'lucide-react'
import type { ChatCommand, ChatFileEntry } from '../../shared/agent-chat'
import { cn } from './cn'
import type { PullRequestOption } from './composerTriggers'

// The `/`, `@` and `#` suggestions, after t3code's ComposerCommandMenu (MIT).

export type ComposerMenuItem =
  | { key: string; type: 'native'; name: string; description: string }
  | { key: string; type: 'command'; command: ChatCommand; /** False when picking it moves it to the start. */ runsHere: boolean }
  | { key: string; type: 'file'; entry: ChatFileEntry }
  | { key: string; type: 'pr'; pr: PullRequestOption }

export interface ComposerMenuGroup {
  label: string
  note?: string
  items: ComposerMenuItem[]
}

function ItemBody({ item }: { item: ComposerMenuItem }) {
  switch (item.type) {
    case 'native':
      return (
        <>
          <span className="shrink-0 font-medium text-foreground">/{item.name}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.description}</span>
          <span className="ms-auto shrink-0 rounded-sm bg-secondary px-1 text-2xs text-muted-foreground">Commando</span>
        </>
      )
    case 'command':
      return (
        <>
          <span className={cn('shrink-0 font-medium', item.runsHere ? 'text-foreground' : 'text-secondary-label')}>/{item.command.name}</span>
          {item.command.argumentHint ? <span className="shrink-0 font-mono text-2xs text-icon-muted">{item.command.argumentHint.slice(0, 40)}</span> : null}
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.command.description}</span>
          {!item.runsHere ? <span className="ms-auto shrink-0 rounded-sm bg-secondary px-1 text-2xs text-muted-foreground">moves to start</span> : null}
        </>
      )
    case 'file': {
      const Icon = item.entry.kind === 'directory' ? Folder : File
      const trimmed = item.entry.path.replace(/\/$/, '')
      const slash = trimmed.lastIndexOf('/')
      return (
        <>
          <Icon className="size-3.5 shrink-0 text-icon-muted" aria-hidden="true" />
          <span className="shrink-0 text-foreground">{trimmed.slice(slash + 1)}{item.entry.kind === 'directory' ? '/' : ''}</span>
          {slash > 0 ? <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="rtl">{trimmed.slice(0, slash)}</span> : null}
        </>
      )
    }
    case 'pr': {
      const Icon = item.pr.isDraft ? GitPullRequestDraft : GitPullRequest
      return (
        <>
          <Icon className={cn('size-3.5 shrink-0', item.pr.isDraft ? 'text-icon-muted' : 'text-success')} aria-hidden="true" />
          <span className="shrink-0 tabular-nums text-muted-foreground">#{item.pr.number}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{item.pr.title}</span>
          {item.pr.author ? <span className="ms-auto shrink-0 text-2xs text-icon-muted">{item.pr.author}</span> : null}
        </>
      )
    }
  }
}

export function ComposerMenu({ id, label, groups, activeKey, status, onHighlight, onPick }: {
  id: string
  label: string
  groups: ComposerMenuGroup[]
  activeKey: string | null
  /** Shown instead of the list while loading or when nothing matches. */
  status: string | null
  onHighlight: (key: string) => void
  onPick: (item: ComposerMenuItem) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!activeKey || !list.current) return
    const element = list.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(activeKey)}"]`)
    element?.scrollIntoView?.({ block: 'nearest' })
  }, [activeKey])
  const visible = groups.filter((group) => group.items.length)
  return (
    <div ref={list} className="max-h-64 overflow-y-auto border-b border-border bg-popover py-1 text-sm" data-testid="composer-menu">
      {visible.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground" role="status">{status ?? 'No matches'}</p>
      ) : (
        <div id={id} role="listbox" aria-label={label}>
          {visible.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <div className="mx-2 mt-1 mb-0.5 flex items-baseline gap-1.5 text-2xs">
                <span className="font-semibold uppercase tracking-wide text-icon-muted">{group.label}</span>
                {group.note ? <span className="truncate text-muted-foreground">{group.note}</span> : null}
              </div>
              {group.items.map((item) => (
                <div
                  key={item.key}
                  id={`${id}-${item.key}`}
                  data-key={item.key}
                  role="option"
                  aria-selected={item.key === activeKey}
                  onMouseMove={() => { if (item.key !== activeKey) onHighlight(item.key) }}
                  // Keep focus (and the caret) in the textarea.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onPick(item)}
                  className={cn('mx-1 flex min-w-0 cursor-pointer items-baseline gap-2 rounded-[5px] px-2 py-1 text-xs', item.key === activeKey ? 'bg-accent' : 'hover:bg-accent')}
                >
                  <ItemBody item={item} />
                </div>
              ))}
            </div>
          ))}
          {status ? <p className="px-3 pt-1 text-2xs text-muted-foreground" role="status">{status}</p> : null}
        </div>
      )}
    </div>
  )
}

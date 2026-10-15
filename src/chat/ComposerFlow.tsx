import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ImageIcon, ListChecks, MessageSquareShare, Pencil, SplitSquareHorizontal, X, Rabbit } from 'lucide-react'
import type { ChatQueueAction, ChatQueuedMessage, ChatSessionInfo, ChatSessionPermissionMode } from '../../shared/agent-chat'
import { permissionLabel } from '../../shared/chat-composer'
import { cn } from './cn'
import { Button } from './ui/button'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover'

/**
 * Messages the host holds until Claude's turn ends (after t3code's
 * QueuedRunsControl): edit, remove, or steer one in now.
 */
export function QueuedMessages({ provider = 'Claude', queue, disabled, onChange, onEditOrphaned }: {
  provider?: string
  queue: ChatQueuedMessage[]
  disabled: boolean
  onChange: (change: ChatQueueAction) => void
  /** The message being edited was sent meanwhile; the edit goes to the composer instead of being lost. */
  onEditOrphaned?: (text: string) => void
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const latest = useRef({ editing, onEditOrphaned })
  latest.current = { editing, onEditOrphaned }
  useEffect(() => {
    const current = latest.current.editing
    if (!current || queue.some((queued) => queued.id === current.id)) return
    setEditing(null)
    if (current.text.trim()) latest.current.onEditOrphaned?.(current.text)
  }, [queue])
  // The panel unmounts once the queue empties, which also orphans an edit in progress.
  useEffect(() => () => {
    const current = latest.current.editing
    if (current?.text.trim()) latest.current.onEditOrphaned?.(current.text)
  }, [])
  return (
    <div className="flex flex-col gap-1 border-b border-border px-3 py-2" aria-label="Queued messages" data-testid="chat-queue">
      <span className="text-2xs text-muted-foreground">{`Queued · sent together when ${provider}'s turn ends`}</span>
      {queue.map((queued) => (
        <div key={queued.id} className="flex min-w-0 items-start gap-1.5 rounded-md bg-secondary px-2 py-1 text-sm text-secondary-label">
          {editing?.id === queued.id ? (
            <form
              className="flex min-w-0 flex-1 flex-col gap-1"
              onSubmit={(event) => {
                event.preventDefault()
                if (editing.text.trim()) onChange({ action: 'edit', id: queued.id, text: editing.text })
                setEditing(null)
              }}
            >
              <textarea
                autoFocus
                rows={2}
                aria-label="Edit queued message"
                className="w-full resize-y rounded border border-input bg-background px-1.5 py-1 text-sm text-foreground outline-none"
                value={editing.text}
                onChange={(event) => setEditing({ id: queued.id, text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditing(null)
                  } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
              />
              <span className="flex gap-1">
                <Button size="xs" type="submit" disabled={!editing.text.trim()}>Save</Button>
                <Button size="xs" variant="ghost-muted" type="button" onClick={() => setEditing(null)}>Cancel</Button>
              </span>
            </form>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate py-0.5" title={queued.text}>
                {queued.images?.length ? <ImageIcon className="mr-1 inline size-3 text-icon-muted" aria-label={`${queued.images.length} images`} /> : null}
                {queued.text || '(images only)'}
              </span>
              <Button size="icon-xs" variant="ghost-muted" disabled={disabled || !queued.text} aria-label="Edit queued message" title="Edit" onClick={() => setEditing({ id: queued.id, text: queued.text })}>
                <Pencil aria-hidden="true" />
              </Button>
              <Button size="xs" variant="ghost-muted" disabled={disabled} title={`Send now and end ${provider}'s current turn at its next safe point`} onClick={() => onChange({ action: 'steer', id: queued.id })}>
                <Rabbit aria-hidden="true" />
                Steer now
              </Button>
              <Button size="icon-xs" variant="ghost-muted" disabled={disabled} aria-label="Remove queued message" title="Remove" onClick={() => onChange({ action: 'remove', id: queued.id })}>
                <X aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

/** "Plan ready", after t3code's ComposerPlanFollowUpBanner. */
export function PlanReadyBanner({ provider = 'Claude', session, title, implementMode, refining }: { provider?: string; session: Pick<ChatSessionInfo, 'provider'>; title: string; implementMode: ChatSessionPermissionMode; refining: boolean }) {
  return (
    <div className="flex min-w-0 items-start gap-2 border-b border-border bg-secondary px-3 py-2 text-xs text-muted-foreground" role="status" data-testid="plan-ready">
      <ListChecks className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">Plan ready: </span>
        <span className="text-secondary-label">{title}</span>
        <span className="block">
          {refining
            ? `Refine sends your notes; ${provider} stays in plan mode.`
            : `Implement switches to ${permissionLabel(implementMode, session)} and sends the plan. Type to refine it instead.`}
        </span>
      </span>
    </div>
  )
}

/** Implement, with "Implement in a new chat pane" beside it (t3code's split implement button). */
export function ImplementButton({ disabled, onImplement, onImplementInNewPane }: {
  disabled: boolean
  onImplement: () => void
  onImplementInNewPane?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <span className="flex shrink-0 items-center">
      <Button size="sm" className={cn(onImplementInNewPane && 'rounded-r-none')} disabled={disabled} onClick={onImplement} data-testid="plan-implement">
        Implement
      </Button>
      {onImplementInNewPane ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={<Button size="sm" className="rounded-l-none border-l border-l-primary-foreground/25 px-1.5" aria-label="More ways to implement" disabled={disabled} />}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-56" aria-label="Implement">
            <button
              type="button"
              role="menuitem"
              className="flex w-full cursor-pointer items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-secondary-label hover:bg-accent"
              onClick={() => {
                setOpen(false)
                onImplementInNewPane()
              }}
            >
              <SplitSquareHorizontal className="size-3.5 shrink-0 text-icon-muted" aria-hidden="true" />
              Implement in a new chat pane
            </button>
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
  )
}

/** Shown while the composer writes to a subagent through main Claude. */
export function RelayChip({ provider = 'Claude', label, onClear }: { provider?: string; label: string; onClear: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-b border-border bg-secondary px-3 py-1.5 text-xs text-secondary-label" data-testid="relay-chip">
      <MessageSquareShare className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">To <span className="font-medium text-foreground">@{label}</span>, relayed through main {provider}'s SendMessage</span>
      <Button size="icon-xs" variant="ghost-muted" aria-label="Stop messaging this subagent" onClick={onClear}>
        <X aria-hidden="true" />
      </Button>
    </div>
  )
}

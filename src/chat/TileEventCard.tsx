import { useState } from 'react'
import { Check, ChevronRight, LayoutGrid, PenLine } from 'lucide-react'

import { tileEventSummary, tileEventTitle, type ChatTileEvent } from '../../shared/chat-tile-events'
import { cn } from './cn'

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function Status({ event }: { event: ChatTileEvent }) {
  if (event.status === 'collected') {
    return <span className="inline-flex items-center gap-1 text-2xs text-success"><Check className="size-3" aria-hidden="true" />Collected</span>
  }
  if (event.status === 'waiting') return <span className="text-2xs text-warning">Waiting for agent</span>
  return <span className="text-2xs text-muted-foreground">Sent</span>
}

/**
 * A redline or canvas moment on the user's side of the chat: the agent
 * opened a tile, or the user sent answers from one (expandable).
 */
export function TileEventCard({ event, onOpenTile }: { event: ChatTileEvent; onOpenTile?: (webPaneId: string) => boolean }) {
  const [open, setOpen] = useState(false)
  const Icon = event.source === 'canvas' ? LayoutGrid : PenLine
  const source = event.source === 'canvas' ? 'Canvas' : 'Redline'
  const title = tileEventTitle(event)
  const openTile = onOpenTile ? () => onOpenTile(event.webPaneId) : undefined

  if (event.kind === 'opened') {
    return (
      <div className="flex max-w-[85%] items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-secondary-label" data-testid="tile-event-card">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate">{source} opened · <span className="font-medium text-foreground">{title}</span></span>
        {openTile ? <button type="button" className="ml-auto shrink-0 pl-2 text-xs text-primary hover:underline" onClick={openTile}>Open tile</button> : null}
      </div>
    )
  }

  const items = event.items ?? []
  return (
    <div className="@container w-full max-w-[85%] rounded-lg border border-border bg-card text-sm text-secondary-label" data-testid="tile-event-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-popover"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate">{source} on <span className="font-medium text-foreground">{title}</span></span>
        {/* Narrow chats drop the summary rather than squeeze the title; expanding shows it all. */}
        <span className="hidden min-w-0 shrink-[4] truncate text-muted-foreground @[400px]:inline">· {tileEventSummary(items)}{event.build ? ' · build' : ''}</span>
        <span className="ml-auto shrink-0 pl-1"><Status event={event} /></span>
        <ChevronRight className={cn('size-3 shrink-0 text-icon-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />
      </button>
      {open ? (
        <div className="border-t border-border px-3 pb-2.5 pt-1">
          {items.map((item, index) => (
            <div key={index} className="border-b border-border py-1.5 last:border-b-0">
              {item.kind === 'answer' ? (
                <>
                  <div className="text-xs text-muted-foreground">{item.question}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {item.skipped
                      ? <span className="text-xs italic text-muted-foreground">Skipped</span>
                      : <span className="whitespace-pre-wrap break-words rounded-sm border border-input bg-secondary px-1.5 text-xs text-foreground">{item.answer}</span>}
                  </div>
                  {item.note ? <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-input pl-2 text-xs text-secondary-label">{item.note}</div> : null}
                </>
              ) : (
                <>
                  <div className="truncate text-xs text-muted-foreground">Comment on <span className="font-mono text-2xs">{item.target}</span></div>
                  <div className="mt-0.5 whitespace-pre-wrap break-words text-foreground">{item.comment}</div>
                </>
              )}
              {item.attachments ? <div className="mt-0.5 text-2xs text-muted-foreground">{item.attachments === 1 ? '1 image' : `${item.attachments} images`} attached</div> : null}
            </div>
          ))}
          <div className="flex items-center gap-3 pt-2 text-xs">
            {openTile ? <button type="button" className="text-primary hover:underline" onClick={openTile}>{event.source === 'canvas' ? 'Open canvas' : 'Open tile'}</button> : null}
            <span className="ml-auto text-muted-foreground">Sent {time(event.at)}{event.collectedAt ? ` · collected ${time(event.collectedAt)}` : ''}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

import { useState } from 'react'
import { ChevronRight, CircleX, GitMerge, Wrench } from 'lucide-react'

import { stripHtmlComments, type ChatAutofixEvent } from '../../shared/chat-tile-events'
import type { PrQuickLookTab } from '../PrQuickLook'
import { cn } from './cn'

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Bot comments carry HTML-comment state markers and Markdown heading marks; neither helps in plain text. */
export function readableComment(body: string): string {
  return stripHtmlComments(body).replace(/^#{1,6}\s+/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}

export function autofixSummary(event: Pick<ChatAutofixEvent, 'failingChecks' | 'comments' | 'conflictsWith'>): string {
  return [
    ...(event.failingChecks.length ? [plural(event.failingChecks.length, 'failing check', 'failing checks')] : []),
    ...(event.comments.length ? [plural(event.comments.length, 'comment', 'comments')] : []),
    ...(event.conflictsWith !== undefined ? ['merge conflicts'] : []),
  ].join(', ')
}

function Comment({ author, body, url }: ChatAutofixEvent['comments'][number]) {
  const [open, setOpen] = useState(false)
  const text = readableComment(body) || '(no text)'
  const long = text.length > 280 || text.split('\n').length > 4
  return (
    <div className="border-b border-border py-1.5 last:border-b-0">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="min-w-0 truncate font-medium text-foreground">{author}</span>
        <a className="ml-auto shrink-0 text-primary hover:underline" href={url} target="_blank" rel="noreferrer">View</a>
      </div>
      <div className={cn('mt-0.5 whitespace-pre-wrap break-words text-xs text-secondary-label', !open && long && 'line-clamp-4')}>{text}</div>
      {long ? <button type="button" className="mt-0.5 text-2xs text-primary hover:underline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? 'Show less' : 'Show more'}</button> : null}
    </div>
  )
}

/** A PR auto-fix round Commando sent on the user's behalf. */
export function AutofixCard({ event, onOpenPr }: { event: ChatAutofixEvent; onOpenPr?: (repo: string, number: number, tab: PrQuickLookTab) => void }) {
  const [open, setOpen] = useState(false)
  const name = `${event.repo.split('/').at(-1) ?? event.repo}#${event.number}`
  const summary = autofixSummary(event)
  return (
    <div className="@container w-full max-w-[85%] rounded-lg border border-border bg-card text-sm text-secondary-label" data-testid="autofix-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-popover"
        aria-expanded={open}
        title={`${event.repo}#${event.number}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate">Auto-fix · <span className="font-medium text-foreground">{name}</span></span>
        {/* Narrow chats drop the summary rather than squeeze the PR name; expanding shows it all. */}
        {summary ? <span className="hidden min-w-0 shrink-[4] truncate text-muted-foreground @[400px]:inline">· {summary}</span> : null}
        <span className="ml-auto shrink-0 pl-1 text-2xs text-muted-foreground">Round {event.round}/{event.maxRounds}</span>
        <ChevronRight className={cn('size-3 shrink-0 text-icon-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />
      </button>
      {open ? (
        <div className="border-t border-border px-3 pb-2.5 pt-1">
          {event.failingChecks.length ? (
            <div className="py-1.5">
              <div className="text-xs text-muted-foreground">Failing checks{event.headSha ? <> on <span className="font-mono text-2xs">{event.headSha.slice(0, 7)}</span></> : null}</div>
              <ul className="mt-1 list-none space-y-0.5 pl-0">
                {event.failingChecks.map((name) => (
                  <li key={name} className="flex items-center gap-1.5 text-xs text-foreground">
                    <CircleX className="size-3 shrink-0 text-destructive" aria-hidden="true" />
                    <span className="min-w-0 truncate">{name}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {event.comments.length ? (
            <div className={cn('py-1', event.failingChecks.length && 'border-t border-border')}>
              <div className="pt-0.5 text-xs text-muted-foreground">New comments</div>
              {event.comments.map((comment, index) => <Comment key={`${comment.url}-${index}`} {...comment} />)}
            </div>
          ) : null}
          {event.conflictsWith !== undefined ? (
            <div className={cn('flex items-center gap-1.5 py-1.5 text-xs text-foreground', (event.failingChecks.length || event.comments.length) && 'border-t border-border')}>
              <GitMerge className="size-3 shrink-0 text-destructive" aria-hidden="true" />
              <span className="min-w-0 truncate">Merge conflicts{event.conflictsWith ? <> with <span className="font-mono text-2xs">{event.conflictsWith}</span></> : null}</span>
            </div>
          ) : null}
          <div className="flex items-center gap-3 pt-2 text-xs">
            {onOpenPr ? <button type="button" className="text-primary hover:underline" onClick={() => onOpenPr(event.repo, event.number, event.failingChecks.length ? 'Checks' : 'Conversation')}>Open PR</button> : null}
            <a className="text-primary hover:underline" href={event.url} target="_blank" rel="noreferrer">GitHub</a>
            <span className="ml-auto text-muted-foreground">Sent {time(event.at)}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

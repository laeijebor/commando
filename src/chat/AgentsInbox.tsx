import { useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpRight, Bot, ChevronDown, CircleAlert, CircleCheck, CircleSlash, LoaderCircle, Reply, Send, X } from 'lucide-react'
import { RELAY_MAX_CHARS, type CommanderRelay } from '../../shared/commander'
import type { CommanderInbox, CommanderInboxRow, InboxGroup } from '../commanderInbox'
import { createCommanderApi } from '../commanderApi'
import { relativeTime } from '../relativeTime'
import { cn } from './cn'
import { useNow } from './Subagents'
import { Button } from './ui/button'

export type AgentsInboxProps = {
  groups: CommanderInbox
  token: string
  onOpenPane: (paneId: string, targetId: string) => void
  onRelay: (relay: CommanderRelay) => void
  disabled?: boolean
}
const GROUP_LABELS: Record<InboxGroup, string> = { needs_you: 'Needs you', finished: 'Finished a turn', working: 'Working', idle: 'Idle' }
const GROUP_ORDER: InboxGroup[] = ['needs_you', 'finished', 'working', 'idle']

function StateIcon({ group, row }: { group: InboxGroup; row: CommanderInboxRow }) {
  const base = 'mt-1 size-3.5 shrink-0'
  if (group === 'needs_you' || row.briefTone === 'warn') return <CircleAlert className={cn(base, 'text-warning')} aria-label={group === 'needs_you' ? 'Needs you' : 'Stalled'} />
  if (group === 'finished') return <CircleCheck className={cn(base, 'text-success')} aria-label="Finished" />
  if (group === 'working') return <LoaderCircle className={cn(base, 'animate-spin text-primary')} aria-label="Working" />
  return <CircleSlash className={cn(base, 'text-icon-muted')} aria-label="Idle" />
}

function RelayReceipt({ relay }: { relay: CommanderRelay }) {
  return <div className={cn('mt-0.5 text-2xs', relay.status === 'failed' ? 'text-warning' : 'text-muted-foreground')} role="status">
    {relay.status === 'failed' ? `Relay failed: ${relay.error || 'Unable to deliver'}` : `Relayed · ${relay.status}`}
  </div>
}

function InboxReply({ row, token, disabled, onRelay, onClose }: {
  row: CommanderInboxRow
  token: string
  disabled?: boolean
  onRelay: AgentsInboxProps['onRelay']
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const send = async () => {
    if (disabled || inFlight.current || !text.trim()) return
    inFlight.current = true
    setSending(true)
    setError('')
    try {
      onRelay(await createCommanderApi(token).relay(row.paneId, text.trim()))
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to relay message')
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }
  return <div className="mt-1" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <input autoFocus aria-label={`Reply to ${row.title}`} placeholder="Reply via Commander…" value={text} maxLength={RELAY_MAX_CHARS}
        className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:border-primary"
        disabled={disabled || sending} onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose() }
          if (event.key === 'Enter') { event.preventDefault(); if (!event.nativeEvent.isComposing) void send() }
        }} />
      <Button type="submit" size="icon-xs" variant="ghost-muted" disabled={disabled || sending || !text.trim()} aria-label="Send reply"><Send aria-hidden="true" /></Button>
      <Button type="button" size="icon-xs" variant="ghost-muted" onClick={onClose} aria-label="Cancel reply"><X aria-hidden="true" /></Button>
    </form>
    {error ? <div role="alert" className="mt-1 text-xs text-destructive">{error}</div> : null}
  </div>
}

/** The live agent directory above Commander's composer. */
export function AgentsInbox({ groups, token, onOpenPane, onRelay, disabled }: AgentsInboxProps) {
  const now = useNow(true)
  const [open, setOpen] = useState(true)
  const [idleOpen, setIdleOpen] = useState(false)
  const [focusedTarget, setFocusedTarget] = useState<string>()
  const [replyTarget, setReplyTarget] = useState<string>()
  const list = useRef<HTMLDivElement>(null)
  // Receipts expire even if the daemon has nothing new to broadcast.
  const visible = GROUP_ORDER.flatMap((group) => group === 'idle' && !idleOpen ? [] : groups[group])
  const selected = visible.find((row) => row.targetId === focusedTarget) ?? visible[0]
  const focusRow = (index: number) => {
    const row = visible[(index + visible.length) % visible.length]
    if (!row) return
    setFocusedTarget(row.targetId)
    const options = list.current?.querySelectorAll<HTMLElement>('[role="option"]')
    options?.[(index + visible.length) % visible.length]?.focus()
  }
  const closeReply = () => {
    setReplyTarget(undefined)
    if (selected) focusRow(visible.indexOf(selected))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, input') || !selected) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      focusRow(visible.indexOf(selected) + (event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      onOpenPane(selected.paneId, selected.targetId)
    } else if (event.key.toLowerCase() === 'r' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      if (!disabled) setReplyTarget(selected.targetId)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeReply()
    }
  }
  const unread = GROUP_ORDER.flatMap((group) => groups[group]).filter((row) => row.unread).length
  return <div className="@container mx-auto mb-1.5 w-full max-w-[var(--chat-content-max-width)] rounded-lg border border-border bg-card" data-testid="agents-inbox">
    <button type="button" className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1 text-left text-2xs text-muted-foreground hover:text-foreground"
      aria-expanded={open} onClick={() => setOpen(!open)}>
      <Bot className="size-3" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">Agents · <span className={unread ? 'text-primary' : undefined}>{unread} new</span> · {groups.working.length} working · {groups.idle.length} idle</span>
      {open ? <span className="hidden @[640px]:inline">↑↓ to choose · Enter to open · R to reply</span> : null}
      <ChevronDown className={cn('size-3 shrink-0 transition-transform', !open && '-rotate-90')} aria-hidden="true" />
    </button>
    {open ? <div ref={list} role="listbox" aria-label="Agents inbox" className="max-h-[40vh] overflow-y-auto px-1 pb-1" onKeyDown={onKeyDown}>
      {GROUP_ORDER.map((group) => groups[group].length ? <div role="group" aria-label={GROUP_LABELS[group]} key={group}>
        {group === 'idle'
          ? <button type="button" className="flex items-center gap-1 px-1.5 pb-0.5 pt-1.5 text-2xs text-muted-foreground" aria-expanded={idleOpen} onClick={() => setIdleOpen(!idleOpen)}>
            <ChevronDown aria-hidden="true" className={cn('size-3', !idleOpen && '-rotate-90')} />Idle · {groups.idle.length}
          </button>
          : <div className="px-1.5 pb-0.5 pt-1.5 text-2xs text-muted-foreground">{GROUP_LABELS[group]}</div>}
        {group !== 'idle' || idleOpen ? groups[group].map((row) => {
          const active = selected?.targetId === row.targetId
          const relay = row.latestRelay && (row.latestRelay.status === 'queued' || row.latestRelay.createdAt >= now - 15 * 60_000) ? row.latestRelay : undefined
          const time = relativeTime(row.time, now).replace(' ago', '').replace('Just now', 'now')
          return <div role="option" aria-selected={active} aria-label={row.title} key={row.targetId} tabIndex={active ? 0 : -1}
            onFocus={() => setFocusedTarget(row.targetId)}
            onClick={() => { setFocusedTarget(row.targetId); onOpenPane(row.paneId, row.targetId) }}
            className={cn('group flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring', active && 'bg-accent')}>
            <span className={cn('mt-2 size-1.5 shrink-0 rounded-full', row.unread ? 'bg-primary' : 'bg-transparent')} aria-label={row.unread ? 'Unread' : undefined} />
            <StateIcon group={group} row={row} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className={cn('truncate text-sm text-foreground', row.unread && 'font-semibold')}>{row.title}</span>
                <span className="hidden min-w-0 shrink truncate text-2xs text-muted-foreground @[440px]:inline">{row.sessionName}</span>
                <span className="ml-auto shrink-0 whitespace-nowrap pl-2 text-2xs tabular-nums text-muted-foreground">{group === 'working' && row.toolCount !== undefined ? `${row.toolCount} tools · ` : ''}{time}</span>
              </div>
              {row.brief ? <div className={cn('line-clamp-2 text-xs', row.briefTone === 'warn' ? 'text-warning' : 'text-secondary-label')}>{row.brief}</div> : null}
              {relay ? <RelayReceipt relay={relay} /> : null}
              {replyTarget === row.targetId ? <InboxReply row={row} token={token} disabled={disabled} onRelay={onRelay} onClose={closeReply} /> : null}
            </div>
            <div className={cn('mt-0.5 flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100', active && 'opacity-100')}>
              <Button type="button" size="icon-xs" variant="ghost-muted" tabIndex={active ? 0 : -1} aria-label={`Reply to ${row.title}`} title="Reply (R)" disabled={disabled}
                onClick={(event) => { event.stopPropagation(); setFocusedTarget(row.targetId); setReplyTarget(row.targetId) }}><Reply aria-hidden="true" /></Button>
              <Button type="button" size="icon-xs" variant="ghost-muted" tabIndex={active ? 0 : -1} aria-label={`Open ${row.title}`} title="Open"
                onClick={(event) => { event.stopPropagation(); onOpenPane(row.paneId, row.targetId) }}><ArrowUpRight aria-hidden="true" /></Button>
            </div>
          </div>
        }) : null}
      </div> : null)}
      {!GROUP_ORDER.some((group) => groups[group].length) ? <div className="px-2 py-2 text-xs text-muted-foreground">No other agents yet.</div> : null}
    </div> : null}
  </div>
}

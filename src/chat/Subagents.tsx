import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, Bot, ChevronDown, CircleCheck, CircleSlash, CircleX, LoaderCircle, MessageSquareShare, MoveDownRight, Square } from 'lucide-react'
import type { ChatItem, ChatTaskAction } from '../../shared/agent-chat'
import { cn } from './cn'
import type { SubagentItem, TimelineRow } from './timelineRows'
import { elapsedLabel, relayAvailability, subagentActivity, subagentLabel } from './turnFlow'
import { Button } from './ui/button'

/** A clock that ticks once a second while something live is on screen. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

export function SubagentStateIcon({ agent, className }: { agent: SubagentItem; className?: string }) {
  const base = cn('size-3.5 shrink-0', className)
  switch (agent.state) {
    case 'running': return <LoaderCircle className={cn(base, 'animate-spin text-primary')} aria-label="Running" />
    case 'completed': return <CircleCheck className={cn(base, 'text-success')} aria-label="Done" />
    case 'failed': return <CircleX className={cn(base, 'text-destructive')} aria-label="Failed" />
    case 'stopped': return <CircleSlash className={cn(base, 'text-icon-muted')} aria-label="Stopped" />
  }
}

const STATE_LABELS: Record<SubagentItem['state'], string> = { running: 'running', completed: 'done', failed: 'failed', stopped: 'stopped' }

function metrics(agent: SubagentItem, items: readonly ChatItem[], now: number): { line: string; lastAction: string | null } {
  const activity = subagentActivity(agent, items, now)
  const parts = [
    agent.background && agent.state === 'running' ? 'background' : STATE_LABELS[agent.state],
    ...(activity.toolUses !== null ? [`${activity.toolUses} ${activity.toolUses === 1 ? 'tool' : 'tools'}`] : []),
    ...(activity.elapsedMs !== null ? [elapsedLabel(activity.elapsedMs)] : []),
  ]
  return { line: parts.join(' · '), lastAction: activity.lastAction }
}

/** Subagents of one turn as a card; each row opens that subagent's transcript (t3code groups them the same way). */
export function SubagentGroup({ row, items, now, onOpen }: {
  row: Extract<TimelineRow, { kind: 'subagents' }>
  items: readonly ChatItem[]
  now: number
  onOpen?: (toolUseId: string) => void
}) {
  const running = row.items.filter((agent) => agent.state === 'running').length
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-card" data-testid="subagent-group">
      {row.items.length > 1 ? (
        <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1 text-2xs text-muted-foreground">
          <Bot className="size-3.5" aria-hidden="true" />
          {row.items.length} subagents{running ? ` · ${running} running` : ''}
        </div>
      ) : null}
      <ul className="flex flex-col">
        {row.items.map((agent) => {
          const { line, lastAction } = metrics(agent, items, now)
          return (
            <li key={agent.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                className="flex w-full min-w-0 cursor-pointer items-start gap-2 px-2.5 py-1.5 text-left hover:bg-accent disabled:cursor-default"
                onClick={() => onOpen?.(agent.id)}
                disabled={!onOpen}
                aria-label={`Open subagent ${subagentLabel(agent)}`}
              >
                <SubagentStateIcon agent={agent} className="mt-1" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-sm text-foreground">{subagentLabel(agent)}</span>
                    {agent.subagentType ? <span className="min-w-0 shrink truncate text-2xs text-muted-foreground">{agent.subagentType}</span> : null}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <span className="tabular-nums">{line}</span>
                    {lastAction ? ` · ${lastAction}` : ''}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Stop and Background for one running subagent. */
export function SubagentControls({ provider = 'Claude', agent, onTask, disabled }: { provider?: string; agent: SubagentItem; onTask: (action: ChatTaskAction, agent: SubagentItem) => void; disabled?: boolean }) {
  if (agent.state !== 'running' || !agent.agentId) return null
  return (
    <>
      {!agent.background ? (
        <Button size="icon-xs" variant="ghost-muted" disabled={disabled} aria-label={`Background ${subagentLabel(agent)}`} title={`Run in the background (${provider} carries on)`} onClick={(event) => { event.stopPropagation(); onTask('background', agent) }}>
          <MoveDownRight aria-hidden="true" />
        </Button>
      ) : null}
      <Button size="icon-xs" variant="ghost-muted" disabled={disabled} aria-label={`Stop ${subagentLabel(agent)}`} title="Stop this subagent" onClick={(event) => { event.stopPropagation(); onTask('stop', agent) }}>
        <Square className="size-3 fill-current text-destructive" aria-hidden="true" />
      </Button>
    </>
  )
}

/**
 * Main Claude plus each subagent, like the Claude Code TUI's agent list:
 * ↑/↓ move, Enter opens. Shows which one the pane is viewing.
 */
export function AgentSwitcher({ provider = 'Claude', agents, items, viewing, now, disabled, onSelect, onTask }: {
  provider?: string
  agents: SubagentItem[]
  items: readonly ChatItem[]
  /** The viewed subagent's id, or undefined for main. */
  viewing: string | undefined
  now: number
  disabled?: boolean
  onSelect: (toolUseId: string | undefined) => void
  onTask: (action: ChatTaskAction, agent: SubagentItem) => void
}) {
  const entries: (SubagentItem | undefined)[] = [undefined, ...agents]
  const list = useRef<HTMLUListElement>(null)
  const [focusIndex, setFocusIndex] = useState(() => Math.max(0, entries.findIndex((entry) => entry?.id === viewing)))
  const focusRow = (index: number) => {
    const next = (index + entries.length) % entries.length
    setFocusIndex(next)
    list.current?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusRow(focusIndex + (event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(entries[focusIndex]?.id)
    } else if (event.key === 'Escape' && viewing) {
      event.preventDefault()
      onSelect(undefined)
    }
  }
  const running = agents.filter((agent) => agent.state === 'running').length
  // Open while something runs or a subagent is on screen, so a short pane keeps its timeline otherwise.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? (running > 0 || viewing !== undefined)
  const viewed = agents.find((agent) => agent.id === viewing)
  return (
    <div className="mx-auto mb-1.5 w-full max-w-[var(--chat-content-max-width)] rounded-lg border border-border bg-card" data-testid="agent-switcher">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1 text-left text-2xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        <Bot className="size-3" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          Agents · viewing {viewed ? subagentLabel(viewed) : 'Main'}{running ? ` · ${running} running` : ''}
        </span>
        {open ? <span className="hidden sm:inline">↑↓ to choose · Enter to open</span> : null}
        <ChevronDown className={cn('size-3 shrink-0 transition-transform', !open && '-rotate-90')} aria-hidden="true" />
      </button>
      {open ? (
      <ul ref={list} role="listbox" aria-label="Agents" className="flex max-h-28 flex-col overflow-y-auto px-1 pb-1" onKeyDown={onKeyDown}>
        {entries.map((agent, index) => {
          const selected = (agent?.id ?? undefined) === viewing
          const info = agent ? metrics(agent, items, now) : null
          return (
            <li
              key={agent?.id ?? 'main'}
              role="option"
              aria-selected={selected}
              tabIndex={index === focusIndex ? 0 : -1}
              onFocus={() => setFocusIndex(index)}
              onClick={() => onSelect(agent?.id)}
              className={cn('flex min-h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring', selected ? 'bg-accent text-foreground' : 'text-secondary-label hover:bg-accent')}
            >
              {agent ? <SubagentStateIcon agent={agent} /> : <span className="flex size-3.5 shrink-0 items-center justify-center"><span className="size-2 rounded-full bg-primary" /></span>}
              <span className="min-w-0 flex-1 truncate">{agent ? subagentLabel(agent) : 'Main'}{agent?.subagentType ? <span className="ml-1.5 text-2xs text-muted-foreground">{agent.subagentType}</span> : null}</span>
              {info ? <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{info.line}</span> : null}
              {agent ? <SubagentControls provider={provider} agent={agent} onTask={onTask} disabled={disabled} /> : null}
            </li>
          )
        })}
      </ul>
      ) : null}
    </div>
  )
}

/** The top of a subagent's view: back to main, what it is, and what can be done with it. */
export function SubagentHeader({ provider = 'Claude', agent, items, now, disabled, onBack, onTask, onMessage }: {
  provider?: string
  agent: SubagentItem
  items: readonly ChatItem[]
  now: number
  disabled?: boolean
  onBack: () => void
  onTask: (action: ChatTaskAction, agent: SubagentItem) => void
  /** Starts a relayed message to it; absent when relaying isn't possible. */
  onMessage?: () => void
}) {
  const { line } = metrics(agent, items, now)
  const relay = relayAvailability(agent)
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-b border-border bg-card px-2 py-1.5" data-testid="subagent-header">
      <Button size="xs" variant="ghost-muted" onClick={onBack} aria-label="Back to main" title="Back to main (Esc)">
        <ArrowLeft aria-hidden="true" />
        Main
      </Button>
      <SubagentStateIcon agent={agent} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{subagentLabel(agent)}{agent.subagentType ? <span className="ml-1.5 text-2xs text-muted-foreground">{agent.subagentType}</span> : null}</span>
        <span className="block truncate text-2xs tabular-nums text-muted-foreground">{line}</span>
      </span>
      <SubagentControls provider={provider} agent={agent} onTask={onTask} disabled={disabled} />
      {onMessage ? (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || !relay.ok}
          title={relay.ok ? `Main ${provider} forwards your message with its SendMessage tool` : relay.reason}
          onClick={onMessage}
        >
          <MessageSquareShare aria-hidden="true" />
          Message
        </Button>
      ) : null}
    </div>
  )
}

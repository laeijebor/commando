import { useId } from 'react'
import { asideKey, type ChatAsideAction, type ChatAsideRecord, type ChatState } from '../../shared/agent-chat'
import { pendingRequests } from '../../shared/chat-timeline'
import { useNow } from './Subagents'
import { Button } from './ui/button'

export function asideStatus(chat?: ChatState): string {
  return !chat || chat.session.status === 'error' || chat.session.status === 'closed' ? 'error'
    : pendingRequests(chat.items).length ? 'needs answer'
    : chat.session.status === 'running' || chat.session.status === 'starting' ? 'running' : 'idle'
}

function ThreadStatus({ chat, stopped = false }: { chat?: ChatState; stopped?: boolean }) {
  const status = stopped || chat?.session.status === 'error' ? 'error'
    : chat && pendingRequests(chat.items).length ? 'needs answer'
    : chat?.session.status === 'running' || chat?.session.status === 'starting' ? 'running' : 'idle'
  return <span className={`chat-aside-dot is-${status.replace(' ', '-')}`} role="img" aria-label={status} />
}

export function AsideTabs({ main, chats, selected, onSelect, onAction, disabled, pending }: {
  main: ChatState
  chats: Readonly<Record<string, ChatState>>
  selected: string | undefined
  onSelect: (id: string | undefined) => void
  onAction: (action: ChatAsideAction) => void
  disabled: boolean
  pending?: (asideId: string) => boolean
}) {
  const id = useId()
  const records = (main.asides ?? []).filter((aside) => !aside.ephemeral && aside.status !== 'discarded')
  const closed = records.filter((aside) => aside.status === 'closed' || aside.status === 'promoted')
  return <div className="chat-aside-strip">
    {main.asidesError ? <div role="alert" className="px-3 py-2 text-xs text-destructive">Saved asides couldn't be read: {main.asidesError}</div> : null}
    <div role="tablist" aria-label="Chat threads" className="chat-aside-tabs" onKeyDown={(event) => {
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')]
      const index = tabs.indexOf(event.target as HTMLButtonElement)
      if (index < 0) return
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (next < 0) return
      event.preventDefault()
      tabs[next]?.focus()
      tabs[next]?.click()
    }}>
      <button type="button" role="tab" aria-selected={!selected} onClick={() => onSelect(undefined)}><ThreadStatus chat={main} />Main</button>
      {records.filter((aside) => aside.status === 'open').map((aside) => {
        const chat = chats[asideKey(main.paneId, aside.id)]
        const title = chat?.session.title || aside.title
        return <div role="presentation" className={`chat-aside-tab${selected === aside.id ? ' is-selected' : ''}`} key={aside.id}>
          <button type="button" role="tab" aria-selected={selected === aside.id} title={title} onClick={() => onSelect(aside.id)}><ThreadStatus chat={chat} stopped={!chat && !pending?.(aside.id)} /><span className="truncate">{title}</span></button>
          <button type="button" className="chat-aside-close" disabled={disabled} aria-label={`Close aside ${title}`} onClick={() => onAction({ action: 'close', asideId: aside.id })}>✕</button>
        </div>
      })}
      {selected === 'new' ? <button type="button" role="tab" aria-selected>New aside</button> : null}
      <button type="button" disabled={disabled} className="chat-aside-add" onClick={() => onSelect('new')}>＋ Aside</button>
    </div>
    {closed.length ? <details className="chat-aside-closed"><summary aria-controls={id}>Closed ({closed.length})</summary><div id={id} className="chat-aside-closed-list">
      {closed.map((aside) => {
        const title = chats[asideKey(main.paneId, aside.id)]?.session.title || aside.title
        return <div key={aside.id}><span className="min-w-0 flex-1"><span className="truncate" title={title}>{title}</span>{aside.lastError ? <small className="block text-destructive">{aside.lastError}</small> : null}</span>{aside.status === 'promoted' ? <small>Opened as chat</small> : <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={() => onAction({ action: 'reopen', asideId: aside.id })} aria-label={`Reopen ${title}`}>Reopen</Button>}
          <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={() => onAction({ action: 'promote', asideId: aside.id })} aria-label={`Open as chat ${title}`}>Open as chat</Button></div>
      })}
    </div></details> : null}
  </div>
}

export function AsideBanner({ aside, disabled, onAction, onReport, reportDisabled }: { aside: ChatAsideRecord; disabled: boolean; onAction: (action: ChatAsideAction) => void; onReport?: () => void; reportDisabled?: boolean }) {
  const now = useNow(true)
  const minutes = Math.max(0, Math.floor((now - aside.createdAt) / 60_000))
  const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`
  const mode = aside.mode === 'inherit' ? 'Full access' : aside.readOnlyEnforced ? 'Read-only' : 'Read-only (advisory)'
  return <div className="chat-aside-banner">
    <span className="min-w-0 flex-1"><strong>Aside</strong> · forked from Main {age} · {mode}{aside.lastError ? <small className="block text-destructive">{aside.lastError}</small> : null}</span>
    <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={() => onAction({ action: 'promote', asideId: aside.id })}>Open as chat</Button>
    {onReport ? <Button size="xs" variant="ghost-muted" disabled={disabled || reportDisabled} onClick={onReport}>Report to Main</Button> : null}
    <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={() => onAction({ action: 'mode', asideId: aside.id, mode: aside.mode === 'read-only' ? 'inherit' : 'read-only' })} title={aside.mode === 'read-only' ? "Lets this aside use Main's permissions, including edits" : 'Blocks edit tools in this aside'}>{aside.mode === 'read-only' ? 'Allow edits' : 'Make read-only'}</Button>
    <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={() => {
      if (window.confirm("Replaces this aside's conversation with a fresh fork of Main's latest finished turn")) onAction({ action: 'refork', asideId: aside.id })
    }}>Refork</Button>
    <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={() => onAction({ action: 'close', asideId: aside.id })}>Close</Button>
  </div>
}

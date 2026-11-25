import { useId } from 'react'
import { asideKey, type ChatAsideAction, type ChatAsideRecord, type ChatState } from '../../shared/agent-chat'
import { pendingRequests } from '../../shared/chat-timeline'
import { useNow } from './Subagents'
import { Button } from './ui/button'

function ThreadStatus({ chat }: { chat?: ChatState }) {
  const status = chat?.session.status === 'error' ? 'error'
    : chat && pendingRequests(chat.items).length ? 'needs answer'
    : chat?.session.status === 'running' || chat?.session.status === 'starting' ? 'running' : 'idle'
  return <span className={`chat-aside-dot is-${status.replace(' ', '-')}`} role="img" aria-label={status} />
}

export function AsideTabs({ main, chats, selected, onSelect, onAction, disabled }: {
  main: ChatState
  chats: Readonly<Record<string, ChatState>>
  selected: string | undefined
  onSelect: (id: string | undefined) => void
  onAction: (action: ChatAsideAction) => void
  disabled: boolean
}) {
  const id = useId()
  const records = main.asides ?? []
  const closed = records.filter((aside) => aside.status === 'closed')
  return <div className="chat-aside-strip">
    <div role="tablist" aria-label="Chat threads" className="chat-aside-tabs" onKeyDown={(event) => {
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')]
      const index = tabs.indexOf(event.target as HTMLButtonElement)
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (next < 0) return
      event.preventDefault()
      tabs[next]?.focus()
      tabs[next]?.click()
    }}>
      <button type="button" role="tab" aria-selected={!selected} onClick={() => onSelect(undefined)}><ThreadStatus chat={main} />Main</button>
      {records.filter((aside) => aside.status === 'open').map((aside) => <button type="button" role="tab" aria-selected={selected === aside.id} title={aside.title} key={aside.id} onClick={() => onSelect(aside.id)}><ThreadStatus chat={chats[asideKey(main.paneId, aside.id)]} /><span className="truncate">{aside.title}</span></button>)}
      {selected === 'new' ? <button type="button" role="tab" aria-selected>New aside</button> : null}
      <button type="button" disabled={disabled} className="chat-aside-add" onClick={() => onSelect('new')}>＋ Aside</button>
    </div>
    {closed.length ? <details className="chat-aside-closed"><summary aria-controls={id}>Closed ({closed.length})</summary><div id={id} className="chat-aside-closed-list">
      {closed.map((aside) => <div key={aside.id}><span className="truncate" title={aside.title}>{aside.title}</span><Button size="xs" variant="ghost-muted" disabled={disabled} onClick={() => onAction({ action: 'reopen', asideId: aside.id })} aria-label={`Reopen ${aside.title}`}>Reopen</Button></div>)}
    </div></details> : null}
  </div>
}

export function AsideBanner({ aside, disabled, onAction }: { aside: ChatAsideRecord; disabled: boolean; onAction: (action: ChatAsideAction) => void }) {
  const now = useNow(true)
  const minutes = Math.max(0, Math.floor((now - aside.createdAt) / 60_000))
  const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`
  const mode = aside.mode === 'inherit' ? 'Full access' : aside.readOnlyEnforced ? 'Read-only' : 'Read-only (advisory)'
  return <div className="chat-aside-banner">
    <span className="min-w-0 flex-1"><strong>Aside</strong> · forked from Main {age} · {mode}</span>
    <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={() => onAction({ action: 'mode', asideId: aside.id, mode: aside.mode === 'read-only' ? 'inherit' : 'read-only' })} title={`Switch to ${aside.mode === 'read-only' ? 'full access' : 'read-only'}`}>Toggle mode</Button>
    <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={() => {
      if (window.confirm("Replaces this aside's conversation with a fresh fork of Main's latest finished turn")) onAction({ action: 'refork', asideId: aside.id })
    }}>Refork</Button>
    <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={() => onAction({ action: 'close', asideId: aside.id })}>Close</Button>
  </div>
}

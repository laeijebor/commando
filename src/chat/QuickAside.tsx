import { useState } from 'react'
import type { ChatAsideRecord, ChatState } from '../../shared/agent-chat'
import { Markdown } from './ChatTimeline'
import { Button } from './ui/button'

export function quickAsideAnswer(chat?: ChatState): string {
  return (chat?.items ?? []).filter((item) => item.kind === 'assistant_message' && !item.parentToolUseId)
    .map((item) => item.kind === 'assistant_message' ? item.text : '').join('\n\n')
}

/** Rendered above Main's composer; its transcript never enters Main's timeline. */
export function QuickAside({ record, chat, title, disabled, onAsk, onKeep, onCopy, onDismiss }: {
  record?: ChatAsideRecord
  chat?: ChatState
  title?: string
  disabled: boolean
  onAsk: (text: string) => Promise<boolean>
  onKeep: () => void
  onCopy: (text: string) => void
  onDismiss: () => void
}) {
  const [question, setQuestion] = useState('')
  const answer = quickAsideAnswer(chat)
  return <section className="chat-quick-aside" role="region" aria-label="Quick aside" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!disabled) onDismiss() }
  }}>
    <header><strong>Quick aside</strong><span>From this chat · not saved to Main</span><Button size="xs" variant="ghost-muted" disabled={disabled} onClick={onDismiss}>Dismiss</Button></header>
    {record ? <>
      <p className="chat-quick-question">{title ?? record.title}</p>
      <div className="chat-quick-answer" aria-live="polite"><Markdown text={answer} running={chat?.session.status === 'running'} />
        {!answer ? <span role="status">{record.lastError ?? chat?.session.error ?? (chat?.session.status === 'idle' ? 'No answer yet' : 'Answering…')}</span> : null}
      </div>
      <footer><Button size="xs" variant="ghost-muted" disabled={disabled} onClick={onKeep}>Keep as aside</Button>
        <Button size="xs" variant="ghost-muted" disabled={disabled || !answer} onClick={() => onCopy(answer)}>Copy into Main draft</Button></footer>
    </> : <form onSubmit={(event) => { event.preventDefault(); if (question.trim() && !disabled) void onAsk(question.trim()) }}>
      <input autoFocus aria-label="Quick question" placeholder="Ask anything without interrupting…" value={question} onChange={(event) => setQuestion(event.target.value)} disabled={disabled} />
      <Button type="submit" size="xs" disabled={disabled || !question.trim()}>Ask</Button>
    </form>}
  </section>
}

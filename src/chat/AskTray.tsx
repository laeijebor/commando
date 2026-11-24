import { useEffect, useState } from 'react'
import { ArrowUp, Check, ChevronRight, ExternalLink } from 'lucide-react'
import type { SessionAsk } from '../../shared/protocol'
import { relativeTime } from '../relativeTime'
import { cn } from './cn'
import { Button } from './ui/button'

const SENT_RETRY_MS = 15_000

export type AskTrayProps = {
  asks: readonly SessionAsk[]
  /** Not connected, so answers can't be sent. */
  disabled: boolean
  /** Keys of asks with a place in the conversation to jump back to. */
  anchored: ReadonlySet<string>
  /** Bumped to open the tray, e.g. from an inline marker. */
  openSignal?: number
  /** Sends the option as the answer. */
  onAnswer: (ask: SessionAsk, option: string) => void
  /** Starts a free-text answer in the composer. */
  onReply: (ask: SessionAsk) => void
  onJump: (ask: SessionAsk) => void
}

/**
 * Pinned above the composer: every question the agent is waiting on, until it is answered or
 * the agent resolves it. Collapsed, it's one line with the count and the first question.
 */
export function AskTray({ asks, disabled, anchored, openSignal, onAnswer, onReply, onJump }: AskTrayProps) {
  const [open, setOpen] = useState(false)
  const [whyOpen, setWhyOpen] = useState<ReadonlySet<string>>(new Set())
  // Answers on their way: the ask stays, marked sent, until the daemon closes it.
  // A refused send leaves the ask open, so its options come back after a while.
  const [sent, setSent] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => { if (openSignal) setOpen(true) }, [openSignal])
  useEffect(() => {
    setSent((current) => {
      const keys = new Set(asks.map((ask) => ask.key))
      const kept = [...current].filter(([key]) => keys.has(key))
      return kept.length === current.size ? current : new Map(kept)
    })
  }, [asks])
  if (!asks.length) return null
  const waiting = asks.filter((ask) => !sent.has(ask.key))
  const first = waiting[0] ?? asks[0]!
  const now = Date.now()
  const answer = (ask: SessionAsk, option: string) => {
    onAnswer(ask, option)
    setSent((current) => new Map(current).set(ask.key, option))
    window.setTimeout(() => setSent((current) => {
      if (current.get(ask.key) !== option) return current
      const next = new Map(current)
      next.delete(ask.key)
      return next
    }), SENT_RETRY_MS)
  }
  return (
    <div className="chat-ask-tray" data-testid="ask-tray">
      <div className={cn('chat-ask-panel', open && 'open')}>
        <button type="button" className="chat-ask-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <ChevronRight className="chat-ask-chevron size-3.5 shrink-0" aria-hidden="true" />
          <span className="chat-ask-diamond" aria-hidden="true">◆</span>
          <b className="shrink-0">Waiting on you</b>
          <span className="chat-ask-count" aria-label={`${waiting.length} open`}>{waiting.length}</span>
          {!open ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{first.question}</span> : <span className="flex-1" />}
          <span className="shrink-0 text-2xs text-muted-foreground">asked {relativeTime(first.askedAt, now).replace('Just now', 'just now')}</span>
        </button>
        {open ? (
          <ul className="chat-ask-list" aria-label="Questions waiting on you">
            {asks.map((ask) => {
              const answered = sent.get(ask.key)
              const showWhy = whyOpen.has(ask.key)
              return (
                <li key={ask.key} className={cn('chat-ask-item', answered !== undefined && 'sent')}>
                  <h4>{ask.question}</h4>
                  {ask.context ? <p className="chat-ask-context">{ask.context}</p> : null}
                  {ask.why && showWhy ? <p className="chat-ask-why">{ask.why}</p> : null}
                  {answered !== undefined ? (
                    <p className="chat-ask-sent text-success" role="status"><Check className="size-3.5" aria-hidden="true" /> Sent “{answered}”</p>
                  ) : (
                    <div className="chat-ask-options">
                      {ask.options.map((option, index) => (
                        <Button key={option} size="xs" variant={index === ask.recommend ? 'default' : 'outline'} disabled={disabled}
                          title={index === ask.recommend ? 'Recommended by the agent' : undefined}
                          onClick={() => answer(ask, option)}>
                          {option}{index === ask.recommend ? ' (recommended)' : ''}
                        </Button>
                      ))}
                      <Button size="xs" variant="ghost-muted" onClick={() => onReply(ask)}>Reply…</Button>
                    </div>
                  )}
                  {ask.why || anchored.has(ask.key) || ask.link ? (
                    <div className="chat-ask-links">
                      {ask.why ? (
                        <button type="button" aria-expanded={showWhy} onClick={() => setWhyOpen((current) => {
                          const next = new Set(current)
                          if (!next.delete(ask.key)) next.add(ask.key)
                          return next
                        })}>{showWhy ? 'Hide why' : 'Why it matters'}</button>
                      ) : null}
                      {anchored.has(ask.key) ? <button type="button" onClick={() => onJump(ask)}>Jump to where I asked <ArrowUp className="size-3" aria-hidden="true" /></button> : null}
                      {ask.link ? <a href={ask.link} target="_blank" rel="noopener noreferrer">Open link <ExternalLink className="size-3" aria-hidden="true" /></a> : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronUp, Send, X } from 'lucide-react'
import type { ChatProvider } from '../../shared/agent-chat'
import { RELAY_MAX_CHARS, type CommanderRelay } from '../../shared/commander'
import type { CommanderInboxRow, InboxGroup } from '../commanderInbox'
import { createCommanderApi, type CommanderTranscript } from '../commanderApi'
import { StateIcon } from './AgentsInbox'
import { ChatTimeline } from './ChatTimeline'
import { cn } from './cn'
import { Button } from './ui/button'

/** Below this width the reading pane takes over Commander's column instead of sitting beside it. */
export const READING_PANE_SPLIT_WIDTH = 900

export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

export type CommanderPeek = {
  row: CommanderInboxRow
  group: InboxGroup
  /** The agent's chat (or transcript) shown below the header. */
  view: ReactNode
  onClose: () => void
  onOpen: () => void
  /** Steps to the previous (-1) or next (1) agent in the inbox. */
  onStep: (direction: -1 | 1) => void
}

/** Commander's column and, beside it or over it, the selected agent's chat. */
export function CommanderSplit({ peek, children }: { peek?: CommanderPeek; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const width = useElementWidth(root)
  const split = width >= READING_PANE_SPLIT_WIDTH
  return <div ref={root} className="commander-split flex min-h-0 min-w-0" data-testid="commander-split" data-mode={peek ? split ? 'split' : 'full' : 'closed'}>
    {/* Over Commander, its column stays in the layout (invisible, zero width) because a lone pane takes its height from the chat. */}
    <div className={cn('flex min-h-0 min-w-0 flex-col', !peek ? 'flex-1' : split ? 'flex-1 max-w-[45%] border-r border-border' : 'invisible w-0 flex-none overflow-hidden')} aria-hidden={peek && !split ? true : undefined}>{children}</div>
    {peek ? <ReadingPane peek={peek} full={!split} /> : null}
  </div>
}

function ReadingPane({ peek, full }: { peek: CommanderPeek; full: boolean }) {
  const { row, group } = peek
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Esc closes the pane unless something inside it used it. In a message box it
    // keeps its chat meaning (stopping a running turn), so it never closes from there.
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return
    event.preventDefault()
    peek.onClose()
  }
  return <section className="commando-chat flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label={`${row.title} chat`} data-testid="commander-reading-pane" onKeyDown={onKeyDown}>
    <header className="@container flex min-w-0 items-center gap-1.5 border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
      {full ? <Button size="xs" variant="ghost-muted" onClick={peek.onClose} aria-label="Back to Commander"><ArrowLeft aria-hidden="true" />Commander</Button> : null}
      <StateIcon group={group} row={row} />
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{row.title}</span>
      <span className="hidden min-w-0 truncate @[520px]:inline">{row.sessionName}</span>
      <span className="flex-1" />
      <Button size="icon-xs" variant="ghost-muted" onClick={() => peek.onStep(-1)} aria-label="Previous agent" title="Previous agent"><ChevronUp aria-hidden="true" /></Button>
      <Button size="icon-xs" variant="ghost-muted" onClick={() => peek.onStep(1)} aria-label="Next agent" title="Next agent"><ChevronDown aria-hidden="true" /></Button>
      <Button size="xs" variant="outline" onClick={peek.onOpen} title="Open its session"><ArrowUpRight aria-hidden="true" />Open in session</Button>
      {full ? null : <Button size="icon-xs" variant="ghost-muted" onClick={peek.onClose} aria-label="Close" title="Close"><X aria-hidden="true" /></Button>}
    </header>
    <div className="commander-reading-body flex min-h-0 flex-1 flex-col">{peek.view}</div>
  </section>
}

type TranscriptState = { loading: boolean; result?: CommanderTranscript; error?: string }

/**
 * A terminal agent's saved transcript, read-only, refreshed when its turn
 * changes. Messages are relayed and wait for the agent's turn to end.
 */
export function CommanderTranscriptView({ token, row, provider, cwd, refreshKey, disabled, onRelay }: {
  token: string
  row: CommanderInboxRow
  provider: ChatProvider
  cwd: string
  /** Changes when the agent's turn starts or ends. */
  refreshKey: string
  disabled?: boolean
  onRelay: (relay: CommanderRelay) => void
}) {
  const [state, setState] = useState<TranscriptState>({ loading: true })
  useEffect(() => {
    let live = true
    setState((current) => ({ ...current, loading: true }))
    createCommanderApi(token).transcript(row.paneId).then(
      (result) => { if (live) setState({ loading: false, result }) },
      (cause: unknown) => { if (live) setState((current) => ({ ...current, loading: false, error: cause instanceof Error ? cause.message : 'Unable to read the transcript' })) },
    )
    return () => { live = false }
  }, [token, row.paneId, refreshKey])
  const { result, error, loading } = state
  return <>
    {result?.source === 'transcript'
      ? <ChatTimeline provider={provider} items={result.items} cwd={cwd} working={row.status === 'working'} controlsDisabled />
      : result?.source === 'screen'
        ? <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-secondary-label">{result.screen || 'The pane is empty.'}</pre>
        : <div className="min-h-0 flex-1 px-4 py-3 text-sm text-muted-foreground" role="status">{loading ? 'Loading the transcript…' : null}</div>}
    {error ? <div role="alert" className="px-4 pb-1 text-xs text-destructive">{error}</div> : null}
    <div className="px-4 pb-1 text-2xs text-muted-foreground">
      {result?.source === 'screen' ? "No transcript found; showing the pane's screen." : 'Read-only transcript; it refreshes when the turn changes.'} Messages wait for the agent's turn to end.
    </div>
    <RelayComposer token={token} row={row} disabled={disabled} onRelay={onRelay} />
  </>
}

function RelayComposer({ token, row, disabled, onRelay }: { token: string; row: CommanderInboxRow; disabled?: boolean; onRelay: (relay: CommanderRelay) => void }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const send = async () => {
    if (disabled || sending || !text.trim()) return
    setSending(true)
    setError('')
    try {
      onRelay(await createCommanderApi(token).relay(row.paneId, text))
      setText('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to send the message')
    } finally {
      setSending(false)
    }
  }
  return <>
    {error ? <div role="alert" className="px-4 pb-1 text-xs text-destructive">{error}</div> : null}
    <form className="mx-4 mb-3 flex items-end gap-1.5 rounded-lg border border-input bg-card p-1.5 focus-within:border-primary" onSubmit={(event) => { event.preventDefault(); void send() }}>
    <textarea rows={1} aria-label={`Message ${row.title}`} placeholder={`Message ${row.title}…`} value={text} maxLength={RELAY_MAX_CHARS} disabled={disabled || sending}
      className="max-h-40 min-h-7 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
      }} />
    <Button type="submit" size="icon-sm" disabled={disabled || sending || !text.trim()} aria-label="Send message"><Send aria-hidden="true" /></Button>
  </form>
  </>
}

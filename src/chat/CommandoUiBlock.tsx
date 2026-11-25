import { createContext, use, useEffect, useMemo, useRef, useState } from 'react'
import { Check, CircleCheck, Circle } from 'lucide-react'
import type { ChatItem } from '../../shared/agent-chat'
import {
  COMMANDO_UI_LIMITS, formatApproveAnswer, formatChoiceAnswer, parseCommandoUi, settledAnswer,
  type ApproveVerdict, type CommandoUiBlock as Block,
} from '../../shared/commando-ui'
import { cn } from './cn'
import { Button } from './ui/button'

/** Where the user's messages sit among the assistant replies, by position in the timeline rather than by clock. */
export type AnswerPositions = { replyOrder: ReadonlyMap<string, number>; userMessages: readonly { text: string; order: number }[] }
const NO_POSITIONS: AnswerPositions = { replyOrder: new Map(), userMessages: [] }

/** What a block needs to answer: the pane's send path, the transcript to find its answer in, and answers queued but not yet sent. */
export type CommandoUiActions = {
  /** Sends the answer; returns the request id the host's refusal would name. */
  onAnswer?: (text: string) => string | void
  positions: AnswerPositions
  queued: readonly string[]
  /** Request ids of sends the host refused. */
  refused: readonly string[]
}
export const CommandoUiActionsContext = createContext<CommandoUiActions>({ positions: NO_POSITIONS, queued: [], refused: [] })

/** How long a queued answer may be out of the queue before it shows up as a message; past that it was taken back. */
const QUEUE_GRACE_MS = 1500

/** The reply a block sits in. Only an assistant reply's blocks are live; `running` means its JSON may be half-written. */
export const CommandoUiReplyContext = createContext<{ itemId?: string; answerable: boolean; running?: boolean }>({ answerable: false })

/** Positions from the items; the previous object is kept while the user and assistant messages are unchanged, so streaming flushes don't re-render blocks. */
export function stableAnswerPositions(previous: AnswerPositions & { keys?: readonly string[] }, items: readonly ChatItem[]): AnswerPositions & { keys: readonly string[] } {
  const keys: string[] = []
  for (const item of items) {
    if (item.kind === 'assistant_message') keys.push(`a\0${item.id}`)
    else if (item.kind === 'user_message') keys.push(`u\0${item.text.trim()}`)
  }
  if (previous.keys && previous.keys.length === keys.length && previous.keys.every((key, i) => key === keys[i])) return previous as AnswerPositions & { keys: readonly string[] }
  const replyOrder = new Map<string, number>()
  const userMessages: { text: string; order: number }[] = []
  keys.forEach((key, order) => {
    if (key[0] === 'a') replyOrder.set(key.slice(2), order)
    else userMessages.push({ text: key.slice(2), order })
  })
  return { replyOrder, userMessages, keys }
}

/** A fenced `commando-ui` block: our own components from validated JSON, or the plain code when it isn't valid. */
export function CommandoUiFence({ source }: { source: string }) {
  const { running } = use(CommandoUiReplyContext)
  const parsed = parseCommandoUi(source)
  if (parsed.ok) {
    return <div className="chat-ui" data-testid="commando-ui">{parsed.blocks.map((block, index) => <UiBlock key={index} block={block} />)}</div>
  }
  const code = <pre><code>{source}</code></pre>
  // While the reply streams, half-written JSON is expected; only a finished one is worth flagging.
  if (running && parsed.incomplete) return code
  return <>{code}<p className="chat-ui-invalid">Invalid commando-ui block: {parsed.reason}</p></>
}

function UiBlock({ block }: { block: Block }) {
  switch (block.component) {
    case 'choice': return <ChoiceBlock block={block} />
    case 'approve': return <ApproveBlock block={block} />
    case 'checklist': return <ChecklistBlock block={block} />
    case 'table': return <TableBlock block={block} />
    case 'stats': return <StatsBlock block={block} />
  }
}

/** The answer already given (found in the transcript or queue) or just sent from this block, and whether answering is possible. */
function useAnswer(block: Block) {
  const { onAnswer, positions, queued, refused } = use(CommandoUiActionsContext)
  const { itemId, answerable } = use(CommandoUiReplyContext)
  const [sent, setSent] = useState<{ label: string; text: string; id?: string }>()
  const wasQueued = useRef(false)
  const settled = useMemo(() => {
    const order = itemId === undefined ? undefined : positions.replyOrder.get(itemId)
    if (order === undefined) return settledAnswer(block, queued)
    return settledAnswer(block, [...positions.userMessages.filter((message) => message.order > order).map((message) => message.text), ...queued])
  }, [block, itemId, positions, queued])
  // The optimistic "Sent" holds while the send is in flight, queued or settled; a refusal or a queued answer taken back clears it.
  useEffect(() => {
    if (!sent) { wasQueued.current = false; return }
    if (sent.id !== undefined && refused.includes(sent.id)) { setSent(undefined); return }
    if (queued.includes(sent.text)) { wasQueued.current = true; return }
    if (!wasQueued.current || settled !== undefined) return
    const timer = setTimeout(() => setSent(undefined), QUEUE_GRACE_MS)
    return () => clearTimeout(timer)
  }, [sent, queued, refused, settled])
  const answer = settled ?? sent?.label
  return { answer, disabled: answer !== undefined || !onAnswer || !answerable, send: (text: string, label: string) => {
    const id = onAnswer?.(text)
    setSent({ label, text: text.trim(), ...(typeof id === 'string' ? { id } : {}) })
  } }
}

function Settled({ answer }: { answer: string }) {
  return <div className="chat-ui-foot" data-testid="commando-ui-settled"><Check aria-hidden="true" className="size-3" />Sent · {answer}</div>
}

/** Blocks outside a reply (a thought, a plan) show their question but take no answers. */
function ReadOnlyAsk({ prompt, labels }: { prompt: string; labels: readonly string[] }) {
  return (
    <div className="chat-ui-card">
      <div className="chat-ui-title">{prompt}</div>
      <ul className="chat-ui-readonly">{labels.map((label) => <li key={label}>{label}</li>)}</ul>
    </div>
  )
}

function ChoiceBlock({ block }: { block: Extract<Block, { component: 'choice' }> }) {
  const { answerable } = use(CommandoUiReplyContext)
  return answerable ? <LiveChoice block={block} /> : <ReadOnlyAsk prompt={block.prompt} labels={block.options} />
}

function LiveChoice({ block }: { block: Extract<Block, { component: 'choice' }> }) {
  const { answer, disabled, send } = useAnswer(block)
  const [picked, setPicked] = useState<readonly string[]>([])
  return (
    <div className="chat-ui-card" role="group" aria-label={block.prompt}>
      <div className="chat-ui-title">{block.prompt}</div>
      <div className="chat-ui-options">
        {block.options.map((option) => {
          const on = block.multiple ? picked.includes(option) : answer === option
          return (
            <Button key={option} size="sm" variant="outline" disabled={disabled} aria-pressed={block.multiple ? on : undefined}
              className={cn('chat-ui-option h-auto min-h-7 whitespace-normal text-left', on && 'chat-ui-selected')}
              onClick={() => block.multiple
                ? setPicked((current) => current.includes(option) ? current.filter((entry) => entry !== option) : [...current, option])
                : send(formatChoiceAnswer(block, [option]), option)}>
              {option}
            </Button>
          )
        })}
      </div>
      {block.multiple && answer === undefined ? (
        <div><Button size="sm" disabled={disabled || picked.length === 0} onClick={() => send(formatChoiceAnswer(block, picked), block.options.filter((o) => picked.includes(o)).join(', '))}>Send</Button></div>
      ) : null}
      {answer !== undefined ? <Settled answer={answer} /> : null}
    </div>
  )
}

function ApproveBlock({ block }: { block: Extract<Block, { component: 'approve' }> }) {
  const { answerable } = use(CommandoUiReplyContext)
  return answerable ? <LiveApprove block={block} /> : <ReadOnlyAsk prompt={block.prompt} labels={[block.approveLabel, block.rejectLabel]} />
}

function LiveApprove({ block }: { block: Extract<Block, { component: 'approve' }> }) {
  const { answer, disabled, send } = useAnswer(block)
  const [note, setNote] = useState('')
  const decide = (verdict: ApproveVerdict) => send(formatApproveAnswer(block, verdict, note), verdict === 'Approved' ? block.approveLabel : block.rejectLabel)
  return (
    <div className="chat-ui-card" role="group" aria-label={block.prompt}>
      <div className="chat-ui-title">{block.prompt}</div>
      {answer === undefined ? (
        <input className="chat-ui-note" type="text" placeholder="Add a note (optional)" aria-label="Note" maxLength={COMMANDO_UI_LIMITS.note}
          value={note} disabled={disabled} onChange={(event) => setNote(event.target.value)} />
      ) : null}
      <div className="chat-ui-options">
        <Button size="sm" disabled={disabled} onClick={() => decide('Approved')}>{block.approveLabel}</Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => decide('Rejected')}>{block.rejectLabel}</Button>
      </div>
      {answer !== undefined ? <Settled answer={answer} /> : null}
    </div>
  )
}

function ChecklistBlock({ block }: { block: Extract<Block, { component: 'checklist' }> }) {
  const done = block.items.filter((item) => item.done).length
  return (
    <div className="chat-ui-card">
      <div className="chat-ui-title">{block.title ?? 'Checklist'}<span className="chat-ui-count">{done}/{block.items.length}</span></div>
      <ul className="chat-ui-checklist">
        {block.items.map((item, index) => (
          <li key={index} data-done={item.done}>
            {item.done ? <CircleCheck aria-label="Done" className="size-4 text-[var(--green)]" /> : <Circle aria-label="Not done" className="size-4 text-muted-foreground" />}
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TableBlock({ block }: { block: Extract<Block, { component: 'table' }> }) {
  return (
    <div className="chat-table-scroll chat-ui-table">
      <div className="chat-table-frame">
        <table>
          <thead><tr>{block.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {block.truncatedRows > 0 ? <div className="chat-ui-foot">+{block.truncatedRows} more rows not shown</div> : null}
    </div>
  )
}

function StatsBlock({ block }: { block: Extract<Block, { component: 'stats' }> }) {
  return (
    <div className="chat-ui-stats">
      {block.items.map((item, index) => (
        <div key={index} className="chat-ui-stat">
          <div className="chat-ui-stat-label">{item.label}</div>
          <div className="chat-ui-stat-value">{item.value}</div>
          {item.delta ? <div className="chat-ui-stat-delta" data-tone={item.tone}>{item.delta}</div> : null}
        </div>
      ))}
    </div>
  )
}

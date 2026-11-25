import { createContext, use, useMemo, useState } from 'react'
import { Check, CircleCheck, Circle } from 'lucide-react'
import {
  COMMANDO_UI_LIMITS, formatApproveAnswer, formatChoiceAnswer, parseCommandoUi, settledAnswer,
  type ApproveVerdict, type CommandoUiBlock as Block, type UserMessageRef,
} from '../../shared/commando-ui'
import { cn } from './cn'
import { Button } from './ui/button'

/** What a block needs to answer: the pane's send path, and the user's messages to find its answer in. */
export type CommandoUiActions = { onAnswer?: (text: string) => void; userMessages: readonly UserMessageRef[] }
export const CommandoUiActionsContext = createContext<CommandoUiActions>({ userMessages: [] })

/** The reply a block sits in: its time orders answers after it, and `running` means its JSON may be half-written. */
export const CommandoUiReplyContext = createContext<{ createdAt: number; running?: boolean }>({ createdAt: 0 })

/** Keeps the previous list while the user's messages are unchanged, so streaming flushes don't re-render blocks. */
export function stableUserMessages(previous: readonly UserMessageRef[], next: readonly UserMessageRef[]): readonly UserMessageRef[] {
  return previous.length === next.length && previous.every((entry, i) => entry.text === next[i]!.text && entry.createdAt === next[i]!.createdAt) ? previous : next
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

/** The answer already given (found in the transcript) or just sent from this block, and whether answering is possible. */
function useAnswer(block: Block) {
  const { onAnswer, userMessages } = use(CommandoUiActionsContext)
  const { createdAt } = use(CommandoUiReplyContext)
  const [sent, setSent] = useState<string>()
  const settled = useMemo(() => settledAnswer(block, createdAt, userMessages), [block, createdAt, userMessages])
  const answer = settled ?? sent
  return { answer, disabled: answer !== undefined || !onAnswer, send: (text: string, label: string) => { setSent(label); onAnswer?.(text) } }
}

function Settled({ answer }: { answer: string }) {
  return <div className="chat-ui-foot" data-testid="commando-ui-settled"><Check aria-hidden="true" className="size-3" />Sent · {answer}</div>
}

function ChoiceBlock({ block }: { block: Extract<Block, { component: 'choice' }> }) {
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
  const { answer, disabled, send } = useAnswer(block)
  const [note, setNote] = useState('')
  const decide = (verdict: ApproveVerdict) => send(formatApproveAnswer(block, verdict, note), verdict === 'Approved' ? block.approveLabel : block.rejectLabel)
  return (
    <div className="chat-ui-card" role="group" aria-label={block.prompt}>
      <div className="chat-ui-title">{block.prompt}</div>
      {answer === undefined ? (
        <input className="chat-ui-note" type="text" placeholder="Add a note (optional)" aria-label="Note" maxLength={COMMANDO_UI_LIMITS.note}
          value={note} disabled={disabled} onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !disabled) decide('Approved') }} />
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

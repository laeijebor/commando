import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Brain, ChevronRight, CircleAlert, FilePen, Info, LoaderCircle, MessageCircleQuestion, Search, ShieldCheck, ShieldX, SquareTerminal, Wrench } from 'lucide-react'
import type { ChatItem } from '../../shared/agent-chat'
import { cn } from './cn'
import { deriveTimelineRows, patchLines, shortPath, type TimelineRow, type WorkItem } from './timelineRows'
import { WorkLogBlock, WorkLogDetails, WorkLogList, WorkLogRow } from './WorkLog'

const markdownPlugins = [remarkGfm]

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={markdownPlugins} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
        {text}
      </ReactMarkdown>
    </div>
  )
})



function WorkIcon({ item }: { item: WorkItem }) {
  const className = cn('size-3.5', item.status === 'running' ? 'text-primary' : item.status === 'failed' ? 'text-destructive' : 'text-icon-muted')
  if (item.status === 'running' && item.kind !== 'reasoning') return <LoaderCircle className={cn(className, 'animate-spin')} aria-hidden="true" />
  switch (item.kind) {
    case 'command': return <SquareTerminal className={className} aria-hidden="true" />
    case 'file_change': return <FilePen className={className} aria-hidden="true" />
    case 'reasoning': return <Brain className={cn(className, item.status === 'running' && 'chat-pulse')} aria-hidden="true" />
    case 'request': if (item.requestKind === 'question') return <MessageCircleQuestion className={className} aria-hidden="true" />
      return item.answer?.kind === 'approval' && item.answer.decision !== 'deny'
      ? <ShieldCheck className={className} aria-hidden="true" />
      : <ShieldX className={className} aria-hidden="true" />
    default: return item.toolName === 'Grep' || item.toolName === 'Glob' || item.toolName === 'WebSearch'
      ? <Search className={className} aria-hidden="true" />
      : <Wrench className={className} aria-hidden="true" />
  }
}

function workLabel(item: WorkItem, cwd: string) {
  switch (item.kind) {
    case 'command':
      return <span className="font-mono text-xs text-foreground">{item.command || 'Running a command'}</span>
    case 'file_change':
      return (
        <span>
          {item.toolName === 'Write' ? 'Wrote ' : 'Edited '}
          <span className="font-mono text-xs text-foreground">{shortPath(item.path, cwd)}</span>
        </span>
      )
    case 'reasoning':
      return item.status === 'running' ? 'Thinking…' : 'Thought'
    case 'request': {
      const answer = item.answer
      if (answer?.kind === 'approval') return `${answer.decision === 'deny' ? 'Denied' : answer.decision === 'allow_always' ? 'Always allowed' : 'Allowed'} ${item.toolName}`
      if (answer?.kind === 'question') return `Answered: ${Object.values(answer.answers).join(' · ')}`
      return `${item.title} (cancelled)`
    }
    default:
      return shortPath(item.title, cwd)
  }
}

function hasDetails(item: WorkItem): boolean {
  switch (item.kind) {
    case 'command': return Boolean(item.output)
    case 'file_change': return Boolean(item.patch || item.output)
    case 'reasoning': return Boolean(item.text)
    case 'tool': return Boolean(item.detail || item.output)
    default: return false
  }
}

function PatchView({ patch }: { patch: string }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card py-1 font-mono text-xs leading-5">
      {patchLines(patch).map((line, index) => (
        <div
          key={index}
          className={cn(
            'whitespace-pre px-2',
            line.kind === 'add' && 'bg-diff-addition text-diff-addition-foreground',
            line.kind === 'del' && 'bg-diff-deletion text-diff-deletion-foreground',
            line.kind === 'gap' && 'text-muted-foreground',
          )}
        >
          {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}{line.text}
        </div>
      ))}
    </div>
  )
}

function Output({ text }: { text: string }) {
  return <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card px-2 py-1.5 font-mono text-xs leading-5 text-secondary-label">{text}</pre>
}

function WorkDetails({ item }: { item: WorkItem }) {
  switch (item.kind) {
    case 'command':
      return <WorkLogDetails>{item.output ? <Output text={item.output} /> : null}</WorkLogDetails>
    case 'file_change':
      return <WorkLogDetails>{item.patch ? <PatchView patch={item.patch} /> : null}{item.isError && item.output ? <Output text={item.output} /> : null}</WorkLogDetails>
    case 'reasoning':
      return <WorkLogDetails><div className="text-sm text-muted-foreground"><Markdown text={item.text} /></div></WorkLogDetails>
    case 'tool':
      return <WorkLogDetails>{item.detail ? <Output text={item.detail} /> : null}{item.output ? <Output text={item.output} /> : null}</WorkLogDetails>
    default:
      return null
  }
}

function WorkEntry({ item, cwd }: { item: WorkItem; cwd: string }) {
  const [open, setOpen] = useState(false)
  const expandable = hasDetails(item)
  const trailing = item.kind === 'file_change'
    ? <span className="shrink-0 font-mono text-2xs"><span className="text-success">+{item.additions}</span> <span className="text-destructive">−{item.deletions}</span></span>
    : item.kind === 'command' && item.isError
      ? <span className="shrink-0 text-2xs text-destructive">failed</span>
      : null
  return (
    <WorkLogRow
      icon={<WorkIcon item={item} />}
      label={workLabel(item, cwd)}
      trailing={trailing}
      aria-expanded={expandable ? open : undefined}
      {...(expandable ? { onClick: () => setOpen((value) => !value), role: 'button', tabIndex: 0, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((value) => !value) } } } : {})}
    >
      {open ? <WorkDetails item={item} /> : null}
    </WorkLogRow>
  )
}

function WorkGroup({ row, cwd }: { row: Extract<TimelineRow, { kind: 'work' }>; cwd: string }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  // Live groups show their rows; finished ones fold to a summary unless opened.
  const open = userOpen ?? row.live
  const single = row.items.length === 1
  if (single) {
    return <WorkLogBlock><WorkEntry item={row.items[0]!} cwd={cwd} /></WorkLogBlock>
  }
  return (
    <WorkLogBlock>
      <button
        type="button"
        className="group flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-0.5 text-left text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        <span className="flex size-6 shrink-0 items-center justify-center">
          {row.live ? <LoaderCircle className="size-3.5 animate-spin text-primary" aria-hidden="true" /> : <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{row.summary}</span>
      </button>
      {open ? (
        <div className="ms-3 border-s border-border ps-2">
          <WorkLogList>
            {row.items.map((item) => <WorkEntry key={item.id} item={item} cwd={cwd} />)}
          </WorkLogList>
        </div>
      ) : null}
    </WorkLogBlock>
  )
}

function Row({ row, cwd }: { row: TimelineRow; cwd: string }) {
  switch (row.kind) {
    case 'user':
      return (
        <div className="flex justify-end pb-3 pt-1">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-border bg-message px-3.5 py-2 text-base text-foreground">
            {row.item.text}
          </div>
        </div>
      )
    case 'assistant':
      return <div className="pb-3"><Markdown text={row.item.text} /></div>
    case 'work':
      return <WorkGroup row={row} cwd={cwd} />
    case 'notice':
      return (
        <div className={cn('flex items-start gap-1.5 pb-2 text-xs', row.item.level === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {row.item.level === 'error' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
          <span className="whitespace-pre-wrap break-words">{row.item.text}</span>
        </div>
      )
  }
}

export function ChatTimeline({ items, cwd, working }: { items: readonly ChatItem[]; cwd: string; working: boolean }) {
  const rows = useMemo(() => deriveTimelineRows(items), [items])
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [rows, working])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const onScroll = () => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  const last = rows.at(-1)
  const streaming = last?.kind === 'assistant' && last.item.status === 'running'
  const liveWork = last?.kind === 'work' && last.live
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4" data-testid="chat-timeline">
      <div className="mx-auto w-full max-w-[var(--chat-content-max-width)]">
        {rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Ask Claude anything about this folder.</div>
        ) : rows.map((row) => <Row key={row.id} row={row} cwd={cwd} />)}
        {working && !streaming && !liveWork ? (
          <div className="flex items-center gap-1.5 pb-3 text-sm text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary chat-pulse" aria-hidden="true" />
            Working…
          </div>
        ) : null}
      </div>
    </div>
  )
}

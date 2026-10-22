import { createContext, memo, use, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronRight, CircleAlert, Diamond, FilePen, Info, ListChecks, LoaderCircle, MessageCircleQuestion, MessageSquareShare, Search, ShieldCheck, ShieldX, SquareTerminal, Wrench, Rabbit } from 'lucide-react'
import { PLAN_IMPLEMENTATION_PREFIX, chatPlanTitle, type ChatItem, type ChatProvider, type ChatReplyImage, type ChatTaskAction } from '../../shared/agent-chat'
import { ImageStrip } from './ChatImages'
import { cn } from './cn'
import { providerLabel } from './ComposerControls'
import { MarkdownPre } from '../MarkdownCode'
import { PlanCard, type SavePlan } from './PlanCard'
import { ReplyImage } from './ReplyImage'
import { SubagentGroup, useNow } from './Subagents'
import { TileEventCard } from './TileEventCard'
import { activitySummary, deriveTimelineRows, isWork, mergeActivityRows, patchLines, shortPath, thoughtLabel, type ActivityRow, type ActivitySummary, type QuietTimelineRow, type ReasoningItem, type SubagentItem, type WorkItem } from '../../shared/chat-timeline'
import { elapsedLabel } from './turnFlow'
import { WorkLogDetails, WorkLogList, WorkLogRow } from './WorkLog'

const markdownPlugins = [remarkGfm]
const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  pre: MarkdownPre,
  // Wide tables scroll sideways; the frame lets a reply's table grow past the text column.
  table: ({ node: _node, ...props }) => <div className="chat-table-scroll"><div className="chat-table-frame"><table {...props} /></div></div>,
}

/** What rows need beyond their own item: the whole list, the clock and the pane's actions. */
const TimelineContext = createContext<{ items: readonly ChatItem[]; now: number; provider: string; onOpenSubagent?: (toolUseId: string) => void; onSavePlan?: SavePlan; onTask?: (action: ChatTaskAction, agent: SubagentItem) => void; controlsDisabled?: boolean; onOpenTile?: (webPaneId: string) => boolean }>({ items: [], now: 0, provider: 'Claude' })

/** Image addresses reach `ReplyImage` as written: it decides what loads, and a local path is never a link. */
const keepImageSources: UrlTransform = (url, key, node) => key === 'src' && node.tagName === 'img' ? url : defaultUrlTransform(url)

/** The reply a Markdown image belongs to; context keeps `img` one component, so images don't reload as a reply streams. */
const ReplyImagesContext = createContext<{ images?: readonly ChatReplyImage[]; running?: boolean }>({})

function MarkdownImage({ src, alt }: { src?: unknown; alt?: string }) {
  const { images, running } = use(ReplyImagesContext)
  return <ReplyImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} images={images} running={running} />
}

const replyComponents: Components = { ...markdownComponents, img: MarkdownImage }

/** `images` are the local files a reply shows; `running` while it still streams. */
export const Markdown = memo(function Markdown({ text, images, running }: { text: string; images?: readonly ChatReplyImage[]; running?: boolean }) {
  const reply = useMemo(() => ({ images, running }), [images, running])
  return (
    <ReplyImagesContext value={reply}>
      <div className="chat-markdown">
        <ReactMarkdown remarkPlugins={markdownPlugins} components={replyComponents} urlTransform={keepImageSources}>
          {text}
        </ReactMarkdown>
      </div>
    </ReplyImagesContext>
  )
})

function WorkIcon({ item }: { item: WorkItem }) {
  const className = cn('size-3.5', item.status === 'running' ? 'text-primary' : item.status === 'failed' ? 'text-destructive' : 'text-icon-muted')
  if (item.status === 'running') return <LoaderCircle className={cn(className, 'animate-spin')} aria-hidden="true" />
  switch (item.kind) {
    case 'command': return <SquareTerminal className={className} aria-hidden="true" />
    case 'file_change': return <FilePen className={className} aria-hidden="true" />
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
    case 'tool': return Boolean(item.detail || item.output || item.images?.length)
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
    case 'tool':
      return (
        <WorkLogDetails>
          {item.detail ? <Output text={item.detail} /> : null}
          {item.images?.length ? <ImageStrip images={item.images} /> : null}
          {item.output ? <Output text={item.output} /> : null}
        </WorkLogDetails>
      )
    default:
      return null
  }
}

/** Row props that open and close a div-based disclosure from the mouse or keyboard. */
function disclosure(toggle: () => void) {
  return { onClick: toggle, role: 'button', tabIndex: 0, onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() } } }
}

function DiffCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="shrink-0 font-mono text-2xs"><span className="text-success">+{additions}</span> <span className="text-destructive">−{deletions}</span></span>
}

function WorkEntry({ item, cwd, defaultOpen = false }: { item: WorkItem; cwd: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const expandable = hasDetails(item)
  const trailing = item.kind === 'file_change'
    ? <DiffCounts additions={item.additions} deletions={item.deletions} />
    : item.kind === 'command' && item.isError
      ? <span className="shrink-0 text-2xs text-destructive">failed</span>
      : null
  return (
    <WorkLogRow
      icon={<WorkIcon item={item} />}
      label={workLabel(item, cwd)}
      trailing={trailing}
      aria-expanded={expandable ? open : undefined}
      {...(expandable ? disclosure(() => setOpen((value) => !value)) : {})}
    >
      {open ? <WorkDetails item={item} /> : null}
    </WorkLogRow>
  )
}

/** Claude's thinking inside an opened stretch: "Thought for 14s", opening to the text. */
function ThoughtEntry({ item, defaultOpen = false }: { item: ReasoningItem; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const expandable = Boolean(item.text)
  return (
    <WorkLogRow
      icon={<Diamond className={cn('size-3 text-primary', item.status === 'running' && 'chat-pulse')} aria-hidden="true" />}
      label={<span className="italic text-muted-foreground">{thoughtLabel(item)}</span>}
      aria-expanded={expandable ? open : undefined}
      {...(expandable ? disclosure(() => setOpen((value) => !value)) : {})}
    >
      {open ? (
        <WorkLogDetails>
          <div className="chat-thought italic text-muted-foreground"><Markdown text={item.text} /></div>
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  )
}

function SummaryText({ summary }: { summary: ActivitySummary }) {
  return (
    <>
      {summary.edits ? <>{summary.edits.label} <DiffCounts additions={summary.edits.additions} deletions={summary.edits.deletions} /></> : null}
      {summary.edits && summary.rest ? ', ' : null}
      {summary.rest}
    </>
  )
}

/**
 * Everything between two messages as one faint line, so the conversation
 * reads on its own. It brightens on hover and opens to every step in order.
 * While live it names the step running now; failures always show.
 */
function ActivityGroup({ row, cwd }: { row: ActivityRow; cwd: string }) {
  const { now } = use(TimelineContext)
  const [open, setOpen] = useState(false)
  const current = row.live ? [...row.items].reverse().find((item) => item.status === 'running') : undefined
  const summary = activitySummary(row.items, row.live ? now : undefined)
  const done = row.items.filter((item) => item !== current)
  const work = row.items.filter(isWork)
  // A lone step opens already showing its output, diff or thinking.
  const lone = row.items.length === 1 ? row.items[0]! : undefined
  const expandable = !lone || (isWork(lone) ? hasDetails(lone) : Boolean(lone.text))
  let label: ReactNode
  if (current) {
    label = (
      <>
        {current.kind === 'reasoning' ? thoughtLabel(current) : workLabel(current, cwd)}
        {done.some(isWork) ? <> · <SummaryText summary={activitySummary(done)} /></> : null}
      </>
    )
  } else if (work.length === 1) {
    const only = work[0]!
    label = <>{workLabel(only, cwd)}{only.kind === 'file_change' ? <> <DiffCounts additions={only.additions} deletions={only.deletions} /></> : null}</>
  } else {
    label = <SummaryText summary={summary} />
  }
  const line = (
    <>
      <span className="flex size-3 shrink-0 items-center justify-center">
        {current ? <LoaderCircle className="size-3 animate-spin text-primary" aria-hidden="true" /> : <span className="size-1 rounded-full bg-current" aria-hidden="true" />}
      </span>
      <span className="min-w-0 truncate">
        {label}
        {summary.failed ? <span className="text-destructive"> · {summary.failed} failed</span> : null}
        {summary.elapsedMs !== null ? ` · ${elapsedLabel(summary.elapsedMs)}` : null}
      </span>
      {expandable ? <ChevronRight className={cn('size-3 shrink-0 opacity-0 transition group-hover/activity:opacity-100', open && 'rotate-90 opacity-100')} aria-hidden="true" /> : null}
    </>
  )
  const lineClassName = cn(
    'flex min-h-5 w-full min-w-0 items-center gap-2 rounded-md text-left text-xs transition-colors [&_.text-foreground]:text-inherit',
    open || current ? 'text-muted-foreground' : 'text-faint',
    expandable && 'hover:text-muted-foreground',
  )
  return (
    <div className="group/activity -mt-1 pb-3">
      {expandable
        ? <button type="button" className={lineClassName} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{line}</button>
        : <div className={lineClassName}>{line}</div>}
      {open ? (
        <div className="ms-1.5 mt-1 border-s border-border ps-2">
          <WorkLogList>
            {row.items.map((item) => item.kind === 'reasoning'
              ? <ThoughtEntry key={item.id} item={item} defaultOpen={item === lone} />
              : <WorkEntry key={item.id} item={item} cwd={cwd} defaultOpen={item === lone} />)}
          </WorkLogList>
        </div>
      ) : null}
    </div>
  )
}

/** "Implement this plan" messages carry the whole plan; it is already on the card above. */
function UserText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text.startsWith(PLAN_IMPLEMENTATION_PREFIX)) return <>{text}</>
  const plan = text.slice(PLAN_IMPLEMENTATION_PREFIX.length)
  return (
    <>
      <button type="button" className="flex cursor-pointer items-center gap-1.5 text-left" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ListChecks className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        Implement the plan: {chatPlanTitle(plan)}
        <ChevronRight className={cn('size-3 shrink-0 text-icon-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />
      </button>
      {open ? <div className="mt-1.5 text-sm text-secondary-label">{plan}</div> : null}
    </>
  )
}

function Row({ row, cwd }: { row: QuietTimelineRow; cwd: string }) {
  const context = use(TimelineContext)
  switch (row.kind) {
    case 'user':
      if (row.item.tileEvents?.length) {
        return (
          <div className="flex flex-col items-end gap-1.5 pb-3 pt-1">
            {row.item.tileEvents.map((event) => <TileEventCard key={event.id} event={event} {...(context.onOpenTile ? { onOpenTile: context.onOpenTile } : {})} />)}
          </div>
        )
      }
      return (
        <div className="flex flex-col items-end gap-1.5 pb-3 pt-1">
          {row.item.steered || row.item.relayTo ? (
            <span className="flex max-w-[85%] items-center gap-1 text-2xs text-muted-foreground">
              {row.item.relayTo ? <MessageSquareShare className="size-3" aria-hidden="true" /> : <Rabbit className="size-3" aria-hidden="true" />}
              <span className="truncate">{row.item.relayTo ? `To @${row.item.relayTo.label}, relayed through main ${context.provider}` : `Steered: sent while ${context.provider} worked`}</span>
            </span>
          ) : null}
          {row.item.images?.length ? <ImageStrip images={row.item.images} className="max-w-[85%] justify-end" /> : null}
          {row.item.text ? (
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-border bg-message px-3.5 py-2 text-base text-foreground">
              <UserText text={row.item.text} />
            </div>
          ) : null}
        </div>
      )
    case 'plan':
      return <PlanCard item={row.item} markdown={Markdown} {...(context.onSavePlan ? { onSave: context.onSavePlan } : {})} />
    case 'subagents':
      return <SubagentGroup row={row} items={context.items} now={context.now} onTask={context.onTask} controlsDisabled={context.controlsDisabled} {...(context.onOpenSubagent ? { onOpen: context.onOpenSubagent } : {})} />
    case 'assistant':
      return <div className="chat-reply pb-3"><Markdown text={row.item.text} images={row.item.images} running={row.item.status === 'running'} /></div>
    case 'activity':
      return <ActivityGroup row={row} cwd={cwd} />
    case 'notice':
      return (
        <div className={cn('flex items-start gap-1.5 pb-2 text-xs', row.item.level === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {row.item.level === 'error' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
          <span className="whitespace-pre-wrap break-words">{row.item.text}</span>
        </div>
      )
  }
}

export function ChatTimeline({ provider = 'claude', items, cwd, working, scope, header, footer, emptyText, onOpenSubagent, onSavePlan, onTask, controlsDisabled, userMessageCard, onOpenTile }: {
  provider?: ChatProvider
  items: readonly ChatItem[]
  cwd: string
  working: boolean
  /** A subagent's Agent call id to show its transcript; the main conversation otherwise. */
  scope?: string
  /** Shown above the first row (a subagent's task). */
  header?: ReactNode
  userMessageCard?: { itemId: string; content: ReactNode }
  footer?: ReactNode
  emptyText?: string
  onOpenSubagent?: (toolUseId: string) => void
  onSavePlan?: SavePlan
  onTask?: (action: ChatTaskAction, agent: SubagentItem) => void
  controlsDisabled?: boolean
  /** Brings a redline/canvas card's tile forward; false when it is gone. */
  onOpenTile?: (webPaneId: string) => boolean
}) {
  const rows = useMemo(() => mergeActivityRows(deriveTimelineRows(items, scope)), [items, scope])
  const live = rows.some((row) => (row.kind === 'subagents' || row.kind === 'activity') && row.live)
  const now = useNow(live)
  const context = useMemo(() => ({ items, now, provider: providerLabel({ provider }), onTask, controlsDisabled, ...(onOpenSubagent ? { onOpenSubagent } : {}), ...(onSavePlan ? { onSavePlan } : {}), ...(onOpenTile ? { onOpenTile } : {}) }), [items, now, provider, onOpenSubagent, onSavePlan, onTask, controlsDisabled, onOpenTile])
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

  // A card the user sent after the latest activity doesn't end that activity.
  const last = [...rows].reverse().find((row) => !(row.kind === 'user' && row.item.tileEvents?.length))
  const streaming = last?.kind === 'assistant' && last.item.status === 'running'
  const liveWork = (last?.kind === 'activity' || last?.kind === 'subagents') && last.live
  return (
    <div ref={scroller} className="chat-timeline min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4" data-testid="chat-timeline">
      <div className="mx-auto w-full max-w-[var(--chat-content-max-width)]">
        {header}
        <TimelineContext value={context}>
          {rows.length === 0 && !header ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{emptyText ?? `Ask ${providerLabel({ provider })} anything about this folder.`}</div>
          ) : rows.map((row) => row.kind === 'user' && row.item.id === userMessageCard?.itemId
            ? <div key={row.id}>{userMessageCard.content}</div>
            : <Row key={row.id} row={row} cwd={cwd} />)}
        </TimelineContext>
        {working && !streaming && !liveWork ? (
          <div className="flex items-center gap-1.5 pb-3 text-sm text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary chat-pulse" aria-hidden="true" />
            Working…
          </div>
        ) : null}
        {footer}
      </div>
    </div>
  )
}

import type { PaneManagementApiClient, ResourceActionHandler } from '../paneManagementApi'
import type { CommanderState } from '../../shared/commander'
import { AgentsInbox, type AgentsInboxProps } from './AgentsInbox'
import { CommanderSplit, type CommanderPeek } from './CommanderReadingPane'
import { Component, useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Bot, PlugZap, RefreshCw, SquareTerminal } from 'lucide-react'
import {
  hostTakesTurnFlow,
  hostTakesAsides,
  asideKey,
  type AsideReport,
  type ChatAsideAction,
  type ChatAsideResult,
  planImplementationPrompt,
  type ExternalAgentRun,
  type ChatAnswer,
  type ChatClaudeCodeSwitch,
  type ChatImageRef,
  type ChatItem,
  type ChatModelOption,
  type ChatQueueAction,
  type ChatSendOptions,
  type ChatSessionPermissionMode,
  type ChatProvider,
  type ChatLogin,
  type ChatSettingsChange,
  type ChatState,
  type ChatSubagentTranscript,
  type ChatSwitchAction,
  type ChatTaskAction,
  providerName,
  providerTuiLabel,
} from '../../shared/agent-chat'
import type { AgentStatus, SessionAsk, TmuxPane } from '../../shared/protocol'
import { chatParent, parentLabel, stripTaskPreamble, type LineageSnapshot } from '../chatLineage'
import type { PrQuickLookTab } from '../PrQuickLook'
import type { PanePrSummary, PrsApiClient } from '../prsApi'
import { PrStrip } from './PrStrip'
import { AskTray } from './AskTray'
import { askAnchors, askMarkerCounts } from './sessionAsks'
import { askAnswerText } from '../../shared/session-asks'
import { ChatComposer, type ChatDraft, type ChatInputServices, type ChatSendError, type ComposerInsert } from './ChatComposer'
import { providerLabel, type ChatHandoffTarget } from './ComposerControls'
import { ChatTimeline, Markdown, type ChatFocusMessageRequest } from './ChatTimeline'
import type { SavePlan } from './PlanCard'
import { AgentSwitcher, SubagentHeader, useNow } from './Subagents'
import { Button } from './ui/button'
import { latestTodos, pendingRequests, withExternalAgentRuns, type SubagentItem } from '../../shared/chat-timeline'
import { withTileEvents, type ChatCardEvent } from '../../shared/chat-tile-events'
import { findSubagent, implementPermissionMode, planAwaitingFollowUp, subagentLabel, switcherSubagents } from './turnFlow'
import { AsideTabs, AsideBanner, asideStatus } from './AsideTabs'
import { AsideReportSheet, useAsideReports, type AsideReportDraft } from './AsideReport'
import { QuickAside } from './QuickAside'
import { asideTitle } from './asideTitle'
import './chat.css'

/** What a chat pane asks of the app for queueing, subagents and plans. */
export interface ChatFlowServices {
  queue: (change: ChatQueueAction) => void
  stopExternal?: (runId: string) => void
  task: (action: ChatTaskAction, agentId: string, toolUseId: string) => void
  subagentTranscript: (agentId: string) => Promise<ChatSubagentTranscript>
  savePlan: SavePlan
  /** Splits the pane and starts a fresh chat (same profile and folder) that implements the plan. */
  implementInNewPane?: (plan: string, mode: ChatSessionPermissionMode) => Promise<void>
  /** Hands the conversation to Claude Code in this pane (Switch now), or cancels a waiting switch. */
  switchToClaudeCode?: (action: ChatSwitchAction) => void
  /** Lets a switch read the composer's unsent draft. */
  registerDraft?: (read: (() => ChatDraft) | null) => void
  /** The composer took back what the chat carried across Claude Code, with this many of its images. */
  takeCarried?: (carryId: string, images: number) => void
  /** The composer has an image still uploading, which a switch would leave behind. */
  setUploading?: (uploading: boolean) => void
}

const EMPTY_EXTERNAL_RUNS: readonly ExternalAgentRun[] = []
const EMPTY_TILE_EVENTS: readonly ChatCardEvent[] = []
const NO_ASKS: readonly SessionAsk[] = []

type TranscriptState = { loading: true } | ({ loading: false } & ChatSubagentTranscript)

/** Keeps a rendering bug in the chat from taking down the whole app. */
export class ChatErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="terminal-chat-shell commando-chat flex flex-col items-start gap-2 p-4 text-sm text-destructive" role="alert">
        The chat view failed to render: {this.state.error.message}. Use the terminal toggle to keep working.
      </div>
    )
  }
}

/** A chat pane: the agent host's turns as a narrow, readable column. */
export type ChatThreadBindings = Pick<Parameters<typeof ChatColumn>[0],
  'onSend' | 'onInterrupt' | 'onAnswer' | 'onConfigure' | 'onRestart' | 'services' | 'flow' |
  'sendError' | 'onDismissSendError' | 'actionError' | 'onDismissActionError'>

export interface ChatAsideServices {
  chats: Readonly<Record<string, ChatState>>
  selected: string | undefined
  select: (id: string | undefined) => void
  request: (action: ChatAsideAction) => Promise<ChatAsideResult>
  bindings: (key: string) => ChatThreadBindings
}

export function ChatPane({ asides, ...props }: Parameters<typeof ChatColumn>[0] & { asides?: ChatAsideServices }) {
  const shell = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!props.paneId || !props.registerFocusable) return
    props.registerFocusable(props.paneId, shell.current)
    return () => props.registerFocusable?.(props.paneId!, null)
  }, [props.paneId, props.registerFocusable])
  const [anchor, setAnchor] = useState<ChatItem>()
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickId, setQuickId] = useState<string>()
  const quickBeforeOpen = useRef(props.chat.asides)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState<ChatAsideAction>()
  const beforeOpen = useRef(new Set<string>())
  const [reforks, setReforks] = useState<Record<string, number>>({})
  const reporting = useAsideReports(asides, props.chat, props.sendError)
  const [reportSource, setReportSource] = useState<AsideReport>()
  const [focusMain, setFocusMain] = useState(false)
  useEffect(() => { setAnchor(undefined); setQuickOpen(false); setQuickId(undefined) }, [props.chat.session.sessionId])
  const available = asides && hostTakesAsides(props.chat.session)
  const selected = available ? asides.selected : undefined
  const latestSelected = useRef(selected)
  latestSelected.current = selected
  const awaitingRecord = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (selected === 'new') shell.current?.querySelector<HTMLTextAreaElement>('textarea[data-chat-composer]')?.focus()
    if (!selected && focusMain) {
      shell.current?.querySelector<HTMLTextAreaElement>('textarea[data-chat-composer]')?.focus()
      setFocusMain(false)
    }
  }, [selected, focusMain])
  const record = props.chat.asides?.find((aside) => aside.id === selected && aside.status === 'open' && !aside.ephemeral)
  const selectedChat = record && asides?.chats[asideKey(props.chat.paneId, record.id)]
  const lastRecord = useRef<string | undefined>(undefined)
  // A result may beat its broadcast. Wait for a newly opened record, but leave a closed/removed one.
  useEffect(() => {
    if (record) { lastRecord.current = record.id; awaitingRecord.current = undefined }
    else if (selected && selected !== 'new' && !busy && awaitingRecord.current !== selected &&
      (lastRecord.current === selected || props.chat.asides?.some((aside) => aside.id === selected && aside.status === 'closed'))) {
      lastRecord.current = undefined
      asides?.select(undefined)
    }
  }, [selected, record, busy, asides, props.chat.asides])
  const request = async (action: ChatAsideAction) => {
    if (!asides || busy) return false
    setBusy(true)
    beforeOpen.current = new Set(props.chat.asides?.map((aside) => aside.id))
    if (action.action === 'open' && action.ephemeral) quickBeforeOpen.current = props.chat.asides
    setPendingAction(action)
    setError(undefined)
    try {
      const result = await asides.request(action)
      if (!result.ok) { setError(result.error || 'The aside operation failed'); return false }
      if (action.action === 'open' && action.ephemeral) { setQuickId(result.asideId); setQuickOpen(true) }
      else if (action.action === 'open' || action.action === 'reopen' || action.action === 'keep') {
        const id = result.asideId ?? (action.action !== 'open' ? action.asideId : undefined)
        awaitingRecord.current = id
        asides.select(id)
      } else if ((action.action === 'close' || action.action === 'promote') && action.asideId === latestSelected.current) asides.select(undefined)
      else if (action.action === 'refork') setReforks((current) => ({ ...current, [action.asideId]: (current[action.asideId] ?? 0) + 1 }))
      return true
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      return false
    } finally { setBusy(false); setPendingAction(undefined) }
  }
  const pending = (id: string) => busy && (pendingAction?.action === 'open' ? !beforeOpen.current.has(id) : pendingAction?.asideId === id)
  const open = available ? (text: string, images?: ChatImageRef[]) => request({ action: 'open', text, ...(images?.length ? { images } : {}), mode: 'read-only', ...(selected === 'new' && anchor ? { at: anchor.id } : {}) }) : undefined
  const showStrip = available && (Boolean(props.chat.asides?.some((entry) => !entry.ephemeral && entry.status !== 'discarded')) || Boolean(props.chat.asidesError) || Boolean(selected) || busy)
  const quickRecord = props.chat.asides?.find((entry) => entry.ephemeral && entry.status === 'open')
  // Only bridge a result that beats its record broadcast. A newer list is authoritative,
  // including a discarded/missing record after a host restart.
  const awaitingQuick = quickId && props.chat.asides === quickBeforeOpen.current && !props.chat.asides?.some((entry) => entry.id === quickId)
  const activeQuickId = quickRecord?.id ?? (awaitingQuick ? quickId : undefined)
  useEffect(() => {
    if (quickId && !activeQuickId) { setQuickId(undefined); setQuickOpen(false) }
  }, [quickId, activeQuickId])
  const quickChat = activeQuickId && asides?.chats[asideKey(props.chat.paneId, activeQuickId)]
  const askQuick = async (text?: string, images?: ChatImageRef[]) => {
    if (activeQuickId) { setQuickOpen(true); return !text }
    setQuickOpen(true)
    return text || images?.length ? request({ action: 'open', text: text ?? '', ephemeral: true, ...(images?.length ? { images } : {}) }) : true
  }
  const dismissQuick = async () => {
    if (activeQuickId && !await request({ action: 'discard', asideId: activeQuickId })) return
    setQuickOpen(false); setQuickId(undefined)
    setFocusMain(true)
  }
  const quickPopover = available && !selected && (quickOpen || quickRecord) ? <QuickAside record={quickRecord} chat={quickChat || undefined} disabled={busy || !props.connected || !props.chat.hostConnected}
    title={quickRecord ? asideTitle(quickRecord, quickChat || undefined, props.chat.session.title) : undefined}
    onAsk={askQuick} onKeep={() => { if (activeQuickId) void request({ action: 'keep', asideId: activeQuickId }).then((ok) => { if (ok) { setQuickOpen(false); setQuickId(undefined) } }) }}
    onCopy={(text) => { reporting.appendDraft(text); setFocusMain(true) }} onDismiss={() => { void dismissQuick() }} /> : undefined
  const columnProps = selectedChat && asides ? {
    ...props, ...asides.bindings(selectedChat.paneId), chat: selectedChat,
    externalRuns: EMPTY_EXTERNAL_RUNS, tileEvents: EMPTY_TILE_EVENTS, asks: NO_ASKS,
    commander: undefined, prsApi: undefined, focusMessage: undefined, onAsideFromHere: undefined, asideMarkers: undefined, onQuickAside: undefined, quickAside: undefined,
  } : { ...props,
    reportDraft: reporting.draft, onReportDraftTaken: reporting.consumeDraft,
    ...(available ? {
      onQuickAside: askQuick, quickAside: quickPopover,
      onAsideFromHere: (item: ChatItem) => { setAnchor(item); asides.select('new') },
      asideMarkers: (props.chat.asides ?? []).filter((entry) => !entry.ephemeral && entry.status !== 'discarded' && entry.forkedFrom.itemId).map((entry) => ({
        itemId: entry.forkedFrom.itemId!, id: entry.id, title: asideTitle(entry, asides.chats[asideKey(props.chat.paneId, entry.id)], props.chat.session.title),
        status: entry.status === 'closed' ? 'closed' : entry.status === 'promoted' ? 'Opened as chat' : asideStatus(asides.chats[asideKey(props.chat.paneId, entry.id)]),
        onSelect: () => { if (entry.status === 'open') asides.select(entry.id); else void request({ action: entry.status === 'promoted' ? 'promote' : 'reopen', asideId: entry.id }) },
      })),
    } : {}),
    reportReferences: reporting.references, onRemoveReportReference: reporting.removeReference, onReportsSent: (requestId: string | void, text: string) => {
      reporting.rememberSend(requestId, text)
      const closing = new Set(reporting.references.filter((report) => report.close).map((report) => report.asideId))
      reporting.clearReferences()
      for (const asideId of closing) void asides?.request({ action: 'close', asideId }).then((result) => {
        if (!result.ok) setError(result.error || 'Could not close the aside')
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
    },
    onOpenReport: (report: AsideReport) => {
      const source = props.chat.asides?.find((aside) => aside.id === report.asideId)
      if (source?.status === 'open') asides?.select(source.id)
      else setReportSource(report)
    },
  }
  const report = selected ? reporting.reports[selected] : undefined
  const reportSheet = report ? <AsideReportSheet report={report} disabled={busy || !props.connected || !props.chat.hostConnected || Boolean(props.chat.session.claudeCodeSwitch) || props.chat.session.status === 'closed' || props.chat.session.status === 'error'}
    onChange={(change) => reporting.update(report.asideId, change)} onCancel={() => reporting.cancel(report.asideId)} onSend={() => {
      try {
        reporting.deliver(report, props.onSend)
        if (report.delivery !== 'queue') { props.onFocus(); setFocusMain(true) }
        if (report.close && report.delivery !== 'reference') void request({ action: 'close', asideId: report.asideId })
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    }} /> : undefined
  const column = <ChatErrorBoundary>
    <div ref={shell} onKeyDownCapture={(event) => {
      if (available && !selected && event.key === '/' && !event.shiftKey && !event.altKey && (/Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey)) {
        event.preventDefault(); event.stopPropagation(); void askQuick(); return
      }
    }} tabIndex={-1} className="terminal-chat-shell commando-chat chat-aside-column" onFocus={(event) => {
      if (event.target === event.currentTarget) shell.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Report text"], textarea[data-chat-composer]')?.focus()
    }} onMouseDown={() => { if (selected === 'new' || (selected && !selectedChat)) props.onFocus() }} onKeyDown={(event) => {
      if (event.key === 'Escape' && (quickOpen || quickRecord) && !selected && !event.defaultPrevented && !(event.target instanceof Element && event.target.closest('[data-chat-composer]'))) { event.preventDefault(); if (!busy) void dismissQuick(); return }
      if (event.key !== 'Escape' || !selected || event.defaultPrevented) return
      if (event.target instanceof HTMLTextAreaElement && (event.target.value || selectedChat?.session.status === 'running')) return
      event.preventDefault()
      asides?.select(undefined)
    }}>
      {showStrip ? <AsideTabs main={props.chat} chats={asides.chats} selected={selected} onSelect={(id) => { if (id === 'new') setAnchor(undefined); asides.select(id) }} onAction={(action) => { void request(action) }} pending={pending} disabled={busy || !props.connected || !props.chat.hostConnected} /> : null}
      {record ? <AsideBanner aside={record} disabled={busy || !props.connected || !props.chat.hostConnected} onAction={(action) => { void request(action) }} onReport={() => reporting.start(record)} reportDisabled={!selectedChat?.hostConnected || selectedChat?.session.status !== 'idle' || Boolean(report)} /> : null}
      {reportSource && !selected ? <div className="chat-aside-banner" role="region" aria-label="Report source">
        <span>From aside “{reportSource.title}” · closed or unavailable</span>
        <Button size="xs" disabled={busy || !props.connected || !props.chat.hostConnected} onClick={() => { void request({ action: 'reopen', asideId: reportSource.asideId }).then((ok) => { if (ok) setReportSource(undefined) }) }}>Reopen</Button>
        <Button size="xs" variant="ghost-muted" onClick={() => setReportSource(undefined)}>Dismiss</Button>
      </div> : null}
      {error ? <div role="alert" className="px-3 py-2 text-xs text-destructive">{error}<Button size="xs" variant="ghost-muted" onClick={() => setError(undefined)}>Dismiss</Button></div> : null}
      {selected === 'new' ? <>
        <div className="chat-aside-banner">New aside · {anchor ? 'from this turn' : 'fresh context from Main’s latest finished turn'} · Read-only</div>
        {anchor && (anchor.kind === 'user_message' || anchor.kind === 'assistant_message') ? <blockquote className="chat-aside-quote">{anchor.text}</blockquote> : null}
        <div className="min-h-0 flex-1" />
        <ChatComposer
          session={{ ...props.chat.session, sessionId: `${props.chat.session.sessionId ?? props.chat.paneId}:new-aside`, status: 'idle', queue: [], claudeCodeSwitch: undefined }}
          hostConnected={props.connected && props.chat.hostConnected && !busy}
          requests={[]} services={props.services} onOpenAside={open} newAside
          onSend={() => {}} onInterrupt={() => {}} onAnswer={() => {}} onConfigure={() => {}}
        />
      </> : selected && !selectedChat ? report?.drafting ? <>{reportSheet}</> : record && !pending(record.id) ? <><div role="alert" className="p-4 text-sm text-destructive">
        This aside stopped: {record.lastError ?? 'The aside session closed unexpectedly'}
        <Button size="xs" variant="outline" disabled={!props.connected || !props.chat.hostConnected} onClick={() => { void request({ action: 'reopen', asideId: record.id }) }}>Reopen</Button>
      </div>{reportSheet}</> : <div role="status" className="p-4 text-sm text-muted-foreground">Loading aside…</div>
        : <ChatColumn key={selectedChat ? `${selectedChat.paneId}:${reforks[record!.id] ?? 0}` : props.chat.paneId} {...columnProps} reportSheet={reportSheet} registerFocusable={undefined} {...(open ? { onOpenAside: open } : {})} />}
    </div>
  </ChatErrorBoundary>
  return props.paneId && props.commander?.state.paneId === props.paneId
    ? <CommanderSplit {...(props.commander.peek ? { peek: props.commander.peek } : {})}>{column}</CommanderSplit>
    : column
}

function ChatColumn({
  chat: hostChat,
  externalRuns = EMPTY_EXTERNAL_RUNS,
  tileEvents = EMPTY_TILE_EVENTS,
  onOpenTile,
  paneManagementApi,
  paneId,
  pane,
  snapshot,
  statuses = {},
  commander,
  onSelectPane,
  registerFocusable,
  prsApi,
  connected,
  focused,
  onFocus,
  onSelectionCopied,
  onSend,
  onInterrupt,
  onAnswer,
  onConfigure,
  providerModels,
  onHandoff,
  onRestart,
  onOpenPr,
  onDismissPrs,
  services,
  sendError,
  onDismissSendError,
  actionError,
  onDismissActionError,
  flow,
  asks = NO_ASKS,
  focusMessage,
  onFocusMessageHandled,
  onOpenAside,
  onAsideFromHere, asideMarkers, onQuickAside, quickAside,
  reportSheet,
  reportDraft,
  onReportDraftTaken,
  reportReferences,
  onRemoveReportReference,
  onReportsSent,
  onOpenReport,
}: {
  onAsideFromHere?: (item: ChatItem) => void
  asideMarkers?: Parameters<typeof ChatTimeline>[0]['asideMarkers']
  onQuickAside?: (text?: string, images?: ChatImageRef[]) => Promise<boolean>
  quickAside?: ReactNode
  reportSheet?: ReactNode
  reportDraft?: AsideReportDraft
  onReportDraftTaken?: () => void
  reportReferences?: AsideReport[]
  onRemoveReportReference?: (index: number) => void
  onReportsSent?: (requestId: string | void, text: string) => void
  onOpenReport?: (report: AsideReport) => void
  onOpenAside?: (text: string, images?: ChatImageRef[]) => Promise<boolean>
  chat: ChatState
  externalRuns?: readonly ExternalAgentRun[]
  /** Redline/canvas cards for this chat, from the daemon. */
  tileEvents?: readonly ChatCardEvent[]
  /** Brings a tile forward in this pane's side panel; false when it is gone. */
  onOpenTile?: (webPaneId: string) => boolean
  paneManagementApi?: Pick<PaneManagementApiClient, 'resourceAction'>
  paneId?: string
  pane?: TmuxPane
  snapshot?: LineageSnapshot
  statuses?: Record<string, AgentStatus>
  commander?: AgentsInboxProps & { state: CommanderState; peek?: CommanderPeek }
  onSelectPane?: (id: string) => void
  /** Lets pane jumps find and focus this chat, like terminal panes do. */
  registerFocusable?: (paneId: string, node: HTMLElement | null) => void
  prsApi?: PrsApiClient
  /** Whether this browser is connected to the Commando daemon. */
  connected: boolean
  focused: boolean
  onFocus: () => void
  /** Selecting transcript text copies it, like terminal panes; this confirms the copy. */
  onSelectionCopied?: () => void
  onSend: (text: string, images?: ChatImageRef[], options?: ChatSendOptions) => string | void
  onInterrupt: (dropQueued?: string[]) => void
  onAnswer: (requestId: string, answer: ChatAnswer) => void
  /** Switches the model, effort or permission mode while the chat runs. */
  onConfigure: (change: ChatSettingsChange) => void
  /** Cached models per provider for the model picker's cross-provider handoff menu. */
  providerModels?: Partial<Record<ChatProvider, ChatModelOption[]>>
  /** Hands this chat pane over to another provider in the same worktree. */
  onHandoff?: (target: ChatHandoffTarget) => Promise<void>
  /** Restarts the host on the same conversation, to run the current code. */
  onRestart?: () => void
  /** Opens a linked PR in this pane's side panel. */
  onOpenPr?: (repo: string, number: number, tab: PrQuickLookTab) => void
  /** Closes the side-panel tabs of PRs dismissed from the PR strip. */
  onDismissPrs?: (prs: PanePrSummary[]) => void
  /** File search, pull requests and image uploads for the composer's menus. */
  services?: ChatInputServices
  /** Why the daemon refused a send (e.g. an image it no longer has). */
  sendError?: ChatSendError
  onDismissSendError?: () => void
  /** Why the daemon refused a queue, subagent or interrupt action. */
  actionError?: string
  onDismissActionError?: () => void
  flow?: ChatFlowServices
  /** Questions the agent is waiting on the user to answer. */
  asks?: readonly SessionAsk[]
  focusMessage?: ChatFocusMessageRequest
  onFocusMessageHandled?: (seq: number) => void
}) {
  const openTileRef = useRef(onOpenTile)
  openTileRef.current = onOpenTile
  const resourcePaneId = paneId ?? hostChat.paneId
  const resourceAction = useCallback<ResourceActionHandler>(async (path, action, line, options) => {
    if (!paneManagementApi) throw new Error('Resource actions are unavailable')
    const result = await paneManagementApi.resourceAction(resourcePaneId, path, action, line, options)
    if (result.webPaneId) openTileRef.current?.(result.webPaneId)
    return result
  }, [paneManagementApi, resourcePaneId])
  const onResourceAction = paneManagementApi ? resourceAction : undefined
  const items = useMemo(() => externalRuns.length ? withExternalAgentRuns(hostChat.items, externalRuns) : hostChat.items, [hostChat.items, externalRuns])
  const chat = useMemo(() => items === hostChat.items ? hostChat : { ...hostChat, items }, [hostChat, items])
  // Cards only join the timeline; plan follow-ups and the opening task read the conversation itself.
  const timelineItems = useMemo(() => tileEvents.length ? withTileEvents(chat.items, tileEvents, chat.session.sessionId) : chat.items, [chat.items, tileEvents, chat.session.sessionId])
  const openingTask = pane?.openedBy ? chat.items.find((item) => item.kind === 'user_message' && !item.parentToolUseId) : undefined
  const requests = useMemo(() => pendingRequests(chat.items), [chat.items])
  const todos = useMemo(() => latestTodos(chat.items), [chat.items])
  const working = chat.session.status === 'running'
  const turnFlow = hostTakesTurnFlow(chat.session) && Boolean(flow)
  // The pane shows main or one subagent (by its Agent call's id).
  const [viewing, setViewing] = useState<string | undefined>()
  const [relay, setRelay] = useState<{ agentId: string; label: string } | undefined>()
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptState>>({})
  const [flowError, setFlowError] = useState<string | null>(null)
  const agent = viewing ? findSubagent(chat.items, viewing) : undefined
  const agents = useMemo(() => (flow ? switcherSubagents(chat.items, viewing).filter((item) => turnFlow || item.runtime) : []), [turnFlow, flow, chat.items, viewing])
  const now = useNow(agents.some((entry) => entry.state === 'running' || entry.state === 'quiet'))
  // Implement goes once per plan; the banner stays until Claude's turn starts.
  const [implemented, setImplemented] = useState<{ planId: string; itemCount: number } | null>(null)
  const awaiting = turnFlow && !viewing ? planAwaitingFollowUp(chat.items, chat.session) : null
  const plan = awaiting && awaiting.id !== implemented?.planId ? awaiting : null
  // An Implement that didn't go (refused, or the mode switch failed) offers the plan again.
  const implementFailed = Boolean(sendError) || Boolean(implemented && chat.items.slice(implemented.itemCount).some((item) => item.kind === 'notice' && item.level === 'error'))
  useEffect(() => {
    if (implemented && implementFailed) setImplemented(null)
  }, [implemented, implementFailed])
  const ownItems = useMemo(() => (agent ? chat.items.filter((item) => item.parentToolUseId === agent.id) : []), [agent, chat.items])
  const transcript = agent?.agentId ? transcripts[agent.agentId] : undefined

  // A subagent with no live items (after a resume, or from before this pane opened) is read from its saved transcript.
  const agentId = agent?.agentId
  const needsTranscript = Boolean(agent && agentId && !ownItems.length && flow && !transcript)
  useEffect(() => {
    if (!needsTranscript || !agentId || !flow) return
    setTranscripts((current) => ({ ...current, [agentId]: { loading: true } }))
    flow.subagentTranscript(agentId).then(
      (result) => setTranscripts((current) => ({ ...current, [agentId]: { loading: false, ...result } })),
      (error: unknown) => setTranscripts((current) => ({ ...current, [agentId]: { loading: false, items: [], error: error instanceof Error ? error.message : String(error) } })),
    )
  }, [needsTranscript, agentId, flow])

  // A subagent that left the item window can't be shown; go back to main.
  useEffect(() => {
    if (viewing && !agent) setViewing(undefined)
  }, [viewing, agent])

  const select = useCallback((toolUseId: string | undefined) => {
    if (toolUseId && findSubagent(chat.items, toolUseId)?.runtime) return
    setViewing(toolUseId)
    setRelay(undefined)
    if (toolUseId) {
      // Reopening a finished subagent reads its transcript afresh (it may have been resumed).
      const id = findSubagent(chat.items, toolUseId)?.agentId
      if (id) setTranscripts((current) => {
        const entry = current[id]
        if (!entry || entry.loading) return current
        const next = { ...current }
        delete next[id]
        return next
      })
    }
  }, [chat.items])
  const task = (action: ChatTaskAction, target: SubagentItem) => {
    if (target.runtime) {
      if (action === 'stop') flow?.stopExternal?.(target.id)
      return
    }
    if (target.agentId) flow?.task(action, target.agentId, target.toolUseId)
  }
  const implement = () => {
    if (!plan) return
    setImplemented({ planId: plan.id, itemCount: chat.items.length })
    onSend(planImplementationPrompt(plan.text), undefined, { permissionMode: implementPermissionMode(chat.session) })
  }
  const implementInNewPane = (chat.session.provider === 'claude' || chat.session.provider === 'cursor') && flow?.implementInNewPane && plan
    ? () => {
        setFlowError(null)
        flow.implementInNewPane!(plan.text, implementPermissionMode(chat.session)).catch((error: unknown) => {
          setFlowError(`Couldn't start a new chat pane: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    : undefined
  const handleHandoff = onHandoff
    ? async (target: ChatHandoffTarget) => {
        setFlowError(null)
        try {
          await onHandoff(target)
        } catch (error: unknown) {
          setFlowError(error instanceof Error ? error.message : String(error))
          throw error
        }
      }
    : undefined
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Esc in a subagent's view goes back to main, unless the composer has a use for it.
    if (event.key !== 'Escape' || !viewing || event.defaultPrevented) return
    if (event.target instanceof HTMLTextAreaElement && (event.target.value || working)) return
    // Handled here, so an enclosing view (Commander's reading pane) leaves it alone.
    event.preventDefault()
    setViewing(undefined)
    setRelay(undefined)
  }
  const shownActionError = flowError ?? actionError
  const dismissActionError = () => {
    if (flowError) setFlowError(null)
    else onDismissActionError?.()
  }
  const shell = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!paneId || !registerFocusable) return
    registerFocusable(paneId, shell.current)
    return () => registerFocusable(paneId, null)
  }, [paneId, registerFocusable])
  const focusComposer = () => shell.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Report text"], textarea[data-chat-composer]')?.focus()
  const anchors = useMemo(() => askAnchors(chat.items, asks), [chat.items, asks])
  const askMarkers = useMemo(() => askMarkerCounts(anchors), [anchors])
  const anchored = useMemo(() => new Set(anchors.keys()), [anchors])
  const [askTraySignal, setAskTraySignal] = useState(0)
  const [composerInsert, setComposerInsert] = useState<ComposerInsert>()
  const showAsks = useCallback(() => setAskTraySignal((value) => value + 1), [])
  // Answers follow the composer's rules: none while the host would drop them, and while the
  // turn runs (or waits on a request) they queue like a typed message would.
  const askBusy = chat.session.status === 'running' || chat.session.status === 'waiting'
  const asksDisabled = !connected || !chat.hostConnected || chat.session.status === 'closed' || chat.session.status === 'error'
    || (chat.session.provider !== 'cursor' && Boolean(chat.session.claudeCodeSwitch))
  const answerAsk = (ask: SessionAsk, option: string) => {
    onSend(askAnswerText(ask, option), undefined, { ...(askBusy && hostTakesTurnFlow(chat.session) ? { delivery: 'queue' as const } : {}), answersAsk: ask.key })
  }
  // An answer goes to the main agent, never to a subagent picked for a relay.
  const replyToAsk = (ask: SessionAsk) => {
    setRelay(undefined)
    setComposerInsert((current) => ({ id: (current?.id ?? 0) + 1, text: askAnswerText(ask, ''), answersAsk: ask.key }))
  }
  const jumpToAsk = (ask: SessionAsk) => {
    const itemId = anchors.get(ask.key)
    if (!itemId) return
    setViewing(undefined)
    setRelay(undefined)
    // After the main timeline is back on screen.
    requestAnimationFrame(() => {
      const node = shell.current?.querySelector<HTMLElement>(`[data-ask-anchor="${CSS.escape(itemId)}"]`)
      if (!node) return
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      node.classList.remove('chat-ask-flash')
      void node.offsetWidth
      node.classList.add('chat-ask-flash')
    })
  }
  // A press in the transcript may start a text selection, so the composer only
  // takes the caret once the mouse is released without one.
  const pressing = useRef(false)
  // The selection a press started with; clicking a button keeps it, and that is no new selection.
  const pressedRange = useRef<Range | null>(null)
  const selectionCopied = useRef(onSelectionCopied)
  selectionCopied.current = onSelectionCopied
  useEffect(() => {
    if (focused && !pressing.current) focusComposer()
  }, [focused])
  useEffect(() => {
    const settle = () => {
      const node = shell.current
      const selection = window.getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      const before = pressedRange.current
      pressedRange.current = null
      const unchanged = before && range
        && before.compareBoundaryPoints(Range.START_TO_START, range) === 0
        && before.compareBoundaryPoints(Range.END_TO_END, range) === 0
      const text = node && selection && !selection.isCollapsed && !unchanged && node.contains(selection.anchorNode) ? selection.toString() : ''
      if (text) {
        void navigator.clipboard?.writeText(text).then(() => selectionCopied.current?.(), () => undefined)
      } else if (node && document.activeElement === node) {
        focusComposer()
      }
    }
    const release = () => {
      if (!pressing.current) return
      pressing.current = false
      // A click inside an old selection clears it after mouseup's handlers run.
      setTimeout(settle)
    }
    // Dragging a link ends without a mouseup.
    const releases = ['mouseup', 'pointercancel', 'dragend'] as const
    for (const type of releases) document.addEventListener(type, release)
    return () => { for (const type of releases) document.removeEventListener(type, release) }
  }, [])
  const retryTranscript = (id: string) => setTranscripts((current) => {
    const next = { ...current }
    delete next[id]
    return next
  })
  return (
    <section ref={shell} tabIndex={-1} style={{ height: 'auto', flex: '1 1 0%' }} className="terminal-chat-shell commando-chat flex min-h-0 min-w-0 flex-col outline-none" onFocus={(event) => {
      // A pane jump focuses the shell; hand the caret to the composer.
      if (event.target === event.currentTarget && !pressing.current) focusComposer()
    }} onMouseDown={(event) => {
      if (event.button === 0) {
        pressing.current = true
        const selection = window.getSelection()
        pressedRange.current = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
      }
      onFocus()
    }} onKeyDown={onKeyDown} aria-label="Agent chat" data-testid="chat-pane" data-chat-overlay-root="">
      {!connected ? (
        <div className="flex items-center gap-1.5 border-b border-border bg-warning-surface px-3 py-1.5 text-xs text-warning" role="status">
          <PlugZap className="size-3.5" aria-hidden="true" />
          Reconnecting to Commando… The agent keeps working in its pane.
        </div>
      ) : !chat.hostConnected ? (
        <div className="flex items-center gap-1.5 border-b border-border bg-warning-surface px-3 py-1.5 text-xs text-warning" role="status">
          <PlugZap className="size-3.5" aria-hidden="true" />
          The agent host is disconnected. It keeps working in its pane and will reconnect.
        </div>
      ) : null}
      {connected && chat.hostConnected && chat.updateAvailable && onRestart ? (
        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground" role="status">
          <RefreshCw className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1">Commando has updated since this chat started.</span>
          <Button size="xs" variant="outline" onClick={onRestart}>
            {working ? 'Restart after this turn' : 'Restart to update'}
          </Button>
        </div>
      ) : null}
      {chat.session.status === 'error' && chat.session.error ? (
        <div className="border-b border-border px-3 py-1.5 text-xs text-destructive" role="alert">{chat.session.error}</div>
      ) : null}
      {agent ? (
        <>
          <SubagentHeader
            provider={providerLabel(chat.session)}
            agent={agent}
            items={chat.items}
            now={now}
            disabled={!connected || !chat.hostConnected}
            onBack={() => select(undefined)}
            onTask={task}
            {...(chat.session.provider === 'claude' ? { onMessage: () => agent.agentId && setRelay({ agentId: agent.agentId, label: subagentLabel(agent) }) } : {})}
          />
          <SubagentTimeline provider={chat.session.provider} agent={agent} items={chat.items} ownItems={ownItems} transcript={transcript} cwd={chat.session.cwd} onOpenSubagent={select} onResourceAction={onResourceAction} onRetry={() => agent.agentId && retryTranscript(agent.agentId)} />
        </>
      ) : (
        <ChatTimeline
          onOpenReport={onOpenReport}
          onAsideFromHere={onAsideFromHere} asideMarkers={asideMarkers}
          provider={chat.session.provider}
          onResourceAction={onResourceAction}
          items={timelineItems}
          {...(onOpenTile ? { onOpenTile } : {})}
          {...(onOpenPr ? { onOpenPr } : {})}
          {...(openingTask?.kind === 'user_message' && pane && snapshot ? { userMessageCard: {
            itemId: openingTask.id,
            content: <OpenedChatTask key={openingTask.id} text={stripTaskPreamble(openingTask.text)} pane={pane} snapshot={snapshot} statuses={statuses} onSelectPane={onSelectPane} />,
          } } : {})}
          cwd={chat.session.cwd}
          working={working}
          onTask={task}
          controlsDisabled={!connected || !flow?.stopExternal}
          {...(turnFlow ? { onOpenSubagent: select } : {})}
          {...(flow ? { onSavePlan: flow.savePlan } : {})}
          {...(askMarkers.size ? { askMarkers, onShowAsks: showAsks } : {})}
          {...(focusMessage ? { focusMessage } : {})}
          {...(onFocusMessageHandled ? { onFocusMessageHandled } : {})}
        />
      )}
      {commander?.state.paneId && commander.state.paneId === paneId ? (
        <div className="px-4"><AgentsInbox {...commander} /></div>
      ) : null}
      {agents.length ? (
        <div className="px-4">
          <AgentSwitcher provider={providerLabel(chat.session)} agents={agents} items={chat.items} viewing={viewing} now={now} disabled={!connected || !chat.hostConnected} externalDisabled={!connected || !flow?.stopExternal} onSelect={select} onTask={task} />
        </div>
      ) : null}
      {chat.session.provider !== 'cursor' && chat.session.claudeCodeSwitch ? (
        <ClaudeCodeSwitchBanner
          state={chat.session.claudeCodeSwitch}
          provider={chat.session.provider}
          disabled={!connected || !chat.hostConnected}
          {...(flow?.switchToClaudeCode ? { onSwitch: flow.switchToClaudeCode } : {})}
        />
      ) : null}
      {chat.session.login ? <CursorLoginBanner login={chat.session.login} disabled={!connected || !chat.hostConnected} onSend={onSend} /> : null}
      <AskTray asks={asks} disabled={asksDisabled} anchored={anchored} openSignal={askTraySignal} onAnswer={answerAsk} onReply={replyToAsk} onJump={jumpToAsk} />
      {prsApi ? <PrStrip key={paneId ?? chat.paneId} paneId={paneId ?? chat.paneId} api={prsApi} connected={connected} onSend={onSend} agentConnected={chat.hostConnected} sendError={sendError} {...(onOpenPr ? { onOpenPr } : {})} {...(onDismissPrs ? { onDismissPrs } : {})} /> : null}
      <ChatComposer
        quickAside={quickAside} onQuickAside={onQuickAside}
        reportSheet={reportSheet} reportDraft={reportDraft} onReportDraftTaken={onReportDraftTaken}
        reportReferences={reportReferences} onRemoveReportReference={onRemoveReportReference} onReportsSent={onReportsSent}
        {...(onOpenAside ? { onOpenAside } : {})}
        session={chat.session}
        hostConnected={connected && chat.hostConnected}
        requests={requests}
        {...(todos ? { todos } : {})}
        {...(chat.commands ? { commands: chat.commands } : {})}
        {...(services ? { services } : {})}
        {...(sendError ? { sendError } : {})}
        {...(onDismissSendError ? { onDismissSendError } : {})}
        {...(shownActionError ? { actionError: shownActionError, onDismissActionError: dismissActionError } : {})}
        onSend={onSend}
        onInterrupt={onInterrupt}
        onAnswer={onAnswer}
        onConfigure={onConfigure}
        {...(providerModels ? { providerModels } : {})}
        {...(handleHandoff ? { onHandoff: handleHandoff } : {})}
        {...(plan ? { plan: { item: plan, implementMode: implementPermissionMode(chat.session) }, onImplement: implement } : {})}
        {...(implementInNewPane ? { onImplementInNewPane: implementInNewPane } : {})}
        {...(turnFlow && flow ? { onQueue: flow.queue } : {})}
        {...(relay ? { relayTarget: relay, onClearRelay: () => setRelay(undefined) } : {})}
        {...(chat.carried ? { carried: chat.carried } : {})}
        {...(flow?.takeCarried ? { onCarriedTaken: flow.takeCarried } : {})}
        {...(flow?.registerDraft ? { registerDraft: flow.registerDraft } : {})}
        {...(flow?.setUploading ? { onUploadingChange: flow.setUploading } : {})}
        {...(composerInsert ? { insert: composerInsert } : {})}
      />
    </section>
  )
}

function CursorLoginBanner({ login, disabled, onSend }: {
  login: ChatLogin
  disabled: boolean
  onSend: (text: string) => string | void
}) {
  return (
    <div className="px-4 pt-2">
      <div className="chat-login-banner" role="status">
        <span className="min-w-40 flex-1">{login.state === 'required' ? login.reason || 'Cursor needs you to log in.' : 'Finish logging in to Cursor in your browser.'}</span>
        {login.state === 'required' ? (
          <Button size="xs" disabled={disabled} onClick={() => onSend('/login')}>Log in to Cursor</Button>
        ) : (
          <>
            {login.url ? <a className="text-primary hover:underline" href={login.url} target="_blank" rel="noopener noreferrer">Open the login page</a> : null}
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => onSend('/login cancel')}>Cancel</Button>
          </>
        )}
      </div>
    </div>
  )
}

/** A switch to Claude Code waiting for the turn to end (Cancel, or Switch now to interrupt it), or under way. */
function ClaudeCodeSwitchBanner({ state, disabled, onSwitch, provider }: {
  provider: ChatProvider
  state: ChatClaudeCodeSwitch
  disabled: boolean
  onSwitch?: (action: ChatSwitchAction) => void
}) {
  const label = providerTuiLabel(provider)
  return (
    <div className="px-4 pt-2">
      <div className="mx-auto flex w-full max-w-[var(--chat-content-max-width)] flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-secondary-label" role="status" data-testid="claude-code-switch">
        <SquareTerminal className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-40 flex-1">{state === 'after_turn' ? `Switching to ${label} when this turn ends…` : `Switching to ${label}…`}</span>
        {state !== 'switching' && onSwitch ? (
          <>
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => onSwitch('cancel')}>Cancel</Button>
            {state === 'after_turn' ? (
              <Button size="xs" disabled={disabled} onClick={() => onSwitch('now')} title={`Interrupt ${providerName(provider)}'s turn and switch`}>Switch now</Button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One subagent's own turns: live from items tagged with its Agent call, or
 * from its saved transcript when none are in the pane (after a resume).
 */
function SubagentTimeline({ provider, agent, items, ownItems, transcript, cwd, onOpenSubagent, onRetry, onResourceAction }: {
  provider: ChatProvider
  agent: SubagentItem
  items: readonly ChatItem[]
  ownItems: readonly ChatItem[]
  transcript: TranscriptState | undefined
  cwd: string
  onOpenSubagent: (toolUseId: string) => void
  onResourceAction?: ResourceActionHandler
  onRetry: () => void
}) {
  const live = ownItems.length > 0
  const shown = live ? items : transcript && !transcript.loading ? transcript.items : []
  const saidSomething = (live ? ownItems : shown).some((item) => item.kind === 'assistant_message')
  const report = agent.state !== 'running' && !saidSomething ? agent.output || agent.summary : undefined
  const header = live || !transcript || transcript.loading || transcript.error || !transcript.items.length
    ? agent.prompt ? (
        <div className="mb-3 rounded-lg border border-border bg-card px-3 py-2 text-sm text-secondary-label">
          <span className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground"><Bot className="size-3" aria-hidden="true" />Task from main {providerLabel({ provider })}</span>
          <span className="whitespace-pre-wrap break-words">{agent.prompt}</span>
        </div>
      ) : null
    : null
  const loading = !live && transcript?.loading === true
  const error = !live && transcript && !transcript.loading ? transcript.error : undefined
  return (
    <ChatTimeline
      onResourceAction={onResourceAction}
      provider={provider}
      items={shown}
      cwd={cwd}
      working={agent.state === 'running'}
      {...(live ? { scope: agent.id } : {})}
      header={header}
      emptyText={error ? '' : loading ? "Loading the subagent's transcript…" : agent.state === 'running' ? 'The subagent is starting…' : 'This subagent left no transcript.'}
      footer={(
        <>
          {loading && header ? <p className="pb-3 text-xs text-muted-foreground" role="status">Loading the subagent's transcript…</p> : null}
          {error ? (
            <p className="flex items-center gap-2 pb-3 text-xs text-destructive" role="alert">
              <span className="min-w-0 flex-1">{error}</span>
              <Button size="xs" variant="outline" onClick={onRetry}>Retry</Button>
            </p>
          ) : null}
          {report ? <div className="chat-reply pb-3"><Markdown text={report} /></div> : null}
        </>
      )}
      onOpenSubagent={onOpenSubagent}
    />
  )
}

function OpenedChatTask({ text, pane, snapshot, statuses, onSelectPane }: {
  text: string
  pane: TmuxPane
  snapshot: LineageSnapshot
  statuses: Record<string, AgentStatus>
  onSelectPane: ((id: string) => void) | undefined
}) {
  const parent = chatParent(pane, snapshot)
  const body = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [long, setLong] = useState(false)
  useLayoutEffect(() => {
    const element = body.current
    if (!element || expanded) return
    const measure = () => setLong(element.scrollHeight > element.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, expanded])
  return (
    <div className="mb-3 rounded-lg border border-border bg-card px-3 py-2 text-sm text-secondary-label">
      <div className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Bot className="size-3" aria-hidden="true" /><span>Task from {parentLabel(pane, snapshot, statuses)}</span>
        {parent && onSelectPane ? <button type="button" className="ml-auto shrink-0 text-primary hover:underline" onClick={(event) => { event.stopPropagation(); onSelectPane(parent.id) }}>Go to {parent.id}</button> : null}
      </div>
      <div ref={body} className={`whitespace-pre-wrap break-words${expanded ? '' : ' line-clamp-6'}`}>{text}</div>
      {long ? <button type="button" className="mt-1 text-xs text-primary hover:underline" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show less' : 'Show more'}</button> : null}
    </div>
  )
}

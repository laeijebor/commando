import { Component, useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Bot, PlugZap, RefreshCw, SquareTerminal } from 'lucide-react'
import {
  hostTakesTurnFlow,
  planImplementationPrompt,
  type ExternalAgentRun,
  type ChatAnswer,
  type ChatClaudeCodeSwitch,
  type ChatImageRef,
  type ChatItem,
  type ChatQueueAction,
  type ChatSendOptions,
  type ChatSessionPermissionMode,
  type ChatProvider,
  type ChatSettingsChange,
  type ChatState,
  type ChatSubagentTranscript,
  type ChatSwitchAction,
  type ChatTaskAction,
} from '../../shared/agent-chat'
import type { AgentStatus, TmuxPane } from '../../shared/protocol'
import { chatParent, parentLabel, stripTaskPreamble, type LineageSnapshot } from '../chatLineage'
import type { PrQuickLookTab } from '../PrQuickLook'
import type { PrsApiClient } from '../prsApi'
import { PrStrip } from './PrStrip'
import { ChatComposer, type ChatDraft, type ChatInputServices, type ChatSendError } from './ChatComposer'
import { providerLabel } from './ComposerControls'
import { ChatTimeline, Markdown } from './ChatTimeline'
import type { SavePlan } from './PlanCard'
import { AgentSwitcher, SubagentHeader, useNow } from './Subagents'
import { Button } from './ui/button'
import { latestTodos, pendingRequests, withExternalAgentRuns, type SubagentItem } from '../../shared/chat-timeline'
import { findSubagent, implementPermissionMode, planAwaitingFollowUp, subagentLabel, switcherSubagents } from './turnFlow'
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
export function ChatPane(props: Parameters<typeof ChatColumn>[0]) {
  return <ChatErrorBoundary><ChatColumn {...props} /></ChatErrorBoundary>
}

function ChatColumn({
  chat: hostChat,
  externalRuns = EMPTY_EXTERNAL_RUNS,
  paneId,
  pane,
  snapshot,
  statuses = {},
  onSelectPane,
  prsApi,
  connected,
  focused,
  onFocus,
  onSend,
  onInterrupt,
  onAnswer,
  onConfigure,
  onRestart,
  onOpenPr,
  services,
  sendError,
  onDismissSendError,
  actionError,
  onDismissActionError,
  flow,
}: {
  chat: ChatState
  externalRuns?: readonly ExternalAgentRun[]
  paneId?: string
  pane?: TmuxPane
  snapshot?: LineageSnapshot
  statuses?: Record<string, AgentStatus>
  onSelectPane?: (id: string) => void
  prsApi?: PrsApiClient
  /** Whether this browser is connected to the Commando daemon. */
  connected: boolean
  focused: boolean
  onFocus: () => void
  onSend: (text: string, images?: ChatImageRef[], options?: ChatSendOptions) => string | void
  onInterrupt: (dropQueued?: string[]) => void
  onAnswer: (requestId: string, answer: ChatAnswer) => void
  /** Switches the model, effort or permission mode while the chat runs. */
  onConfigure: (change: ChatSettingsChange) => void
  /** Restarts the host on the same conversation, to run the current code. */
  onRestart?: () => void
  /** Opens a linked PR in this pane's side panel. */
  onOpenPr?: (repo: string, number: number, tab: PrQuickLookTab) => void
  /** File search, pull requests and image uploads for the composer's menus. */
  services?: ChatInputServices
  /** Why the daemon refused a send (e.g. an image it no longer has). */
  sendError?: ChatSendError
  onDismissSendError?: () => void
  /** Why the daemon refused a queue, subagent or interrupt action. */
  actionError?: string
  onDismissActionError?: () => void
  flow?: ChatFlowServices
}) {
  const items = useMemo(() => externalRuns.length ? withExternalAgentRuns(hostChat.items, externalRuns) : hostChat.items, [hostChat.items, externalRuns])
  const chat = useMemo(() => items === hostChat.items ? hostChat : { ...hostChat, items }, [hostChat, items])
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
  const implementInNewPane = chat.session.provider === 'claude' && flow?.implementInNewPane && plan
    ? () => {
        setFlowError(null)
        flow.implementInNewPane!(plan.text, implementPermissionMode(chat.session)).catch((error: unknown) => {
          setFlowError(`Couldn't start a new chat pane: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    : undefined
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Esc in a subagent's view goes back to main, unless the composer has a use for it.
    if (event.key !== 'Escape' || !viewing || event.defaultPrevented) return
    if (event.target instanceof HTMLTextAreaElement && (event.target.value || working)) return
    setViewing(undefined)
    setRelay(undefined)
  }
  const shownActionError = flowError ?? actionError
  const dismissActionError = () => {
    if (flowError) setFlowError(null)
    else onDismissActionError?.()
  }
  const retryTranscript = (id: string) => setTranscripts((current) => {
    const next = { ...current }
    delete next[id]
    return next
  })
  return (
    <section className="terminal-chat-shell commando-chat flex min-h-0 min-w-0 flex-col" onMouseDown={onFocus} onKeyDown={onKeyDown} aria-label="Agent chat" data-testid="chat-pane">
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
            onMessage={() => agent.agentId && setRelay({ agentId: agent.agentId, label: subagentLabel(agent) })}
          />
          <SubagentTimeline provider={chat.session.provider} agent={agent} items={chat.items} ownItems={ownItems} transcript={transcript} cwd={chat.session.cwd} onOpenSubagent={select} onRetry={() => agent.agentId && retryTranscript(agent.agentId)} />
        </>
      ) : (
        <ChatTimeline
          provider={chat.session.provider}
          items={chat.items}
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
        />
      )}
      {agents.length ? (
        <div className="px-4">
          <AgentSwitcher provider={providerLabel(chat.session)} agents={agents} items={chat.items} viewing={viewing} now={now} disabled={!connected || !chat.hostConnected} externalDisabled={!connected || !flow?.stopExternal} onSelect={select} onTask={task} />
        </div>
      ) : null}
      {chat.session.claudeCodeSwitch ? (
        <ClaudeCodeSwitchBanner
          state={chat.session.claudeCodeSwitch}
          provider={chat.session.provider}
          disabled={!connected || !chat.hostConnected}
          {...(flow?.switchToClaudeCode ? { onSwitch: flow.switchToClaudeCode } : {})}
        />
      ) : null}
      {prsApi ? <PrStrip key={paneId ?? chat.paneId} paneId={paneId ?? chat.paneId} api={prsApi} connected={connected} {...(onOpenPr ? { onOpenPr } : {})} /> : null}
      <ChatComposer
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
        autoFocus={focused}
        {...(plan ? { plan: { item: plan, implementMode: implementPermissionMode(chat.session) }, onImplement: implement } : {})}
        {...(implementInNewPane ? { onImplementInNewPane: implementInNewPane } : {})}
        {...(turnFlow && flow ? { onQueue: flow.queue } : {})}
        {...(relay ? { relayTarget: relay, onClearRelay: () => setRelay(undefined) } : {})}
        {...(chat.carried ? { carried: chat.carried } : {})}
        {...(flow?.takeCarried ? { onCarriedTaken: flow.takeCarried } : {})}
        {...(flow?.registerDraft ? { registerDraft: flow.registerDraft } : {})}
        {...(flow?.setUploading ? { onUploadingChange: flow.setUploading } : {})}
      />
    </section>
  )
}

/** A switch to Claude Code waiting for the turn to end (Cancel, or Switch now to interrupt it), or under way. */
function ClaudeCodeSwitchBanner({ state, disabled, onSwitch, provider }: {
  provider: 'claude' | 'codex'
  state: ChatClaudeCodeSwitch
  disabled: boolean
  onSwitch?: (action: ChatSwitchAction) => void
}) {
  const label = provider === 'codex' ? 'Codex TUI' : 'Claude Code'
  return (
    <div className="px-4 pt-2">
      <div className="mx-auto flex w-full max-w-[var(--chat-content-max-width)] flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-secondary-label" role="status" data-testid="claude-code-switch">
        <SquareTerminal className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-40 flex-1">{state === 'after_turn' ? `Switching to ${label} when this turn ends…` : `Switching to ${label}…`}</span>
        {state !== 'switching' && onSwitch ? (
          <>
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => onSwitch('cancel')}>Cancel</Button>
            {state === 'after_turn' ? (
              <Button size="xs" disabled={disabled} onClick={() => onSwitch('now')} title={`Interrupt ${provider === 'codex' ? 'Codex' : 'Claude'}'s turn and switch`}>Switch now</Button>
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
function SubagentTimeline({ provider, agent, items, ownItems, transcript, cwd, onOpenSubagent, onRetry }: {
  provider: ChatProvider
  agent: SubagentItem
  items: readonly ChatItem[]
  ownItems: readonly ChatItem[]
  transcript: TranscriptState | undefined
  cwd: string
  onOpenSubagent: (toolUseId: string) => void
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

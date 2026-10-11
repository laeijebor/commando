import { Component, useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Bot, PlugZap, RefreshCw } from 'lucide-react'
import {
  hostTakesTurnFlow,
  planImplementationPrompt,
  type ChatAnswer,
  type ChatImageRef,
  type ChatItem,
  type ChatQueueAction,
  type ChatSendOptions,
  type ChatSessionPermissionMode,
  type ChatSettingsChange,
  type ChatState,
  type ChatSubagentTranscript,
  type ChatTaskAction,
} from '../../shared/agent-chat'
import { ChatComposer, type ChatInputServices, type ChatSendError } from './ChatComposer'
import { ChatTimeline, Markdown } from './ChatTimeline'
import type { SavePlan } from './PlanCard'
import { AgentSwitcher, SubagentHeader, useNow } from './Subagents'
import { Button } from './ui/button'
import { latestTodos, pendingRequests, type SubagentItem } from './timelineRows'
import { findSubagent, implementPermissionMode, planAwaitingFollowUp, subagentLabel, switcherSubagents } from './turnFlow'
import './chat.css'

/** What a chat pane asks of the app for queueing, subagents and plans. */
export interface ChatFlowServices {
  queue: (change: ChatQueueAction) => void
  task: (action: ChatTaskAction, agentId: string, toolUseId: string) => void
  subagentTranscript: (agentId: string) => Promise<ChatSubagentTranscript>
  savePlan: SavePlan
  /** Splits the pane and starts a fresh chat (same profile and folder) that implements the plan. */
  implementInNewPane?: (plan: string, mode: ChatSessionPermissionMode) => Promise<void>
}

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
  chat,
  connected,
  focused,
  onFocus,
  onSend,
  onInterrupt,
  onAnswer,
  onConfigure,
  onRestart,
  services,
  sendError,
  onDismissSendError,
  actionError,
  onDismissActionError,
  flow,
}: {
  chat: ChatState
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
  const agents = useMemo(() => (turnFlow ? switcherSubagents(chat.items, viewing) : []), [turnFlow, chat.items, viewing])
  const now = useNow(agents.some((entry) => entry.state === 'running'))
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
    if (target.agentId) flow?.task(action, target.agentId, target.toolUseId)
  }
  const implement = () => {
    if (!plan) return
    setImplemented({ planId: plan.id, itemCount: chat.items.length })
    onSend(planImplementationPrompt(plan.text), undefined, { permissionMode: implementPermissionMode(chat.session) })
  }
  const implementInNewPane = flow?.implementInNewPane && plan
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
            agent={agent}
            items={chat.items}
            now={now}
            disabled={!connected || !chat.hostConnected}
            onBack={() => select(undefined)}
            onTask={task}
            onMessage={() => agent.agentId && setRelay({ agentId: agent.agentId, label: subagentLabel(agent) })}
          />
          <SubagentTimeline agent={agent} items={chat.items} ownItems={ownItems} transcript={transcript} cwd={chat.session.cwd} onOpenSubagent={select} onRetry={() => agent.agentId && retryTranscript(agent.agentId)} />
        </>
      ) : (
        <ChatTimeline
          items={chat.items}
          cwd={chat.session.cwd}
          working={working}
          {...(turnFlow ? { onOpenSubagent: select } : {})}
          {...(flow ? { onSavePlan: flow.savePlan } : {})}
        />
      )}
      {agents.length ? (
        <div className="px-4">
          <AgentSwitcher agents={agents} items={chat.items} viewing={viewing} now={now} disabled={!connected || !chat.hostConnected} onSelect={select} onTask={task} />
        </div>
      ) : null}
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
      />
    </section>
  )
}

/**
 * One subagent's own turns: live from items tagged with its Agent call, or
 * from its saved transcript when none are in the pane (after a resume).
 */
function SubagentTimeline({ agent, items, ownItems, transcript, cwd, onOpenSubagent, onRetry }: {
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
          <span className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground"><Bot className="size-3" aria-hidden="true" />Task from main Claude</span>
          <span className="whitespace-pre-wrap break-words">{agent.prompt}</span>
        </div>
      ) : null
    : null
  const loading = !live && transcript?.loading === true
  const error = !live && transcript && !transcript.loading ? transcript.error : undefined
  return (
    <ChatTimeline
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
          {report ? <div className="pb-3"><Markdown text={report} /></div> : null}
        </>
      )}
      onOpenSubagent={onOpenSubagent}
    />
  )
}

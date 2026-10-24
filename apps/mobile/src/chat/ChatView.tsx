import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import { hostTakesTurnFlow, type ChatItem, type ChatSessionStatus, type ChatState, type ChatSubagentTranscript, type ChatTaskAction } from '@commando/agent-chat'
import { findSubagent, subagentLabel, subagentLive, switcherSubagents } from '@commando/chat-subagents'
import { pendingRequests, withExternalAgentRuns, type SubagentItem } from '@commando/chat-timeline'

import type { DaemonClient } from '../daemon/client'
import type { ConnectionPhase } from '../daemon/state'
import type { Host } from '../hosts/types'
import { useTheme } from '../theme'
import { providerPresentation } from '../ui/providerPresentation'
import { withAlpha } from '../ui/primitives'
import { useChatChannel, type ChatChannel } from './channel'
import { ChatComposer } from './ChatComposer'
import { ChatTimeline } from './ChatTimeline'
import { Markdown } from './Markdown'
import { RequestCard } from './RequestCard'
import { useExternalRuns } from './store'
import { AgentSwitcher, SubagentHeader, useNow } from './Subagents'

type TranscriptState = { loading: true } | ({ loading: false } & ChatSubagentTranscript)

/** The nav subtitle's word for where the chat is. */
export function chatStatusWord(status: ChatSessionStatus): string {
  switch (status) {
    case 'running': return 'working'
    case 'waiting': return 'needs you'
    case 'starting': return 'starting'
    case 'idle': return 'idle'
    case 'closed': return 'ended'
    case 'error': return 'stopped'
  }
}

/**
 * A chat pane drawn natively (slice 1c·3): the turns, the oldest open
 * request, and the composer. The phone's pane screen and the iPad cockpit's
 * centre column both show it, through `PaneView`.
 */
export function ChatView({ host, chat, client, phase }: {
  host: Host
  chat: ChatState
  client: DaemonClient | undefined
  phase: ConnectionPhase
}): React.JSX.Element {
  const theme = useTheme()
  const [sendVersion, setSendVersion] = useState(0)
  const { channel, sendError, dismissSendError, actionError, dismissActionError } = useChatChannel(client, chat.paneId)
  const externalRuns = useExternalRuns(host.id, chat.paneId)
  // External runs (`codex exec`, `claude -p`) join the turn that launched them, as on the web.
  const items = useMemo(() => (externalRuns.length ? withExternalAgentRuns(chat.items, externalRuns) : chat.items), [chat.items, externalRuns])
  const requests = useMemo(() => pendingRequests(chat.items), [chat.items])
  const connected = phase === 'live'
  const hostConnected = connected && chat.hostConnected
  const working = chat.session.status === 'running'
  const provider = providerPresentation(chat.session.provider).name
  const view = useSubagentView(items, channel, hostTakesTurnFlow(chat.session))
  const { agent, agents, relay } = view
  const request = requests[0]
  // A reconnect that finishes within the grace period changes nothing on screen.
  const reconnecting = useLingering(!connected, RECONNECT_BANNER_DELAY_MS)
  const banner = reconnecting
    ? 'Reconnecting to Commando… The agent keeps working in its pane.'
    : !chat.hostConnected
      ? 'The agent host is disconnected. It keeps working in its pane and will reconnect.'
      : null

  return (
    <View style={styles.root} testID="chat-view">
      {banner ? <Banner icon="wifi-off" text={banner} tone="amber" /> : null}
      {chat.session.status === 'error' && chat.session.error ? <Banner icon="alert-circle" text={chat.session.error} tone="red" /> : null}
      {agent ? (
        <>
          <SubagentHeader
            agent={agent}
            disabled={!hostConnected}
            items={items}
            now={view.now}
            onBack={() => view.select(undefined)}
            onMessage={() => agent.agentId && view.setRelay({ agentId: agent.agentId, label: subagentLabel(agent) })}
            onTask={view.task}
            provider={provider}
          />
          <SubagentTimeline
            agent={agent}
            baseUrl={host.baseUrl}
            cwd={chat.session.cwd}
            items={items}
            key={agent.id}
            onOpenSubagent={view.select}
            onRetry={view.retryTranscript}
            provider={chat.session.provider}
            transcript={agent.agentId ? view.transcripts[agent.agentId] : undefined}
          />
        </>
      ) : (
        <ChatTimeline
          baseUrl={host.baseUrl}
          omittedItems={chat.omittedItems}
          onLoadEarlier={channel ? () => channel.loadHistory() : undefined}
          controlsDisabled={!connected}
          cwd={chat.session.cwd}
          items={items}
          onOpenSubagent={view.turnFlow ? view.select : undefined}
          onTask={view.task}
          provider={chat.session.provider}
          sendVersion={sendVersion}
          working={working}
        />
      )}
      {agents.length ? (
        <AgentSwitcher
          agents={agents}
          disabled={!hostConnected}
          externalDisabled={!connected}
          items={items}
          now={view.now}
          onSelect={view.select}
          onTask={view.task}
          provider={provider}
          viewing={view.viewing}
        />
      ) : null}
      {chat.session.claudeCodeSwitch ? (
        <Banner
          icon="terminal"
          text={chat.session.claudeCodeSwitch === 'after_turn' ? 'Switching to Claude Code when this turn ends…' : 'Switching to Claude Code…'}
          tone="accent"
        />
      ) : null}
      {request && channel ? (
        <RequestCard
          provider={chat.session.provider}
          cwd={chat.session.cwd}
          disabled={!hostConnected}
          key={request.requestId}
          onAnswer={(answer) => channel.answer(request.requestId, answer)}
          pendingCount={requests.length}
          request={request}
        />
      ) : null}
      {channel ? (
        <View testID="chat-composer-dock" style={styles.composerDock}><ChatComposer
          actionError={actionError}
          carried={chat.carried}
          channel={channel}
          commands={chat.commands}
          host={host}
          hostConnected={hostConnected}
          onSend={() => setSendVersion((version) => version + 1)}
          onDismissActionError={dismissActionError}
          onDismissSendError={dismissSendError}
          {...(relay ? { relayTarget: relay, onClearRelay: () => view.setRelay(undefined) } : {})}
          sendError={sendError}
          session={chat.session}
        /></View>
      ) : (
        <Text style={[styles.waiting, { color: theme.muted }]}>Connecting…</Text>
      )}
    </View>
  )
}

/** How long the socket may be down before the chat says it is reconnecting. */
export const RECONNECT_BANNER_DELAY_MS = 2_000

/** True once `value` has held for `delayMs`; false again as soon as it stops. */
function useLingering(value: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!value) {
      setHeld(false)
      return
    }
    const timer = setTimeout(() => setHeld(true), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return value && held
}

/**
 * Which agent the chat shows (main, or one subagent by its Agent call's id),
 * the transcripts read for subagents with no live items, and the relay
 * target, as the web's ChatPane keeps them.
 */
function useSubagentView(items: readonly ChatItem[], channel: ChatChannel | null, turnFlowHost: boolean) {
  const [viewing, setViewing] = useState<string | undefined>()
  const [relay, setRelay] = useState<{ agentId: string; label: string } | undefined>()
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptState>>({})
  const turnFlow = turnFlowHost && Boolean(channel)
  const agent = viewing ? findSubagent(items, viewing) : undefined
  const agents = useMemo(() => (channel ? switcherSubagents(items, viewing).filter((entry) => turnFlow || entry.runtime) : []), [channel, items, viewing, turnFlow])
  const now = useNow(agents.some(subagentLive) || Boolean(agent && subagentLive(agent)))

  // A subagent with no live items (after a resume, or from before this chat opened) is read from its saved transcript.
  const agentId = agent?.agentId
  const hasOwnItems = useMemo(() => Boolean(agent && items.some((item) => item.parentToolUseId === agent.id)), [agent, items])
  const needsTranscript = Boolean(agent && agentId && !hasOwnItems && channel && !transcripts[agentId])
  useEffect(() => {
    if (!needsTranscript || !agentId || !channel) return
    // Not cancelled when the effect re-runs: marking it loading is what re-runs it.
    setTranscripts((entries) => ({ ...entries, [agentId]: { loading: true } }))
    void channel.subagentTranscript(agentId).then((result) => {
      setTranscripts((entries) => ({ ...entries, [agentId]: { loading: false, ...result } }))
    })
  }, [needsTranscript, agentId, channel])

  // A subagent that left the item window can't be shown; go back to main.
  useEffect(() => {
    if (viewing && !agent) setViewing(undefined)
  }, [viewing, agent])

  const forget = (id: string) => setTranscripts((entries) => {
    if (!entries[id]) return entries
    const next = { ...entries }
    delete next[id]
    return next
  })
  const select = useCallback((toolUseId: string | undefined) => {
    const target = toolUseId ? findSubagent(items, toolUseId) : undefined
    if (target?.runtime) return
    setViewing(toolUseId)
    setRelay(undefined)
    // Reopening a finished subagent reads its transcript afresh (it may have been resumed).
    const id = target?.agentId
    if (id) setTranscripts((entries) => {
      const entry = entries[id]
      if (!entry || entry.loading) return entries
      const next = { ...entries }
      delete next[id]
      return next
    })
  }, [items])
  const task = useCallback((action: ChatTaskAction, target: SubagentItem) => {
    if (!channel) return
    if (target.runtime) {
      if (action === 'stop') channel.stopExternal(target.id)
      return
    }
    if (target.agentId) channel.task(action, target.agentId, target.toolUseId)
  }, [channel])
  return { viewing, agent, agents, now, relay, setRelay, transcripts, select, task, turnFlow, retryTranscript: () => agentId && forget(agentId) }
}

/**
 * One subagent's own turns: live from items tagged with its Agent call, or
 * from its saved transcript when none are in the chat (after a resume).
 */
function SubagentTimeline({ agent, items, transcript, provider, cwd, baseUrl, onOpenSubagent, onRetry }: {
  agent: SubagentItem
  items: readonly ChatItem[]
  transcript: TranscriptState | undefined
  provider: ChatState['session']['provider']
  cwd: string
  baseUrl: string
  onOpenSubagent: (toolUseId: string) => void
  onRetry: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const ownItems = useMemo(() => items.filter((item) => item.parentToolUseId === agent.id), [items, agent.id])
  const live = ownItems.length > 0
  const shown = live ? items : transcript && !transcript.loading ? transcript.items : []
  const saidSomething = (live ? ownItems : shown).some((item) => item.kind === 'assistant_message')
  const report = agent.state !== 'running' && !saidSomething ? agent.output || agent.summary : undefined
  const loading = !live && transcript?.loading === true
  const error = !live && transcript && !transcript.loading ? transcript.error : undefined
  const showTask = Boolean(agent.prompt) && (live || !transcript || transcript.loading || Boolean(transcript.error) || !transcript.items.length)
  const header = showTask ? (
    <View style={[styles.task, { backgroundColor: theme.surface, borderColor: theme.border }]} testID="subagent-task">
      <View style={styles.taskHead}>
        <Feather color={theme.muted} name="cpu" size={11} />
        <Text style={[styles.taskLabel, { color: theme.muted }]}>TASK FROM MAIN {providerPresentation(provider).name.toUpperCase()}</Text>
      </View>
      <Text selectable style={[styles.taskText, { color: theme.textSoft }]}>{agent.prompt}</Text>
    </View>
  ) : null
  const footer = loading && header
    ? <Text accessibilityLiveRegion="polite" style={[styles.footerNote, { color: theme.muted }]}>Loading the subagent's transcript…</Text>
    : error || report ? (
      <>
        {error ? (
          <View accessibilityRole="alert" style={styles.footerError}>
            <Text style={[styles.footerErrorText, { color: theme.red }]}>{error}</Text>
            <Pressable accessibilityRole="button" onPress={onRetry} style={[styles.retry, { borderColor: theme.borderMid }]}>
              <Text style={[styles.retryText, { color: theme.textSoft }]}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
        {report ? <View style={styles.report}><Markdown text={report} /></View> : null}
      </>
    ) : null
  return (
    <ChatTimeline
      baseUrl={baseUrl}
      cwd={cwd}
      emptyText={error ? '' : loading ? "Loading the subagent's transcript…" : agent.state === 'running' ? 'The subagent is starting…' : 'This subagent left no transcript.'}
      footer={footer}
      header={header}
      items={shown}
      onOpenSubagent={onOpenSubagent}
      provider={provider}
      scope={live ? agent.id : undefined}
      working={agent.state === 'running'}
    />
  )
}

function Banner({ icon, text, tone }: { icon: React.ComponentProps<typeof Feather>['name']; text: string; tone: 'amber' | 'red' | 'accent' }): React.JSX.Element {
  const theme = useTheme()
  const color = tone === 'amber' ? theme.amber : tone === 'red' ? theme.red : theme.accent
  return (
    <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: withAlpha(color, 0.08), borderColor: withAlpha(color, 0.3) }]}>
      <Feather color={color} name={icon} size={13} />
      <Text style={[styles.bannerText, { color: tone === 'accent' ? theme.textSoft : color }]}>{text}</Text>
    </View>
  )
}

/** Keeps a rendering bug in the chat from taking down the app (the web's ChatErrorBoundary). */
export class ChatErrorBoundary extends Component<{ children: ReactNode; fallback: (error: Error) => ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, height: 0, minHeight: 0, overflow: 'hidden' },
  composerDock: { flexShrink: 0 },
  banner: { flexShrink: 0, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginTop: 6, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  bannerText: { flex: 1, fontSize: 12.5, lineHeight: 17 },
  waiting: { fontSize: 13, textAlign: 'center', padding: 12 },
  task: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 16, gap: 4 },
  taskHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  taskLabel: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6 },
  taskText: { fontSize: 13.5, lineHeight: 19 },
  footerNote: { fontSize: 12.5, paddingBottom: 12 },
  footerError: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 12 },
  footerErrorText: { flex: 1, fontSize: 12.5 },
  retry: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  retryText: { fontSize: 12.5, fontWeight: '600' },
  report: { paddingBottom: 12 },
})

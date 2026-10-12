import { Component, useMemo, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import type { ChatSessionStatus, ChatState } from '@commando/agent-chat'
import { pendingRequests } from '@commando/chat-timeline'

import type { DaemonClient } from '../daemon/client'
import type { ConnectionPhase } from '../daemon/state'
import type { Host } from '../hosts/types'
import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'
import { useChatChannel } from './channel'
import { ChatComposer } from './ChatComposer'
import { ChatTimeline } from './ChatTimeline'
import { RequestCard } from './RequestCard'

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
  const { channel, sendError, dismissSendError, actionError, dismissActionError } = useChatChannel(client, chat.paneId)
  const requests = useMemo(() => pendingRequests(chat.items), [chat.items])
  const connected = phase === 'live'
  const hostConnected = connected && chat.hostConnected
  const working = chat.session.status === 'running'
  const request = requests[0]
  const banner = !connected
    ? 'Reconnecting to Commando… The agent keeps working in its pane.'
    : !chat.hostConnected
      ? 'The agent host is disconnected. It keeps working in its pane and will reconnect.'
      : null

  return (
    <View style={styles.root} testID="chat-view">
      {banner ? <Banner icon="wifi-off" text={banner} tone="amber" /> : null}
      {chat.session.status === 'error' && chat.session.error ? <Banner icon="alert-circle" text={chat.session.error} tone="red" /> : null}
      <ChatTimeline baseUrl={host.baseUrl} cwd={chat.session.cwd} items={chat.items} working={working} />
      {chat.session.claudeCodeSwitch ? (
        <Banner
          icon="terminal"
          text={chat.session.claudeCodeSwitch === 'after_turn' ? 'Switching to Claude Code when this turn ends…' : 'Switching to Claude Code…'}
          tone="accent"
        />
      ) : null}
      {request && channel ? (
        <RequestCard
          cwd={chat.session.cwd}
          disabled={!hostConnected}
          key={request.requestId}
          onAnswer={(answer) => channel.answer(request.requestId, answer)}
          pendingCount={requests.length}
          request={request}
        />
      ) : null}
      {channel ? (
        <ChatComposer
          actionError={actionError}
          carried={chat.carried}
          channel={channel}
          commands={chat.commands}
          host={host}
          hostConnected={hostConnected}
          onDismissActionError={dismissActionError}
          onDismissSendError={dismissSendError}
          sendError={sendError}
          session={chat.session}
        />
      ) : (
        <Text style={[styles.waiting, { color: theme.muted }]}>Connecting…</Text>
      )}
    </View>
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
  root: { flex: 1, minHeight: 0 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginTop: 6, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  bannerText: { flex: 1, fontSize: 12.5, lineHeight: 17 },
  waiting: { fontSize: 13, textAlign: 'center', padding: 12 },
})

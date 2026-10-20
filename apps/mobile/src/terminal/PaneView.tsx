import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'

import type { WebPane } from '@commando/protocol'

import type { ChatState } from '@commando/agent-chat'

import { chatStatusWord, ChatErrorBoundary, ChatView } from '../chat/ChatView'
import { useChat } from '../chat/store'
import { useDaemonClient, useDaemonConnection } from '../daemon/useDaemonConnection'
import type { Host } from '../hosts/types'
import { sessionIdentityForName } from '@commando/session-identity'
import { providerPresentation } from '../ui/providerPresentation'
import { useSessionPreferences } from '../ui/sessionPreferences'
import { PaneTabs } from '../pane/PaneTabs'
import { useAppActive } from '../daemon/useAppActive'
import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'
import { Composer } from './Composer'
import { KeyBar } from './KeyBar'
import { PaneChips, PaneHud, PaneNav } from './PaneChrome'
import { TerminalSurface, type TerminalSurfaceHandle } from './TerminalSurface'
import { buildPaneContext, type PaneWindowChip } from './paneContext'
import { useHydratedTerminalPrefs } from './prefs'
import { usePaneTerminal } from './usePaneTerminal'
import { composerOps, keyBarOps, rawOps, sendOps, type SendResult } from './composerOps'
import type { KeyBarItem } from './keyBarItems'

export type PaneViewProps = {
  host: Host | undefined
  paneId: string | undefined
  /** False while the pane is off screen: it is unsubscribed and its lease released. */
  active: boolean
  /** Omitted when the pane is a column rather than a screen. */
  onBack?: () => void
  /** Omitted when the Info sections are already beside the terminal. */
  onInfo?: () => void
  /** A tile chip: the tile itself when it can stream, else the tiles list. */
  onOpenTile: (tile: WebPane) => void
  onSelectWindow: (chip: PaneWindowChip) => void
}

/**
 * One live pane. A chat pane (an agent host drives it) is drawn natively from
 * its chat items; any other pane, including a chat handed to Claude Code, is
 * the terminal.
 *
 * The phone's pane screen and the iPad cockpit's centre column are the same
 * component so that neither can drift from the other.
 */
export function PaneView(props: PaneViewProps): React.JSX.Element {
  const chat = useChat(props.host?.id, props.paneId)
  const state = useDaemonConnection(props.host)
  const client = useDaemonClient(props.host)
  const active = useAppActive(props.active)
  const settledAt = props.paneId ? state.agentStatuses[props.paneId]?.settledAt : undefined
  useEffect(() => {
    if (active && props.host && props.paneId && state.phase === 'live') useSessionPreferences.getState().visit(props.host.id, props.paneId, client)
  }, [props.host?.id, props.paneId, active, settledAt, client, state.phase])
  // Keyed so the iPad's centre column starts each chat afresh (its draft, scroll and error boundary).
  return chat && props.host
    ? <ChatPane key={`${props.host.id}:${chat.paneId}`} {...props} chat={chat} host={props.host} />
    : <TerminalPane {...props} />
}

/** A chat pane: session identity and pane tabs over the native chat. */
function ChatPane({ host, paneId, chat, active, onBack, onInfo, onOpenTile }: PaneViewProps & { host: Host; chat: ChatState }): React.JSX.Element {
  const theme = useTheme()
  const state = useDaemonConnection(host)
  const client = useDaemonClient(host)
  const keyboard = useKeyboardOverlap()
  const identities = useSessionPreferences((store) => store.identities[host.id])
  const context = buildPaneContext(state.snapshot, state.agentStatuses, state.webPanes, paneId, paneId ? state.agentStatuses[paneId] : undefined)
  return (
    <PaneTabs key={`${host?.id}:${paneId}`} host={host} paneId={paneId} active={active} chat header={
      <PaneNav
        {...(onBack ? { onBack } : {})}
        {...(onInfo ? { onInfo } : {})}
        identity={sessionIdentityForName(identities ?? {}, context.title)}
        subtitle={`${sessionIdentityForName(identities ?? {}, context.title).codename} · ${providerPresentation(chat.session.provider).name} · ${chatStatusWord(chat.session.status)}`}
        title={context.title}
      /> } onOpenTile={onOpenTile}>
      <View onLayout={keyboard.onLayout} ref={keyboard.ref} style={[styles.chatBody, { paddingBottom: keyboard.overlap ?? 0 }]}>
        <ChatErrorBoundary
          fallback={(error) => (
            <Text style={[styles.chatFailed, { color: theme.red }]}>The chat view failed to render: {error.message}</Text>
          )}
        >
          <ChatView chat={chat} client={client} host={host} phase={state.phase} />
        </ChatErrorBoundary>
      </View>
    </PaneTabs>
  )
}

/**
 * How much of the pane's body the keyboard covers, or null while it is down.
 * The body sits under the stack's nav and above the tab bar, which
 * KeyboardAvoidingView's parent-relative frame can't see, so the gap between
 * the body and the bottom of the window is measured on layout, and the
 * overlap is the keyboard's height less that gap. (`measureInWindow` reports
 * the body relative to its screen here, and a measure during the keyboard
 * event can catch the app-switch animation's transform.)
 */
function useKeyboardOverlap(): { ref: React.RefObject<View | null>; onLayout: () => void; overlap: number | null } {
  const ref = useRef<View>(null)
  const gap = useRef(0)
  const [overlap, setOverlap] = useState<number | null>(null)
  const shown = useRef(false)
  const onLayout = useCallback(() => {
    // The padding changes the body's layout while the keyboard is up; the gap below it doesn't change.
    if (shown.current) return
    ref.current?.measure((_x, _y, _width, height, _pageX, pageY) => {
      gap.current = Math.max(0, Dimensions.get('window').height - (pageY + height))
    })
  }, [])
  useEffect(() => {
    const animate = (duration: number) => {
      LayoutAnimation.configureNext(LayoutAnimation.create(duration || 250, LayoutAnimation.Types.keyboard, LayoutAnimation.Properties.opacity))
    }
    const show = Keyboard.addListener('keyboardWillShow', (event) => {
      shown.current = true
      animate(event.duration)
      const { height, screenY } = event.endCoordinates
      // A floating or undocked iPad keyboard doesn't reach the bottom edge, and covers nothing below it.
      const docked = height > 0 && screenY + height >= Dimensions.get('window').height - 1
      setOverlap(docked ? Math.max(0, Math.min(height, Dimensions.get('window').height - screenY) - gap.current) : null)
    })
    const hide = Keyboard.addListener('keyboardWillHide', (event) => {
      shown.current = false
      animate(event.duration)
      setOverlap(null)
    })
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return { ref, onLayout, overlap }
}

/**
 * The terminal: the xterm WebView with the window chips, HUD strip, key bar
 * and composer around it. React Native owns the socket, the keyboard and the
 * pane's size; by default the pane renders at its source `cols × rows` and pans
 * (Decision 2), and "Fit to phone" takes the resize lease while it is on.
 */
function TerminalPane({
  host,
  paneId,
  active,
  onBack,
  onInfo,
  onOpenTile,
  onSelectWindow,
}: PaneViewProps): React.JSX.Element {
  const theme = useTheme()
  const state = useDaemonConnection(host)
  const client = useDaemonClient(host)
  const prefs = useHydratedTerminalPrefs()

  const surface = useRef<TerminalSurfaceHandle | null>(null)
  const [fit, setFit] = useState(prefs.fitToPhone)
  const [raw, setRaw] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fitTouched = useRef(false)

  // The settings default only applies until this screen's toggle is used.
  useEffect(() => {
    if (!fitTouched.current) setFit(prefs.fitToPhone)
  }, [prefs.fitToPhone])

  const status = paneId ? state.agentStatuses[paneId] : undefined
  const context = buildPaneContext(state.snapshot, state.agentStatuses, state.webPanes, paneId, status)
  const terminal = usePaneTerminal({
    client,
    paneId,
    focused: active,
    fit,
    fontSize: prefs.fontSize,
    phase: state.phase,
    surface,
  })

  const live = state.phase === 'live'

  const report = useCallback((result: SendResult) => {
    if (result === 'sent' || result === 'empty') {
      setNotice(null)
      return
    }
    setNotice(
      result === 'too-large'
        ? 'That is larger than the daemon accepts in one paste.'
        : 'Not connected — the daemon did not take that.',
    )
  }, [])

  const send = useCallback((ops: ReturnType<typeof composerOps>) => {
    if (!client || !paneId) return
    report(sendOps(client, paneId, ops))
  }, [client, paneId, report])

  const handleKey = useCallback(async (item: KeyBarItem) => {
    if (!client || !paneId) return
    void Haptics.selectionAsync()
    const clipboard = item.action.kind === 'paste' ? await Clipboard.getStringAsync() : undefined
    report(sendOps(client, paneId, keyBarOps(item.action, clipboard)))
  }, [client, paneId, report])

  const handleSend = useCallback((text: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    send(composerOps(text, raw ? 'raw' : 'prompt'))
  }, [raw, send])

  return (
    <PaneTabs key={`${host?.id}:${paneId}`} host={host} paneId={paneId} active={active} chat={false} header={
      <PaneNav
        fit={fit}
        {...(onBack ? { onBack } : {})}
        {...(onInfo ? { onInfo } : {})}
        onToggleFit={() => {
          fitTouched.current = true
          void Haptics.selectionAsync()
          setFit((current) => !current)
        }}
        subtitle={context.subtitle}
        title={context.title}
      /> } onOpenTile={onOpenTile}>
      <PaneChips
        context={context}
        onOpenTile={onOpenTile}
        onSelectWindow={onSelectWindow}
      />
      {status ? <PaneHud status={status} /> : null}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
        style={styles.body}
      >
        <View style={styles.terminalWrap}>
          <TerminalSurface
            onEvent={terminal.onEvent}
            onNeedsReseed={terminal.onNeedsReseed}
            ref={surface}
            style={{ borderColor: theme.border }}
          />
          {terminal.atBottom ? null : (
            <Pressable
              accessibilityLabel="Jump to the newest output"
              accessibilityRole="button"
              onPress={terminal.scrollToBottom}
              style={[styles.jump, { backgroundColor: withAlpha(theme.accent, 0.9) }]}
            >
              <Text style={[styles.jumpLabel, { color: theme.accentInk }]}>Jump to latest</Text>
            </Pressable>
          )}
          {terminal.copied ? (
            <View style={[styles.toast, { backgroundColor: theme.surfaceSoft, borderColor: theme.border }]}>
              <Text style={[styles.toastLabel, { color: theme.textSoft }]}>Selection copied</Text>
            </View>
          ) : null}
        </View>

        <Text style={[styles.sizeLine, { color: theme.textDim }]}>
          {sizeSummary(terminal.source, fit ? terminal.fitted : null, live, state.detail)}
        </Text>

        <KeyBar disabled={!live} onPress={(item) => void handleKey(item)} />
        <Composer
          draftKey={host && paneId ? `${host.id}:${paneId}` : undefined}
          disabled={!live}
          notice={notice}
          onRawBackspace={() => send([{ kind: 'key', key: 'Backspace' }])}
          onRawText={(text) => send(rawOps(text))}
          onSend={handleSend}
          onToggleRaw={setRaw}
          raw={raw}
        />
      </KeyboardAvoidingView>
    </PaneTabs>
  )
}

export function sizeSummary(
  source: { cols: number; rows: number } | null,
  fitted: { cols: number; rows: number } | null,
  live: boolean,
  detail: string,
): string {
  if (!live) return detail
  if (!source) return 'Waiting for the pane…'
  if (fitted) return `Fitted ${fitted.cols}×${fitted.rows} · source ${source.cols}×${source.rows}`
  return `Source ${source.cols}×${source.rows} · pan to see the rest`
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  body: { flex: 1, minHeight: 0 },
  chatBody: { flex: 1, height: 0, minHeight: 0, overflow: 'hidden' },
  terminalWrap: { flex: 1, minHeight: 0, paddingHorizontal: 12, paddingTop: 10 },
  jump: {
    position: 'absolute',
    right: 24,
    bottom: 16,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  jumpLabel: { fontSize: 12.5, fontWeight: '700' },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 16,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  toastLabel: { fontSize: 12.5, fontWeight: '600' },
  sizeLine: { fontSize: 11.5, paddingHorizontal: 16, paddingTop: 6 },
  chatFailed: { fontSize: 13.5, lineHeight: 19, padding: 16 },
})

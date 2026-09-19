import { useCallback, useEffect, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'

import type { WebPane } from '@commando/protocol'

import { useDaemonClient, useDaemonConnection } from '../daemon/useDaemonConnection'
import type { Host } from '../hosts/types'
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
 * One live pane: the xterm WebView with the window chips, HUD strip, key bar
 * and composer around it. React Native owns the socket, the keyboard and the
 * pane's size; by default the pane renders at its source `cols × rows` and pans
 * (Decision 2), and "Fit to phone" takes the resize lease while it is on.
 *
 * The phone's pane screen and the iPad cockpit's centre column are the same
 * component so that neither can drift from the other.
 */
export function PaneView({
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
    <View style={styles.root}>
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
      />
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
          disabled={!live}
          notice={notice}
          onRawBackspace={() => send([{ kind: 'key', key: 'Backspace' }])}
          onRawText={(text) => send(rawOps(text))}
          onSend={handleSend}
          onToggleRaw={setRaw}
          raw={raw}
        />
      </KeyboardAvoidingView>
    </View>
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
})

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'

import { useDaemonClient, useDaemonConnection } from '../../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../../src/hosts/store'
import { useTheme } from '../../../../src/theme'
import { withAlpha } from '../../../../src/ui/primitives'
import { Composer } from '../../../../src/terminal/Composer'
import { KeyBar } from '../../../../src/terminal/KeyBar'
import { PaneChips, PaneHud, PaneNav } from '../../../../src/terminal/PaneChrome'
import { TerminalSurface, type TerminalSurfaceHandle } from '../../../../src/terminal/TerminalSurface'
import { buildPaneContext } from '../../../../src/terminal/paneContext'
import { useHydratedTerminalPrefs } from '../../../../src/terminal/prefs'
import { usePaneTerminal } from '../../../../src/terminal/usePaneTerminal'
import { composerOps, keyBarOps, rawOps, sendOps, type SendResult } from '../../../../src/terminal/composer'
import type { KeyBarItem } from '../../../../src/terminal/keyBar'

/**
 * Screen 03. The terminal is xterm.js in a WebView; React Native owns the
 * socket, the keyboard and the pane's size. By default the pane renders at its
 * source `cols × rows` and pans (Decision 2); "Fit to phone" takes the resize
 * lease and gives it back the moment the screen is left.
 */
export default function PaneScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const focused = useIsFocused()
  const { hostId, paneId } = useLocalSearchParams<{ hostId: string; paneId: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
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
    focused,
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
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <PaneNav
        fit={fit}
        onBack={() => router.back()}
        onInfo={() => router.push({
          pathname: '/(host)/[hostId]/pane/[paneId]/info',
          params: { hostId: hostId ?? '', paneId: paneId ?? '' },
        })}
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
        onOpenTiles={() => router.push({
          pathname: '/(host)/[hostId]/tiles',
          params: { hostId: hostId ?? '' },
        })}
        onSelectWindow={(chip) => {
          if (!chip.targetPaneId || chip.targetPaneId === paneId) return
          router.replace({
            pathname: '/(host)/[hostId]/pane/[paneId]',
            params: { hostId: hostId ?? '', paneId: chip.targetPaneId },
          })
        }}
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
    </SafeAreaView>
  )
}

function sizeSummary(
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
  screen: { flex: 1 },
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

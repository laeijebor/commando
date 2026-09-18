import { useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { useDaemonConnection } from '../../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../../src/hosts/store'
import { statusLabel, useTheme } from '../../../../src/theme'
import { Card, ProviderPill, StatusDot } from '../../../../src/ui/primitives'
import { PlaceholderScreen } from '../../../../src/ui/Placeholder'

/**
 * Screen 03 in skeleton form: the HUD strip is real so the route proves out the
 * data flow, while the terminal itself waits for the WebView phase.
 */
export default function PaneScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId, paneId } = useLocalSearchParams<{ hostId: string; paneId: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)

  const status = paneId ? state.agentStatuses[paneId] : undefined
  const brief = paneId ? state.briefs[paneId] : undefined
  const pane = state.snapshot?.panes.find((candidate) => candidate.id === paneId)
  const request = status?.details?.requests?.[0]

  return (
    <PlaceholderScreen
      planned={[
        'xterm.js in a WebView fed by pane_reset / pane_data, at the source pane size',
        'Opt-in "Fit to phone" that takes the resize lease and releases it on close',
        'Key bar sending key messages; composer sending paste then Enter',
        'Window and tile chips, and the Info sheet with worklog, diff, PR and ports',
      ]}
      summary={pane ? `${pane.title || pane.command} · ${pane.targetId}` : `Pane ${paneId ?? ''}`}
      title="Pane"
    >
      {status ? (
        <Card raised style={styles.hud}>
          <View style={styles.hudLine}>
            <StatusDot status={status.status} />
            <Text style={[styles.hudStatus, { color: theme.text }]}>{statusLabel(status.status)}</Text>
            <ProviderPill provider={status.provider} />
          </View>
          <Text style={[styles.headline, { color: theme.textSoft }]}>
            {brief?.headline ?? status.summary}
          </Text>
          {status.details?.currentActivity ? (
            <Text style={[styles.activity, { color: theme.muted }]}>
              {status.details.currentActivity.label}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {request && paneId ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push({
            pathname: '/(host)/[hostId]/answer/[paneId]/[interactionId]',
            params: { hostId: hostId ?? '', paneId, interactionId: request.id },
          })}
          style={[styles.answer, { backgroundColor: theme.accent }]}
        >
          <Text style={[styles.answerLabel, { color: theme.accentInk }]}>
            {request.kind === 'permission' ? 'Review permission' : 'Answer question'}
          </Text>
        </Pressable>
      ) : null}
    </PlaceholderScreen>
  )
}

const styles = StyleSheet.create({
  hud: { gap: 6 },
  hudLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hudStatus: { fontSize: 13, fontWeight: '600' },
  headline: { fontSize: 14, lineHeight: 20 },
  activity: { fontSize: 12.5 },
  answer: { borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  answerLabel: { fontSize: 15, fontWeight: '700' },
})

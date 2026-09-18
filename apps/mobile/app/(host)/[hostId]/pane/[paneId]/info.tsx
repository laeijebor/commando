import { useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StyleSheet } from 'react-native'

import { useDaemonConnection } from '../../../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../../../src/hosts/store'
import { useTheme } from '../../../../../src/theme'
import { EmptyState } from '../../../../../src/ui/primitives'
import { PaneInfo } from '../../../../../src/ui/PaneInfo'

/**
 * Screen 05, pushed over the pane. The route only joins the live daemon state
 * to `PaneInfo`; everything it draws and fetches lives in that component.
 */
export default function PaneInfoScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId, paneId } = useLocalSearchParams<{ hostId: string; paneId: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)

  const pane = state.snapshot?.panes.find((candidate) => candidate.id === paneId)
  const session = state.snapshot?.sessions.find((candidate) => candidate.id === pane?.sessionId)
  const close = (): void => {
    if (router.canGoBack()) router.back()
    else router.replace({ pathname: '/(host)/[hostId]/sessions', params: { hostId: hostId ?? '' } })
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      {host && paneId ? (
        <PaneInfo
          brief={state.briefs[paneId]}
          host={host}
          onClose={close}
          pane={pane}
          paneId={paneId}
          ports={state.snapshot?.ports ?? []}
          sessionName={session?.name}
          status={state.agentStatuses[paneId]}
        />
      ) : (
        <EmptyState
          body="Open the pane again from the sessions list."
          title="That pane is not on this host"
        />
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
})

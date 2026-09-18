import { useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, RefreshControl, ScrollView, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import { pendingRequest, type AgentRow } from '../../../src/agents/selectors'
import { useDaemonConnection } from '../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../src/hosts/store'
import { WideCockpit } from '../../../src/layout/WideCockpit'
import { useLayoutMode } from '../../../src/layout/useLayoutMode'
import { useTheme } from '../../../src/theme'
import { Pill, ScreenTitle } from '../../../src/ui/primitives'
import { SessionsPanel, useSessionsView } from '../../../src/ui/SessionsPanel'

/**
 * Screen 02 on the phone, screen 10 on an iPad: this is the route both form
 * factors land on, so a deep link and a notification behave the same on each.
 * The optional `focus` param is how `/pane/[paneId]` and `/answer/…` hand a
 * pane over when the screen is wide enough for the cockpit.
 */
export default function SessionsScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const mode = useLayoutMode()
  const { hostId, focus } = useLocalSearchParams<{ hostId: string; focus?: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const refreshReachability = useHostsStore((state) => state.refreshReachability)
  const state = useDaemonConnection(host)

  const [view, changeView] = useSessionsView()
  const [refreshing, setRefreshing] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)

  const openPane = (paneId: string): void => {
    router.push({
      pathname: '/(host)/[hostId]/pane/[paneId]',
      params: { hostId: hostId ?? '', paneId },
    })
  }

  // A row with a pending question or permission opens the answer screen; every
  // other row opens the pane.
  const openRow = (row: AgentRow): void => {
    const request = pendingRequest(row.status)
    if (!request) {
      openPane(row.paneId)
      return
    }
    router.push({
      pathname: '/(host)/[hostId]/answer/[paneId]/[interactionId]',
      params: { hostId: hostId ?? '', paneId: row.paneId, interactionId: request.id },
    })
  }

  if (mode !== 'phone') {
    return (
      <WideCockpit
        focusRequest={focus}
        hostId={hostId ?? ''}
        mode={mode}
        onSheetOpenChange={setSheetOpen}
        sheetOpen={sheetOpen}
      />
    )
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <ScreenTitle
        title="Sessions"
        trailing={<Pill label={host?.name ?? 'host'} tone="mute" />}
      />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            onRefresh={() => {
              if (!hostId) return
              setRefreshing(true)
              void refreshReachability(hostId).finally(() => setRefreshing(false))
            }}
            refreshing={refreshing}
            tintColor={theme.muted}
          />
        }
      >
        <SessionsPanel
          onChangeView={changeView}
          onSelectPane={openPane}
          onSelectRow={openRow}
          state={state}
          view={view}
        />
      </ScrollView>

      <Pressable
        accessibilityLabel="New session"
        accessibilityRole="button"
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
          router.push({ pathname: '/(host)/[hostId]/new-session', params: { hostId: hostId ?? '' } })
        }}
        style={[styles.fab, { backgroundColor: theme.accent }]}
      >
        <Feather color={theme.accentInk} name="plus" size={24} />
      </Pressable>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 96, gap: 12 },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
})

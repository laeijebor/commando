import { useEffect, useMemo, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import { buildAgentRows, buildSessionTree, groupAgentRows } from '../../../src/agents/selectors'
import { useDaemonConnection } from '../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../src/hosts/store'
import {
  readPreference,
  SESSIONS_VIEW_PREFERENCE_KEY,
  writePreference,
} from '../../../src/prefs'
import { useTheme } from '../../../src/theme'
import { AgentRowCard } from '../../../src/ui/AgentRowCard'
import {
  EmptyState,
  Pill,
  ScreenTitle,
  SectionHeader,
  Segmented,
} from '../../../src/ui/primitives'
import { SessionTree } from '../../../src/ui/SessionTree'
import { UsageTiles } from '../../../src/ui/UsageTiles'

type SessionsView = 'attention' | 'tree'

const VIEW_OPTIONS = [
  { value: 'attention' as const, label: 'Attention' },
  { value: 'tree' as const, label: 'Tree' },
]

export default function SessionsScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const refreshReachability = useHostsStore((state) => state.refreshReachability)
  const state = useDaemonConnection(host)

  const [view, setView] = useState<SessionsView>('attention')
  const [refreshing, setRefreshing] = useState(false)

  // The toggle choice is remembered per device, as agreed in the spec.
  useEffect(() => {
    void readPreference(SESSIONS_VIEW_PREFERENCE_KEY).then((stored) => {
      if (stored === 'attention' || stored === 'tree') setView(stored)
    })
  }, [])

  const changeView = (next: SessionsView): void => {
    setView(next)
    void Haptics.selectionAsync()
    void writePreference(SESSIONS_VIEW_PREFERENCE_KEY, next)
  }

  const rows = useMemo(
    () => buildAgentRows({
      statuses: state.agentStatuses,
      snapshot: state.snapshot,
      briefs: state.briefs,
    }),
    [state.agentStatuses, state.snapshot, state.briefs],
  )
  const groups = useMemo(() => groupAgentRows(rows), [rows])
  const tree = useMemo(
    () => buildSessionTree(state.snapshot, state.agentStatuses, state.webPanes),
    [state.snapshot, state.agentStatuses, state.webPanes],
  )

  const openPane = (paneId: string): void => {
    router.push({
      pathname: '/(host)/[hostId]/pane/[paneId]',
      params: { hostId: hostId ?? '', paneId },
    })
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
        <Segmented options={VIEW_OPTIONS} onChange={changeView} value={view} />

        {state.phase !== 'live' ? (
          <Text style={[styles.connection, { color: theme.muted }]}>{state.detail}</Text>
        ) : null}

        {view === 'attention' ? (
          <>
            <UsageTiles usage={state.usage} />
            {groups.map((group) => (
              <View key={group.id} style={styles.group}>
                <SectionHeader label={group.label} note={String(group.rows.length)} />
                <View style={styles.list}>
                  {group.rows.map((row) => (
                    <AgentRowCard key={row.paneId} onPress={() => openPane(row.paneId)} row={row} />
                  ))}
                </View>
              </View>
            ))}
            {groups.length === 0 ? (
              <EmptyState
                body="Once an agent reports in, it shows up here grouped by who needs you."
                title="No agents reporting"
              />
            ) : null}
          </>
        ) : (
          <>
            <SessionTree groups={tree} onSelectPane={openPane} />
            {tree.length === 0 ? (
              <EmptyState body="Waiting for the daemon's first snapshot." title="No tmux sessions" />
            ) : null}
          </>
        )}
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
  connection: { fontSize: 12.5 },
  group: { gap: 8 },
  list: { gap: 8 },
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

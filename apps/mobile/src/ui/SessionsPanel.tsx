import { useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Haptics from 'expo-haptics'

import {
  buildAgentRows,
  buildSessionTree,
  groupAgentRows,
  type AgentRow,
} from '../agents/selectors'
import type { HostDaemonState } from '../daemon/state'
import {
  readPreference,
  SESSIONS_VIEW_PREFERENCE_KEY,
  writePreference,
} from '../prefs'
import { useTheme } from '../theme'
import { AttentionList } from './AttentionList'
import { EmptyState, Segmented } from './primitives'
import { SessionTree } from './SessionTree'
import { ChatList } from './ChatList'

export type SessionsView = 'chats' | 'attention' | 'tree'

const VIEW_OPTIONS = [
  { value: 'chats' as const, label: 'Chats' },
  { value: 'attention' as const, label: 'Attention' },
  { value: 'tree' as const, label: 'Tree' },
]

/**
 * The Chats / Attention / Tree choice, remembered per device as the spec agreed. The
 * phone screen and the iPad cockpit share one preference, so the list looks the
 * same however it is being held.
 */
export function useSessionsView(): [SessionsView, (next: SessionsView) => void] {
  const [view, setView] = useState<SessionsView>('chats')

  useEffect(() => {
    void readPreference(SESSIONS_VIEW_PREFERENCE_KEY).then((stored) => {
      if (stored === 'chats' || stored === 'attention' || stored === 'tree') setView(stored)
    })
  }, [])

  return [view, (next: SessionsView): void => {
    setView(next)
    void Haptics.selectionAsync()
    void writePreference(SESSIONS_VIEW_PREFERENCE_KEY, next)
  }]
}

export type SessionsPanelProps = {
  active?: boolean
  refreshing?: boolean
  onRefresh?: () => void
  hostId?: string
  state: HostDaemonState
  view: SessionsView
  onChangeView: (next: SessionsView) => void
  /** A row tap: the answer screen on the phone, a focus change in the cockpit. */
  onSelectRow: (row: AgentRow) => void
  onSelectPane: (paneId: string) => void
  /** The cockpit's focused pane, highlighted in both views. */
  selectedPaneId?: string | undefined
}

/**
 * Screen 02's content: the chat list, attention inbox or repo →
 * session → window → pane tree, under the segmented toggle. It draws no
 * navigation chrome. Each view owns its scroller so Chats can virtualize rows
 * on the phone and in the cockpit's 300pt left column.
 */
export function SessionsPanel({
  state,
  active = true,
  refreshing,
  onRefresh,
  hostId,
  view,
  onChangeView,
  onSelectRow,
  onSelectPane,
  selectedPaneId,
}: SessionsPanelProps): React.JSX.Element {
  const theme = useTheme()

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

  return (
    <View style={styles.panel}>
      <View style={[styles.header, { backgroundColor: theme.bg }]}>
        <Segmented options={VIEW_OPTIONS} onChange={onChangeView} value={view} />
        {state.phase !== 'live' ? (
        <Text style={[styles.connection, { color: theme.muted }]}>{state.detail}</Text>
      ) : null}

      </View>
      {view === 'chats' ? (
        <ChatList active={active} refreshing={refreshing} onRefresh={onRefresh} onSelectRow={onSelectRow} hostId={hostId} state={state} onSelectPane={onSelectPane} selectedPaneId={selectedPaneId} />
      ) : <ScrollView keyboardShouldPersistTaps="handled" refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={theme.muted} /> : undefined} contentContainerStyle={styles.scroll}>{view === 'attention' ? (
        <AttentionList
          groups={groups}
          onSelectRow={onSelectRow}
          selectedPaneId={selectedPaneId}
          usage={state.usage}
        />
      ) : (
        <>
          <SessionTree
            groups={tree}
            onSelectPane={onSelectPane}
            selectedPaneId={selectedPaneId}
          />
          {tree.length === 0 ? (
            <EmptyState body="Waiting for the daemon's first snapshot." title="No tmux sessions" />
          ) : null}
        </>
      )}</ScrollView>}
    </View>
  )
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, gap: 12 },
  header: { paddingHorizontal: 16, gap: 12, zIndex: 1 },
  scroll: { paddingHorizontal: 16, paddingBottom: 112, gap: 12 },
  connection: { fontSize: 12.5 },
})

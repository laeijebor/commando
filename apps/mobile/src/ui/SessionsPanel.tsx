import { useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
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

export type SessionsView = 'attention' | 'tree'

const VIEW_OPTIONS = [
  { value: 'attention' as const, label: 'Attention' },
  { value: 'tree' as const, label: 'Tree' },
]

/**
 * The Attention / Tree choice, remembered per device as the spec agreed. The
 * phone screen and the iPad cockpit share one preference, so the list looks the
 * same however it is being held.
 */
export function useSessionsView(): [SessionsView, (next: SessionsView) => void] {
  const [view, setView] = useState<SessionsView>('attention')

  useEffect(() => {
    void readPreference(SESSIONS_VIEW_PREFERENCE_KEY).then((stored) => {
      if (stored === 'attention' || stored === 'tree') setView(stored)
    })
  }, [])

  return [view, (next: SessionsView): void => {
    setView(next)
    void Haptics.selectionAsync()
    void writePreference(SESSIONS_VIEW_PREFERENCE_KEY, next)
  }]
}

export type SessionsPanelProps = {
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
 * Screen 02's content: the usage tiles and the attention inbox, or the repo →
 * session → window → pane tree, under the segmented toggle. It draws no
 * scroller and no chrome, so it can be the phone's screen or the cockpit's
 * 300pt left column unchanged.
 */
export function SessionsPanel({
  state,
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
      <Segmented options={VIEW_OPTIONS} onChange={onChangeView} value={view} />

      {state.phase !== 'live' ? (
        <Text style={[styles.connection, { color: theme.muted }]}>{state.detail}</Text>
      ) : null}

      {view === 'attention' ? (
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
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  panel: { gap: 12 },
  connection: { fontSize: 12.5 },
})

import { useEffect, useMemo } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useIsFocused, useRouter } from 'expo-router'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import { buildAgentRows, pendingRequest } from '../agents/selectors'
import type { HostDaemonState } from '../daemon/state'
import { useDaemonConnection } from '../daemon/useDaemonConnection'
import { useHostsStore } from '../hosts/store'
import type { Host } from '../hosts/types'
import { PaneView } from '../terminal/PaneView'
import { canStream } from '../tiles/list'
import { relativeTime } from '../time'
import { useTheme } from '../theme'
import { AnswerCards } from '../ui/AnswerScreen'
import { PaneInfoSections } from '../ui/PaneInfo'
import { Button, Card, Dot, EmptyState, Meta, Pill, SectionHeader } from '../ui/primitives'
import { SessionsPanel, useSessionsView } from '../ui/SessionsPanel'
import { chooseFocusedPane } from './focus'
import { useFocusedPaneId, useFocusStore } from './focusStore'
import { HUD_COLUMN_WIDTH, SESSIONS_COLUMN_WIDTH, type LayoutMode } from './useLayoutMode'

/** The HUD column shows everything but the screenshots, which stay in the sheet. */
const HUD_SECTIONS = ['worklog', 'changes', 'pr', 'ports'] as const

export type WideCockpitProps = {
  hostId: string
  /** `wide` draws three columns; `tablet` puts the sessions list in a sheet. */
  mode: Exclude<LayoutMode, 'phone'>
  /** A pane a deep link asked for, focused once when it arrives. */
  focusRequest?: string | undefined
  /** Whether the sessions sheet is open (tablet only). */
  sheetOpen: boolean
  onSheetOpenChange: (open: boolean) => void
}

/**
 * Screen 10. Sessions on the left, the focused pane in the middle, the HUD —
 * the pending question, then the worklog, changes, PR and ports — on the right,
 * all under one status row, exactly like the desktop cockpit.
 *
 * Every column is the component the phone already uses: `SessionsPanel`,
 * `PaneView`, `AnswerCards` and `PaneInfoSections`. Picking a row here changes
 * the focused pane instead of navigating, so nothing is ever covered up.
 */
export function WideCockpit({
  hostId,
  mode,
  focusRequest,
  sheetOpen,
  onSheetOpenChange,
}: WideCockpitProps): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const screenFocused = useIsFocused()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)
  const [view, changeView] = useSessionsView()

  const stored = useFocusedPaneId(hostId)
  const focus = useFocusStore((store) => store.focus)

  const rows = useMemo(
    () => buildAgentRows({
      statuses: state.agentStatuses,
      snapshot: state.snapshot,
      briefs: state.briefs,
    }),
    [state.agentStatuses, state.snapshot, state.briefs],
  )
  const paneIds = useMemo(
    () => (state.snapshot?.panes ?? []).map((pane) => pane.id),
    [state.snapshot],
  )
  const paneId = chooseFocusedPane({ rows, current: stored, paneIds })

  // A notification or a `/pane/…` link asks for a pane by id; it wins over the
  // rules for as long as that pane exists.
  useEffect(() => {
    if (focusRequest) focus(hostId, focusRequest)
  }, [focus, focusRequest, hostId])

  const focusPane = (next: string): void => {
    void Haptics.selectionAsync()
    focus(hostId, next)
    onSheetOpenChange(false)
  }

  const sessions = (
    <SessionsPanel
      onChangeView={changeView}
      onSelectPane={focusPane}
      onSelectRow={(row) => focusPane(row.paneId)}
      selectedPaneId={paneId}
      state={state}
      view={view}
    />
  )

  const sessionsColumn = (
    <View style={styles.sessionsInner}>
      <ScrollView contentContainerStyle={styles.sessionsBody}>{sessions}</ScrollView>
      <View style={[styles.sessionsFooter, { borderTopColor: theme.border }]}>
        <Button
          label="+ New session"
          onPress={() => {
            onSheetOpenChange(false)
            router.push({ pathname: '/(host)/[hostId]/new-session', params: { hostId } })
          }}
        />
      </View>
    </View>
  )

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <CockpitStatusRow
        host={host}
        onOpenSessions={mode === 'tablet' ? () => onSheetOpenChange(true) : undefined}
        state={state}
      />

      <View style={styles.columns}>
        {mode === 'wide' ? (
          <View
            style={[styles.sessionsColumn, { borderRightColor: theme.border }]}
          >
            {sessionsColumn}
          </View>
        ) : null}

        <View style={styles.terminalColumn}>
          {paneId ? (
            <PaneView
              active={screenFocused}
              host={host}
              onOpenTile={(tile) => {
                // Same rule as the phone: a streaming tile opens itself, and
                // anything else goes to the list that can act on it.
                if (canStream(tile)) {
                  router.push({
                    pathname: '/(host)/[hostId]/tile/[tileId]',
                    params: { hostId, tileId: tile.id },
                  })
                  return
                }
                router.push({ pathname: '/(host)/[hostId]/tiles', params: { hostId } })
              }}
              onSelectWindow={(chip) => {
                if (chip.targetPaneId) focusPane(chip.targetPaneId)
              }}
              paneId={paneId}
            />
          ) : (
            <EmptyState
              body={state.phase === 'live'
                ? 'Start a session, or wait for an agent to report in.'
                : state.detail}
              title="No pane to show"
            />
          )}
        </View>

        <View style={[styles.hudColumn, { borderLeftColor: theme.border }]}>
          <HudColumn host={host} paneId={paneId} state={state} />
        </View>
      </View>

      <Modal
        animationType="slide"
        onRequestClose={() => onSheetOpenChange(false)}
        transparent
        visible={mode === 'tablet' && sheetOpen}
      >
        <View style={styles.sheetRow}>
          <View
            style={[styles.sheet, { backgroundColor: theme.bg, borderRightColor: theme.borderMid }]}
          >
            <SafeAreaView edges={['top', 'left']} style={styles.sheetSafe}>
              <View style={styles.sheetHead}>
                <Text style={[styles.sheetTitle, { color: theme.text }]}>Sessions</Text>
                <Pressable accessibilityRole="button" onPress={() => onSheetOpenChange(false)}>
                  <Text style={[styles.sheetDone, { color: theme.accent }]}>Done</Text>
                </Pressable>
              </View>
              {sessionsColumn}
            </SafeAreaView>
          </View>
          <Pressable
            accessibilityLabel="Dismiss the sessions list"
            onPress={() => onSheetOpenChange(false)}
            style={styles.sheetBackdrop}
          />
        </View>
      </Modal>
    </SafeAreaView>
  )
}

/** Host name, connection phase and snapshot revision, as in the mockup's status row. */
function CockpitStatusRow({
  host,
  state,
  onOpenSessions,
}: {
  host: Host | undefined
  state: HostDaemonState
  onOpenSessions?: (() => void) | undefined
}): React.JSX.Element {
  const theme = useTheme()
  const live = state.phase === 'live'
  return (
    <View style={[styles.statusRow, { borderBottomColor: theme.border }]}>
      {onOpenSessions ? (
        <Pressable
          accessibilityLabel="Show sessions"
          accessibilityRole="button"
          onPress={onOpenSessions}
          style={styles.statusButton}
        >
          <Feather color={theme.accent} name="sidebar" size={16} />
          <Text style={[styles.statusButtonLabel, { color: theme.accent }]}>Sessions</Text>
        </Pressable>
      ) : null}
      <Text style={[styles.statusHost, { color: theme.text }]}>{host?.name ?? 'host'}</Text>
      <Dot size={7} tone={live ? 'green' : state.phase === 'unauthorized' ? 'amber' : 'muted'} />
      <Text style={[styles.statusDetail, { color: theme.muted }]} numberOfLines={1}>
        {live ? 'live' : state.detail}
      </Text>
      <View style={styles.statusSpacer} />
      {state.snapshot ? (
        <Text style={[styles.statusRevision, { color: theme.textDim }]}>
          r{state.snapshot.revision}
          {state.updatedAt ? ` · ${relativeTime(state.updatedAt) || 'now'}` : ''}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * The right column: whatever the focused pane is waiting on, answered in place,
 * and the Info sections under it.
 */
function HudColumn({
  host,
  paneId,
  state,
}: {
  host: Host | undefined
  paneId: string | undefined
  state: HostDaemonState
}): React.JSX.Element {
  const status = paneId ? state.agentStatuses[paneId] : undefined
  const request = status ? pendingRequest(status) : undefined
  const pane = state.snapshot?.panes.find((candidate) => candidate.id === paneId)
  const session = state.snapshot?.sessions.find((candidate) => candidate.id === pane?.sessionId)
  const sessionName = session?.name ?? status?.agentSessionName ?? 'pane'

  if (!host || !paneId) {
    return (
      <View style={styles.hudEmpty}>
        <Meta>The HUD follows the focused pane.</Meta>
      </View>
    )
  }

  return (
    <ScrollView contentContainerStyle={styles.hudBody}>
      {request ? (
        <View style={styles.hudRequest}>
          <SectionHeader
            label={request.kind === 'permission' ? 'Permission' : 'Question'}
            note={relativeTime(request.createdAt) || 'now'}
          />
          <AnswerCards
            detail={state.detail}
            host={host}
            live={state.phase === 'live'}
            onAnswered={() => undefined}
            paneId={paneId}
            request={request}
            sessionName={sessionName}
            status={status}
          />
        </View>
      ) : (
        <Card style={styles.hudIdle}>
          <View style={styles.hudIdleHead}>
            <Pill label="Nothing pending" tone="mute" />
          </View>
          <Meta>
            {status
              ? `${sessionName} is not waiting on you.`
              : 'This pane has no agent reporting on it.'}
          </Meta>
        </Card>
      )}

      <PaneInfoSections
        brief={state.briefs[paneId]}
        host={host}
        // A new pane starts from nothing rather than showing the last one's
        // diff until the poll comes back.
        key={paneId}
        pane={pane}
        paneId={paneId}
        ports={state.snapshot?.ports ?? []}
        sections={HUD_SECTIONS}
        status={status}
      />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusButton: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingRight: 4 },
  statusButtonLabel: { fontSize: 13.5, fontWeight: '600' },
  statusHost: { fontSize: 14, fontWeight: '700' },
  statusDetail: { fontSize: 12.5, flexShrink: 1 },
  statusSpacer: { flex: 1 },
  statusRevision: { fontSize: 12, fontVariant: ['tabular-nums'] },
  columns: { flex: 1, flexDirection: 'row', minHeight: 0 },
  sessionsColumn: { width: SESSIONS_COLUMN_WIDTH, borderRightWidth: 1 },
  sessionsInner: { flex: 1, minHeight: 0 },
  sessionsBody: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 16, gap: 12 },
  sessionsFooter: { padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
  terminalColumn: { flex: 1, minWidth: 0 },
  hudColumn: { width: HUD_COLUMN_WIDTH, borderLeftWidth: 1 },
  hudBody: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 32, gap: 12 },
  hudRequest: { gap: 10 },
  hudIdle: { gap: 8 },
  hudIdleHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hudEmpty: { padding: 16 },
  sheetRow: { flex: 1, flexDirection: 'row' },
  sheet: { width: SESSIONS_COLUMN_WIDTH + 20, borderRightWidth: 1 },
  sheetSafe: { flex: 1 },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sheetTitle: { fontSize: 20, fontWeight: '800' },
  sheetDone: { fontSize: 15, fontWeight: '600' },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
})

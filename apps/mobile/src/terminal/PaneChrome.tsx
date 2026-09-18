import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import type { AgentStatus } from '@commando/protocol'

import { statusLabel, useTheme } from '../theme'
import { Dot, ProgressBar, StatusDot, withAlpha } from '../ui/primitives'
import { tileLabel, type PaneContext, type PaneWindowChip } from './paneContext'

/**
 * The nav row from mockup 03: back to the sessions list, the session name with
 * window · pane · provider · branch under it, the "Fit to phone" lease toggle
 * and Info.
 */
export function PaneNav({
  title,
  subtitle,
  fit,
  onToggleFit,
  onBack,
  onInfo,
}: {
  title: string
  subtitle: string
  fit: boolean
  onToggleFit: () => void
  /** Omitted in the iPad cockpit, where the pane is a column and not a screen. */
  onBack?: () => void
  /** Omitted when the Info sections are already beside the terminal. */
  onInfo?: () => void
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={styles.nav}>
      {onBack ? (
        <Pressable accessibilityLabel="Back to sessions" accessibilityRole="button" onPress={onBack}>
          <Feather color={theme.accent} name="chevron-left" size={26} />
        </Pressable>
      ) : null}
      <View style={styles.navTitle}>
        <Text numberOfLines={1} style={[styles.navTitleText, { color: theme.text }]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={[styles.navSubtitle, { color: theme.muted }]}>
          {subtitle}
        </Text>
      </View>
      <Pressable
        accessibilityLabel="Fit pane to phone"
        accessibilityRole="switch"
        accessibilityState={{ checked: fit }}
        onPress={onToggleFit}
        style={[
          styles.fit,
          {
            backgroundColor: fit ? withAlpha(theme.accent, 0.2) : theme.surfaceSoft,
            borderColor: fit ? withAlpha(theme.accent, 0.4) : theme.borderMid,
          },
        ]}
      >
        <Feather color={fit ? theme.accent : theme.muted} name="minimize-2" size={13} />
        <Text style={[styles.fitLabel, { color: fit ? theme.accent : theme.muted }]}>Fit</Text>
      </Pressable>
      {onInfo ? (
        <Pressable accessibilityLabel="Pane info" accessibilityRole="button" onPress={onInfo}>
          <Text style={[styles.action, { color: theme.accent }]}>Info</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/**
 * Window chips for the session, with a dot on any window holding a pane that
 * needs the owner, followed by the tiles anchored in this window.
 */
export function PaneChips({
  context,
  onSelectWindow,
  onOpenTiles,
}: {
  context: PaneContext
  onSelectWindow: (chip: PaneWindowChip) => void
  onOpenTiles: () => void
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <ScrollView
      contentContainerStyle={styles.chipsContent}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chips}
    >
      {context.windows.map((chip) => (
        <Pressable
          accessibilityLabel={`Window ${chip.name}`}
          accessibilityRole="tab"
          accessibilityState={{ selected: chip.active }}
          key={chip.id}
          onPress={() => onSelectWindow(chip)}
          style={[
            styles.chip,
            {
              backgroundColor: chip.active ? theme.surfaceSoft : theme.surface,
              borderColor: chip.active ? theme.borderStrong : theme.border,
            },
          ]}
        >
          {chip.attention ? <Dot size={6} tone="amber" /> : null}
          <Text style={[styles.chipLabel, { color: chip.active ? theme.text : theme.muted }]}>
            {chip.name}
          </Text>
        </Pressable>
      ))}
      {context.tiles.map((tile) => (
        <Pressable
          accessibilityLabel={`Tile ${tileLabel(tile)}`}
          accessibilityRole="button"
          key={tile.id}
          onPress={onOpenTiles}
          style={[styles.chip, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
          <Feather color={theme.cyan} name="layout" size={12} />
          <Text style={[styles.chipLabel, { color: theme.muted }]}>{tileLabel(tile)}</Text>
        </Pressable>
      ))}
    </ScrollView>
  )
}

/**
 * The HUD strip, mirroring the desktop's agent card: status, what the agent is
 * doing (or what it is waiting to be told), and its task progress.
 */
export function PaneHud({ status }: { status: AgentStatus }): React.JSX.Element {
  const theme = useTheme()
  const details = status.details
  const request = details?.requests?.[0]
  const detail =
    request?.questions?.[0]?.question ??
    request?.prompt ??
    details?.attention ??
    details?.currentActivity?.label ??
    status.summary
  const progress = details?.progress
  const ratio = progress && progress.total > 0 ? progress.completed / progress.total : null

  return (
    <View style={[styles.hud, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}>
      <View style={styles.hudLine}>
        <StatusDot size={9} status={status.status} />
        <Text style={[styles.hudStatus, { color: theme.text }]}>{statusLabel(status.status)}</Text>
        <Text numberOfLines={1} style={[styles.hudDetail, { color: theme.muted }]}>
          {detail}
        </Text>
        {progress ? (
          <Text style={[styles.hudCount, { color: theme.textDim }]}>
            {progress.completed}/{progress.total}
          </Text>
        ) : null}
      </View>
      {ratio === null ? null : (
        <ProgressBar ratio={ratio} tone={status.status === 'needs_input' ? 'amber' : 'accent'} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  navTitle: { flex: 1, minWidth: 0 },
  navTitleText: { fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  navSubtitle: { fontSize: 12 },
  action: { fontSize: 15, fontWeight: '600' },
  fit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  fitLabel: { fontSize: 12.5, fontWeight: '700' },
  chips: { flexGrow: 0, flexShrink: 0 },
  chipsContent: { gap: 6, paddingHorizontal: 12 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipLabel: { fontSize: 12.5, fontWeight: '600' },
  hud: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, gap: 6, marginHorizontal: 12 },
  hudLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hudStatus: { fontSize: 13, fontWeight: '600' },
  hudDetail: { flex: 1, minWidth: 0, fontSize: 13 },
  hudCount: { fontSize: 12 },
})

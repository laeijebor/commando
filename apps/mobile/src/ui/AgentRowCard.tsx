import { Pressable, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import type { AgentRow } from '../agents/selectors'
import { relativeTime } from '../time'
import { statusColor, useTheme } from '../theme'
import { ProgressBar, ProviderPill, StatusDot, withAlpha } from './primitives'

/**
 * One agent pane in the attention inbox: tmux session name, provider chip, the
 * HUD headline (or the pending question), the current activity line and a todo
 * progress bar, with a relative stamp on the right — screen 02 of the mockup.
 */
export function AgentRowCard({
  row,
  onPress,
}: {
  row: AgentRow
  onPress?: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const hot = row.group === 'needs_you'
  // A Needs-you row goes to the answer screen rather than the pane, so it says
  // so instead of showing the plain chevron.
  const answerable = hot && row.pendingQuestionCount > 0
  const progress = row.progress
  const accent = statusColor(theme, row.status.status)

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={answerable ? 'Opens the answer screen' : 'Opens the pane'}
      accessibilityLabel={`${row.sessionName}: ${row.headline}`}
      onPress={onPress}
      style={[
        styles.row,
        {
          backgroundColor: theme.surface,
          borderColor: hot ? withAlpha(theme.amber, 0.45) : theme.border,
        },
      ]}
    >
      <StatusDot status={row.status.status} size={hot ? 10 : 8} />
      <View style={styles.text}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.session, { color: theme.text }]}>
            {row.sessionName}
          </Text>
          <ProviderPill provider={row.provider} />
        </View>
        <Text numberOfLines={1} style={[styles.headline, { color: theme.textSoft }]}>
          {row.headline}
        </Text>
        {row.activity || row.windowName ? (
          <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
            {[row.activity, row.windowName ? `window ${row.windowName}` : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        ) : null}
        {progress && progress.total > 0 ? (
          <View style={styles.progress}>
            <ProgressBar
              ratio={progress.completed / progress.total}
              tone={row.status.status === 'working' ? 'accent' : 'green'}
            />
            <Text style={[styles.meta, { color: theme.muted }]}>
              {progress.completed}/{progress.total} tasks
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.when}>
        <Text style={[styles.stamp, { color: theme.textDim }]}>{relativeTime(row.updatedAt)}</Text>
        {answerable ? (
          <Text style={[styles.answer, { color: accent }]}>Answer</Text>
        ) : (
          <Feather color={hot ? accent : theme.textFaint} name="chevron-right" size={16} />
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  text: { flex: 1, gap: 3 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  session: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  headline: { fontSize: 13.5 },
  meta: { fontSize: 12 },
  progress: { gap: 4, paddingTop: 2 },
  when: { alignItems: 'flex-end', gap: 6 },
  stamp: { fontSize: 12, fontVariant: ['tabular-nums'] },
  answer: { fontSize: 13, fontWeight: '600' },
})

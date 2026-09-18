import { Pressable, StyleSheet, Text, View } from 'react-native'

import type { WebPanePendingSnapshot } from '@commando/protocol'

import { useTheme } from '../theme'
import { Button, withAlpha } from '../ui/primitives'
import { pendingChipLabel } from './editor'

const MAX_CHIPS = 3

/**
 * The strip along the bottom of the mockup: what is queued, and the two ways
 * to hand it to the agent. Tapping the chips opens the whole queue.
 */
export function PendingStrip({
  pending,
  busy,
  onOpenQueue,
  onSendAll,
  onSendAndBuild,
  onDismissDropped,
}: {
  pending: WebPanePendingSnapshot
  busy: boolean
  onOpenQueue: () => void
  onSendAll: () => void
  onSendAndBuild: () => void
  onDismissDropped: () => void
}): React.JSX.Element | null {
  const theme = useTheme()
  const count = pending.notes.length
  if (count === 0 && pending.dropped === 0) return null

  const chips = pending.notes.slice(0, MAX_CHIPS)
  const extra = count - chips.length

  return (
    <View style={styles.wrapper}>
      {pending.dropped > 0 ? (
        <Pressable
          accessibilityHint="Dismisses this warning"
          accessibilityRole="button"
          onPress={onDismissDropped}
          style={[
            styles.dropped,
            { backgroundColor: withAlpha(theme.red, 0.12), borderColor: withAlpha(theme.red, 0.35) },
          ]}
        >
          <Text style={[styles.droppedText, { color: theme.red }]}>
            {pending.dropped === 1
              ? '1 page answer was dropped — the queue was full.'
              : `${pending.dropped} page answers were dropped — the queue was full.`}
          </Text>
        </Pressable>
      ) : null}

      {count > 0 ? (
        <View
          style={[
            styles.strip,
            { backgroundColor: theme.surfaceRaised, borderColor: theme.borderMid },
          ]}
        >
          <Pressable
            accessibilityLabel={`${count} queued items. Opens the queue.`}
            accessibilityRole="button"
            onPress={onOpenQueue}
            style={styles.chips}
          >
            {chips.map((note) => (
              <View
                key={note.id}
                style={[
                  styles.chip,
                  {
                    backgroundColor: withAlpha(note.response ? theme.green : theme.amber, 0.14),
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.chipText, { color: note.response ? theme.green : theme.amber }]}
                >
                  {pendingChipLabel(note)}
                </Text>
              </View>
            ))}
            {extra > 0 ? (
              <View style={[styles.chip, { backgroundColor: theme.surfaceSoft }]}>
                <Text style={[styles.chipText, { color: theme.muted }]}>+{extra}</Text>
              </View>
            ) : null}
          </Pressable>

          <Button busy={busy} label="Send all" onPress={onSendAll} style={styles.send} />
          <Button
            busy={busy}
            label="Send + Build"
            onPress={onSendAndBuild}
            style={styles.send}
            variant="primary"
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: { gap: 8 },
  dropped: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  droppedText: { fontSize: 12, lineHeight: 17 },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 8,
  },
  chips: { flex: 1, minWidth: 0, flexDirection: 'row', gap: 6, alignItems: 'center' },
  chip: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, maxWidth: 120 },
  chipText: { fontSize: 11, fontWeight: '600' },
  send: { paddingVertical: 9, paddingHorizontal: 10, minHeight: 36 },
})

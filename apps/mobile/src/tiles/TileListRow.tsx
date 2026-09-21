import { useMemo, useRef } from 'react'
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import { useTheme } from '../theme'
import { Button, Card, Pill, withAlpha } from '../ui/primitives'
import { canStream, unstreamableReason, type TileRow } from './list'

const CLOSE_TRAVEL = 96

/**
 * One tile in the list. Swiping left uncovers Close, which is the same DELETE
 * the long press offers — a phone needs both because a swipe is quicker and a
 * long press is discoverable.
 */
export function TileListRow({
  row,
  busy,
  onOpen,
  onClose,
  onConfirm,
  onReopenAsChromium,
}: {
  row: TileRow
  busy: boolean
  onOpen: () => void
  onClose: () => void
  onConfirm: (allowOrigin: boolean) => void
  onReopenAsChromium: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const offset = useRef(new Animated.Value(0)).current

  const settle = (to: number): void => {
    Animated.spring(offset, { toValue: to, useNativeDriver: true, bounciness: 0 }).start()
  }

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Only claim the gesture once it is clearly a horizontal drag, so the
        // list still scrolls and the row still taps.
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderMove: (_event, gesture) => {
          offset.setValue(Math.min(0, Math.max(-CLOSE_TRAVEL, gesture.dx)))
        },
        onPanResponderRelease: (_event, gesture) => {
          settle(gesture.dx < -CLOSE_TRAVEL / 2 ? -CLOSE_TRAVEL : 0)
        },
        onPanResponderTerminate: () => settle(0),
      }),
    [offset],
  )

  const streamable = canStream(row.tile)
  const reason = unstreamableReason(row.tile)

  return (
    <View style={styles.row}>
      <View style={[styles.closeTrack, { backgroundColor: withAlpha(theme.red, 0.14) }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close the tile at ${row.host}${row.path}`}
          disabled={busy}
          onPress={() => {
            settle(0)
            onClose()
          }}
          style={styles.closeAction}
        >
          <Feather color={theme.red} name="x" size={18} />
          <Text style={[styles.closeLabel, { color: theme.red }]}>Close</Text>
        </Pressable>
      </View>

      <Animated.View style={{ transform: [{ translateX: offset }] }} {...panResponder.panHandlers}>
        <Pressable
          accessibilityRole="button"
          accessibilityHint={streamable ? 'Opens the tile stream' : undefined}
          disabled={!streamable || busy}
          onLongPress={() => settle(-CLOSE_TRAVEL)}
          onPress={onOpen}
        >
          <Card>
            <View style={styles.header}>
              <View style={styles.identity}>
                <Text numberOfLines={1} style={[styles.host, { color: theme.text }]}>{row.host}</Text>
                <Text numberOfLines={1} style={[styles.path, { color: theme.muted }]}>{row.path}</Text>
              </View>
              <Pill label={row.engine} tone={row.engine === 'chromium' ? 'claude' : 'mute'} />
            </View>

            <View style={styles.meta}>
              <Text numberOfLines={1} style={[styles.metaText, { color: theme.textDim }]}>
                {row.opener} · beside {row.anchor}
              </Text>
              {row.queued > 0 ? (
                <Pill label={`${row.queued} queued`} tone="warn" />
              ) : null}
            </View>

            {row.awaitingConfirmation ? (
              <View style={[styles.confirm, { borderColor: withAlpha(theme.amber, 0.45) }]}>
                <Text style={[styles.confirmTitle, { color: theme.text }]}>
                  An agent wants to open an external origin
                </Text>
                <Text style={[styles.confirmBody, { color: theme.muted }]}>
                  Nothing loads until you say so. Allowing the origin skips this card for every
                  later tile on {row.host}.
                </Text>
                <View style={styles.confirmActions}>
                  <Button
                    disabled={busy}
                    label="Open"
                    onPress={() => onConfirm(false)}
                    style={styles.confirmButton}
                    variant="primary"
                  />
                  <Button
                    disabled={busy}
                    label="Always allow this origin"
                    onPress={() => onConfirm(true)}
                    style={styles.confirmButton}
                  />
                </View>
              </View>
            ) : row.engine === 'webkit' ? (
              <View style={[styles.confirm, { borderColor: theme.borderMid }]}>
                <Text style={[styles.confirmBody, { color: theme.muted }]}>
                  {reason}. Reopening it as a chromium tile streams it here — the tile closes and
                  comes back in the same place.
                </Text>
                <Button
                  busy={busy}
                  label="Reopen as chromium"
                  onPress={onReopenAsChromium}
                  style={styles.confirmButton}
                />
              </View>
            ) : null}
          </Card>
        </Pressable>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { position: 'relative' },
  closeTrack: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: CLOSE_TRAVEL,
    borderRadius: 16,
    justifyContent: 'center',
  },
  closeAction: { alignItems: 'center', gap: 4, minHeight: 44, justifyContent: 'center' },
  closeLabel: { fontSize: 12, fontWeight: '700' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  identity: { flex: 1, minWidth: 0, gap: 1 },
  host: { fontSize: 14.5, fontWeight: '600' },
  path: { fontSize: 12.5 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  metaText: { fontSize: 12, flex: 1, minWidth: 0 },
  confirm: { marginTop: 10, borderWidth: 1, borderRadius: 12, padding: 10, gap: 8 },
  confirmTitle: { fontSize: 13.5, fontWeight: '600' },
  confirmBody: { fontSize: 12.5, lineHeight: 18 },
  confirmActions: { gap: 8 },
  confirmButton: { paddingVertical: 10 },
})

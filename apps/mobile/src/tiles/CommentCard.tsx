import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'

import { useTheme } from '../theme'
import { Button, withAlpha } from '../ui/primitives'
import type { TileInspectSuccess } from './protocol'

/**
 * The card the mockup anchors under a tapped element: what was hit, and one
 * field for what is wrong with it. Saving queues a pending note in the
 * daemon; it is not sent to the agent until the owner sends the queue.
 */
export function CommentCard({
  target,
  busy,
  onCancel,
  onSubmit,
}: {
  target: TileInspectSuccess
  busy: boolean
  onCancel: () => void
  onSubmit: (comment: string) => void
}): React.JSX.Element {
  const theme = useTheme()
  const [comment, setComment] = useState('')
  const ready = comment.trim().length > 0 && !busy

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.surface, borderColor: theme.amber, shadowColor: '#000' },
      ]}
    >
      <View style={styles.target}>
        <View style={[styles.tag, { backgroundColor: withAlpha(theme.amber, 0.16) }]}>
          <Text style={[styles.tagText, { color: theme.amber }]}>{target.tag}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.selector, { color: theme.muted }]}>
          {target.selector}
        </Text>
      </View>

      {target.text ? (
        <Text numberOfLines={2} style={[styles.text, { color: theme.textSoft }]}>{target.text}</Text>
      ) : null}

      <TextInput
        accessibilityLabel="What is wrong with this?"
        autoFocus
        multiline
        onChangeText={setComment}
        placeholder="What's wrong with this?"
        placeholderTextColor={theme.textDim}
        style={[
          styles.input,
          { backgroundColor: theme.surfaceRaised, borderColor: theme.border, color: theme.text },
        ]}
        value={comment}
      />

      <View style={styles.actions}>
        <Button disabled={busy} label="Cancel" onPress={onCancel} style={styles.action} />
        <Button
          busy={busy}
          disabled={!ready}
          label="Queue note"
          onPress={() => onSubmit(comment.trim())}
          style={styles.action}
          variant="primary"
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 8,
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
  },
  target: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tag: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  tagText: { fontSize: 10.5, fontWeight: '700' },
  selector: { fontSize: 11.5, flex: 1, minWidth: 0 },
  text: { fontSize: 12, lineHeight: 17 },
  input: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14, minHeight: 68 },
  actions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  action: { flex: 1, paddingVertical: 10 },
})

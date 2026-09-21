import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { WebPanePendingSnapshot } from '@commando/protocol'
import { MAX_PENDING_NOTES } from '@commando/protocol'

import { useTheme } from '../theme'
import { Button, EmptyState } from '../ui/primitives'
import { PendingEditorCard } from './PendingEditorCard'

/**
 * Everything queued for this tile, each item with its editor. The strip only
 * has room for three chips; this is where the rest lives.
 */
export function QueueDrawer({
  visible,
  pending,
  busyNoteId,
  busy,
  onClose,
  onSave,
  onRemove,
  onSend,
  onSendAll,
  onSendAndBuild,
}: {
  visible: boolean
  pending: WebPanePendingSnapshot
  busyNoteId: number | null
  busy: boolean
  onClose: () => void
  onSave: (noteId: number, change: { answer: string; note: string }, expectedRevision: number) => void
  onRemove: (noteId: number) => void
  onSend: (noteId: number, revision: number) => void
  onSendAll: () => void
  onSendAndBuild: () => void
}): React.JSX.Element {
  const theme = useTheme()

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={visible}>
      <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
        <View style={[styles.nav, { borderBottomColor: theme.border }]}>
          <Pressable accessibilityRole="button" onPress={onClose}>
            <Text style={[styles.navAction, { color: theme.accent }]}>Done</Text>
          </Pressable>
          <Text style={[styles.navTitle, { color: theme.text }]}>
            {pending.notes.length} queued
          </Text>
          <Text style={[styles.navHint, { color: theme.textDim }]}>of {MAX_PENDING_NOTES}</Text>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {pending.notes.length === 0 ? (
            <EmptyState
              body="Answer a redline control in the page, or tap an element in review mode, and it lands here."
              title="Nothing queued"
            />
          ) : (
            pending.notes.map((note) => (
              <PendingEditorCard
                busy={busy && busyNoteId === note.id}
                key={note.id}
                note={note}
                onRemove={() => onRemove(note.id)}
                onSave={(change, expectedRevision) => onSave(note.id, change, expectedRevision)}
                onSend={() => onSend(note.id, note.revision ?? 1)}
              />
            ))
          )}
        </ScrollView>

        {pending.notes.length > 0 ? (
          <View style={[styles.footer, { borderTopColor: theme.border, backgroundColor: theme.surface }]}>
            <Button busy={busy} label="Send all" onPress={onSendAll} style={styles.footerButton} />
            <Button
              busy={busy}
              label="Send all + Build"
              onPress={onSendAndBuild}
              style={styles.footerButton}
              variant="primary"
            />
          </View>
        ) : null}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  navTitle: { fontSize: 17, fontWeight: '700' },
  navAction: { fontSize: 15, fontWeight: '600' },
  navHint: { fontSize: 12 },
  body: { padding: 16, paddingBottom: 32, gap: 12 },
  footer: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1 },
  footerButton: { flex: 1, paddingVertical: 11 },
})

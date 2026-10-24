import { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { WebPanePendingSnapshot } from '@commando/protocol'

import { useTheme } from '../../theme'
import { PendingEditorCard } from '../PendingEditorCard'
import { PendingStrip } from '../PendingStrip'
import { QueueDrawer } from '../QueueDrawer'
import type { useQueueActions } from '../useQueueActions'

/**
 * The pending strip, the queue drawer and the single-item sheet, as the
 * screencast tile has them, for the views that render the page natively.
 */
export function QueueChrome({
  pending,
  queue,
  selectedNoteId,
  onSelectNote,
}: {
  pending: WebPanePendingSnapshot
  queue: ReturnType<typeof useQueueActions>
  selectedNoteId: number | null
  onSelectNote: (noteId: number | null) => void
}): React.JSX.Element {
  const theme = useTheme()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const selected = pending.notes.find((note) => note.id === selectedNoteId)

  const sendAll = (intent: 'send' | 'build'): void => {
    void queue.sendAll(intent).then((sent) => {
      if (!sent) return
      setDrawerOpen(false)
      onSelectNote(null)
    })
  }
  const sendOne = (noteId: number, revision: number): void => {
    void queue.sendOne(noteId, revision).then((sent) => {
      if (sent) onSelectNote(null)
    })
  }
  const remove = (noteId: number): void => {
    void queue.removeNote(noteId).then((removed) => {
      if (removed && selectedNoteId === noteId) onSelectNote(null)
    })
  }
  const save = (noteId: number, change: { answer: string; note: string }, expectedRevision: number): void => {
    void queue.saveNote(noteId, change, expectedRevision)
  }

  return (
    <>
      <PendingStrip
        busy={queue.busy}
        onDismissDropped={() => void queue.dismissDropped()}
        onOpenQueue={() => setDrawerOpen(true)}
        onSendAll={() => sendAll('send')}
        onSendAndBuild={() => sendAll('build')}
        pending={pending}
      />
      <QueueDrawer
        busy={queue.busy}
        busyNoteId={queue.busyNoteId}
        onClose={() => setDrawerOpen(false)}
        onRemove={remove}
        onSave={save}
        onSend={sendOne}
        onSendAll={() => sendAll('send')}
        onSendAndBuild={() => sendAll('build')}
        pending={pending}
        visible={drawerOpen}
      />
      <Modal
        animationType="slide"
        onRequestClose={() => onSelectNote(null)}
        presentationStyle="pageSheet"
        visible={selected !== undefined}
      >
        <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
          <View style={[styles.sheetNav, { borderBottomColor: theme.border }]}>
            <Pressable accessibilityRole="button" onPress={() => onSelectNote(null)}>
              <Text style={[styles.done, { color: theme.accent }]}>Done</Text>
            </Pressable>
            <Text style={[styles.title, { color: theme.text }]}>Queued item</Text>
            <View style={styles.spacer} />
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody}>
            {selected ? (
              <PendingEditorCard
                busy={queue.busy}
                note={selected}
                onRemove={() => remove(selected.id)}
                onSave={(change, expectedRevision) => save(selected.id, change, expectedRevision)}
                onSend={() => sendOne(selected.id, selected.revision ?? 1)}
              />
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  sheetNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  done: { fontSize: 15, fontWeight: '600' },
  title: { fontSize: 16, fontWeight: '700' },
  spacer: { width: 44 },
  sheetBody: { padding: 16, gap: 12 },
})

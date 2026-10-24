import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import * as Haptics from 'expo-haptics'

import type { WebPanePendingSnapshot } from '@commando/protocol'

import type { Host } from '../hosts/types'
import {
  dismissDroppedAnswers,
  removePendingNote,
  sendPendingNotes,
  sendPendingNotesAndBuild,
  updatePendingNote,
} from './api'

/**
 * The pending-queue actions every tile view offers — Send all, Send + Build,
 * Send this, edit, remove, dismiss dropped — shared by the screencast and the
 * native WebView so both send the same requests with the same safety checks.
 * `onSnapshot` receives the daemon's reply; views without a push channel use
 * it to refresh at once instead of waiting for the next poll.
 */
export function useQueueActions({
  host,
  webPaneId,
  pending,
  onSnapshot,
}: {
  host: Host | undefined
  webPaneId: string | undefined
  pending: WebPanePendingSnapshot
  onSnapshot?: (snapshot: WebPanePendingSnapshot) => void
}) {
  const [busy, setBusy] = useState(false)
  const [busyNoteId, setBusyNoteId] = useState<number | null>(null)

  const report = useCallback((title: string, error: unknown): void => {
    Alert.alert(title, error instanceof Error ? error.message : 'The daemon refused the request.')
  }, [])

  const run = useCallback(
    async (action: () => Promise<void>, failure: string, noteId?: number): Promise<boolean> => {
      setBusy(true)
      setBusyNoteId(noteId ?? null)
      try {
        await action()
        return true
      } catch (error) {
        report(failure, error)
        return false
      } finally {
        setBusy(false)
        setBusyNoteId(null)
      }
    },
    [report],
  )

  const queueRevision = pending.revision

  const requireRevision = useCallback((): number | null => {
    if (typeof queueRevision === 'number') return queueRevision
    Alert.alert(
      'This daemon is too old',
      'It does not report a queue revision, so a send cannot be made safe against answers arriving underneath it. Update Commando on the host.',
    )
    return null
  }, [queueRevision])

  const accept = useCallback((snapshot: WebPanePendingSnapshot): void => {
    onSnapshot?.(snapshot)
  }, [onSnapshot])

  const sendAll = useCallback(
    (intent: 'send' | 'build'): Promise<boolean> => {
      if (!host || !webPaneId) return Promise.resolve(false)
      const revision = requireRevision()
      if (revision === null) return Promise.resolve(false)
      void Haptics.selectionAsync()
      return run(async () => {
        accept(intent === 'build'
          ? await sendPendingNotesAndBuild(host, webPaneId, { expectedQueueRevision: revision })
          : await sendPendingNotes(host, webPaneId, { expectedQueueRevision: revision }))
      }, intent === 'build' ? 'Could not send and build' : 'Could not send the queue')
    },
    [accept, host, requireRevision, run, webPaneId],
  )

  const sendOne = useCallback(
    (noteId: number, revision: number): Promise<boolean> => {
      if (!host || !webPaneId) return Promise.resolve(false)
      const queue = requireRevision()
      if (queue === null) return Promise.resolve(false)
      return run(async () => {
        accept(await sendPendingNotes(host, webPaneId, {
          targets: [{ id: noteId, revision }],
          expectedQueueRevision: queue,
        }))
      }, 'Could not send this item', noteId)
    },
    [accept, host, requireRevision, run, webPaneId],
  )

  const saveNote = useCallback(
    (noteId: number, change: { answer: string; note: string }, expectedRevision: number): Promise<boolean> => {
      if (!host || !webPaneId) return Promise.resolve(false)
      return run(
        async () => accept(await updatePendingNote(host, webPaneId, noteId, expectedRevision, change)),
        'Could not save this item',
        noteId,
      )
    },
    [accept, host, run, webPaneId],
  )

  const removeNote = useCallback(
    (noteId: number): Promise<boolean> => {
      if (!host || !webPaneId) return Promise.resolve(false)
      return run(
        async () => accept(await removePendingNote(host, webPaneId, noteId)),
        'Could not remove this item',
        noteId,
      )
    },
    [accept, host, run, webPaneId],
  )

  const dismissDropped = useCallback((): Promise<boolean> => {
    if (!host || !webPaneId) return Promise.resolve(false)
    return run(async () => accept(await dismissDroppedAnswers(host, webPaneId)), 'Could not dismiss the warning')
  }, [accept, host, run, webPaneId])

  return { busy, busyNoteId, run, sendAll, sendOne, saveNote, removeNote, dismissDropped }
}

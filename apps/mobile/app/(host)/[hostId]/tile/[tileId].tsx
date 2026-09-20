import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Alert,
  Modal,
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import type { WebPanePendingNote } from '@commando/protocol'

import { useDaemonConnection } from '../../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../../src/hosts/store'
import { useTheme } from '../../../../src/theme'
import {
  addPendingNote,
  dismissDroppedAnswers,
  removePendingNote,
  sendPendingNotes,
  sendPendingNotesAndBuild,
  updatePendingNote,
} from '../../../../src/tiles/api'
import { CommentCard } from '../../../../src/tiles/CommentCard'
import { PendingEditorCard } from '../../../../src/tiles/PendingEditorCard'
import { PendingStrip } from '../../../../src/tiles/PendingStrip'
import { QueueDrawer } from '../../../../src/tiles/QueueDrawer'
import { TileSurface, type TilePin } from '../../../../src/tiles/TileSurface'
import { TypeBar } from '../../../../src/tiles/TypeBar'
import {
  tileLongPressMessages,
  tilePanMessage,
  tileTapMessages,
  tileKeyMessages,
  tileTypingMessages,
  toViewportPoint,
  type TileGeometry,
  type TilePoint,
} from '../../../../src/tiles/input'
import { describeTileUrl } from '../../../../src/tiles/list'
import {
  resolvableSelector,
  type TileInspectSuccess,
  type TileSelectorAnchor,
} from '../../../../src/tiles/protocol'
import { useTileRelay } from '../../../../src/tiles/useTileRelay'
import { Button, EmptyState, Pill, withAlpha } from '../../../../src/ui/primitives'

/** Pins drift as the page scrolls, so they are re-resolved after a pan settles. */
const PIN_SETTLE_MS = 350

export default function TileScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId, tileId } = useLocalSearchParams<{ hostId: string; tileId: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const daemon = useDaemonConnection(host)
  const tile = daemon.webPanes.find((candidate) => candidate.id === tileId)

  const { state, client } = useTileRelay(host, tileId)

  const [surface, setSurface] = useState({ width: 0, height: 0 })
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [reviewMode, setReviewMode] = useState(false)
  const [target, setTarget] = useState<TileInspectSuccess | null>(null)
  const [anchors, setAnchors] = useState<TileSelectorAnchor[]>([])
  const [selectedNoteId, setSelectedNoteId] = useState<number | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyNoteId, setBusyNoteId] = useState<number | null>(null)
  const [pinTick, setPinTick] = useState(0)
  const panSettle = useRef<ReturnType<typeof setTimeout> | null>(null)

  const geometry: TileGeometry = useMemo(
    () => ({
      view: surface,
      // Until the daemon has been told anything, treat the view as the page:
      // the first viewport we send is exactly the measured size.
      viewport: viewport.width > 0 ? viewport : surface,
    }),
    [surface, viewport],
  )

  /**
   * The phone sends its own viewport in CSS pixels plus its pixel ratio, so
   * the page lays out for a phone rather than being a shrunken desktop.
   */
  useEffect(() => {
    if (!client || surface.width <= 0 || surface.height <= 0) return
    const next = {
      width: Math.round(surface.width),
      height: Math.round(surface.height),
      deviceScaleFactor: Math.min(4, Math.max(1, PixelRatio.get())),
    }
    client.setViewport(next)
    setViewport({ width: next.width, height: next.height })
  }, [client, surface.width, surface.height, state.phase])

  const report = useCallback((title: string, error: unknown): void => {
    Alert.alert(title, error instanceof Error ? error.message : 'The daemon refused the request.')
  }, [])

  const run = useCallback(
    async (action: () => Promise<void>, failure: string, noteId?: number): Promise<void> => {
      setBusy(true)
      setBusyNoteId(noteId ?? null)
      try {
        await action()
      } catch (error) {
        report(failure, error)
      } finally {
        setBusy(false)
        setBusyNoteId(null)
      }
    },
    [report],
  )

  // Pins come from the live page, not from the stored rects: an element moves
  // when the page reflows for the phone's viewport, so the selectors are
  // resolved again rather than trusting what was captured.
  const resolvableNotes = useMemo(
    () => state.pending.notes.filter((note) => resolvableSelector(note.selector)),
    [state.pending.notes],
  )
  const selectorKey = resolvableNotes.map((note) => `${note.id}:${note.selector}`).join('|')

  useEffect(() => {
    if (!client || !reviewMode || resolvableNotes.length === 0) {
      setAnchors([])
      return
    }
    let cancelled = false
    void client
      .resolveSelectors(resolvableNotes.map((note) => ({ noteId: note.id, selector: note.selector })))
      .then((resolved) => {
        if (!cancelled) setAnchors(resolved)
      })
      .catch(() => {
        if (!cancelled) setAnchors([])
      })
    return () => {
      cancelled = true
    }
  }, [client, reviewMode, selectorKey, pinTick, resolvableNotes.length])

  const pins: TilePin[] = useMemo(() => {
    const byId = new Map(state.pending.notes.map((note) => [note.id, note]))
    return anchors.flatMap((anchor) => {
      const note = byId.get(anchor.noteId)
      if (!note) return []
      return [{
        noteId: anchor.noteId,
        rect: anchor.rect,
        kind: note.response ? ('response' as const) : ('annotation' as const),
        selected: selectedNoteId === anchor.noteId,
      }]
    })
  }, [anchors, state.pending.notes, selectedNoteId])

  const schedulePinRefresh = useCallback((): void => {
    if (panSettle.current) clearTimeout(panSettle.current)
    panSettle.current = setTimeout(() => {
      panSettle.current = null
      setPinTick((tick) => tick + 1)
    }, PIN_SETTLE_MS)
  }, [])

  useEffect(() => () => {
    if (panSettle.current) clearTimeout(panSettle.current)
  }, [])

  const onTap = useCallback(
    (point: TilePoint): void => {
      if (!client) return
      if (!reviewMode) {
        client.sendInput(tileTapMessages(point, geometry))
        schedulePinRefresh()
        return
      }
      const at = toViewportPoint(point, geometry)
      void Haptics.selectionAsync()
      void client
        .inspect(at.x, at.y, 'click')
        .then((result) => {
          if (result.ok) setTarget(result)
          else Alert.alert('Nothing to annotate', result.error)
        })
        .catch((error: unknown) => report('Could not inspect the page', error))
    },
    [client, geometry, reviewMode, report, schedulePinRefresh],
  )

  const onLongPress = useCallback(
    (point: TilePoint): void => {
      if (!client || reviewMode) return
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      client.sendInput(tileLongPressMessages(point, geometry))
    },
    [client, geometry, reviewMode],
  )

  // Panning scrolls in both modes: review still has to reach the element.
  const onPan = useCallback(
    (point: TilePoint, movement: TilePoint): void => {
      if (!client) return
      client.sendInput([tilePanMessage(point, movement, geometry)])
      schedulePinRefresh()
    },
    [client, geometry, schedulePinRefresh],
  )

  const queueNote = useCallback(
    (comment: string): void => {
      if (!host || !tile || !target) return
      void run(async () => {
        await addPendingNote(host, tile.id, {
          selector: target.selector,
          tag: target.tag,
          ...(target.text !== undefined ? { text: target.text } : {}),
          rect: target.rect,
          comment,
          pageUrl: tile.url,
        })
        setTarget(null)
        setPinTick((tick) => tick + 1)
      }, 'Could not queue the note')
    },
    [host, run, target, tile],
  )

  const queueRevision = state.pending.revision

  const requireRevision = useCallback((): number | null => {
    if (typeof queueRevision === 'number') return queueRevision
    Alert.alert(
      'This daemon is too old',
      'It does not report a queue revision, so a send cannot be made safe against answers arriving underneath it. Update Commando on the host.',
    )
    return null
  }, [queueRevision])

  const sendAll = useCallback(
    (intent: 'send' | 'build'): void => {
      if (!host || !tile) return
      const revision = requireRevision()
      if (revision === null) return
      void Haptics.selectionAsync()
      void run(async () => {
        if (intent === 'build') {
          await sendPendingNotesAndBuild(host, tile.id, { expectedQueueRevision: revision })
        } else {
          await sendPendingNotes(host, tile.id, { expectedQueueRevision: revision })
        }
        setDrawerOpen(false)
        setSelectedNoteId(null)
      }, intent === 'build' ? 'Could not send and build' : 'Could not send the queue')
    },
    [host, requireRevision, run, tile],
  )

  const sendOne = useCallback(
    (noteId: number, revision: number): void => {
      if (!host || !tile) return
      const queue = requireRevision()
      if (queue === null) return
      void run(async () => {
        await sendPendingNotes(host, tile.id, {
          targets: [{ id: noteId, revision }],
          expectedQueueRevision: queue,
        })
        setSelectedNoteId(null)
      }, 'Could not send this item', noteId)
    },
    [host, requireRevision, run, tile],
  )

  const saveNote = useCallback(
    (noteId: number, change: { answer: string; note: string }, expectedRevision: number): void => {
      if (!host || !tile) return
      void run(
        () => updatePendingNote(host, tile.id, noteId, expectedRevision, change).then(() => undefined),
        'Could not save this item',
        noteId,
      )
    },
    [host, run, tile],
  )

  const removeNote = useCallback(
    (noteId: number): void => {
      if (!host || !tile) return
      void run(async () => {
        await removePendingNote(host, tile.id, noteId)
        setSelectedNoteId((current) => (current === noteId ? null : current))
      }, 'Could not remove this item', noteId)
    },
    [host, run, tile],
  )

  const selectedNote: WebPanePendingNote | undefined = state.pending.notes.find(
    (note) => note.id === selectedNoteId,
  )

  const { host: urlHost, path: urlPath } = describeTileUrl(tile?.url ?? '')
  const chromium = tile?.engine === 'chromium'

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={styles.nav}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Feather color={theme.accent} name="chevron-left" size={20} />
          <Text style={[styles.backLabel, { color: theme.accent }]}>Tiles</Text>
        </Pressable>
        <View style={styles.navTitle}>
          <Text numberOfLines={1} style={[styles.navTitleText, { color: theme.text }]}>{urlHost}</Text>
          <Text numberOfLines={1} style={[styles.navSubtitle, { color: theme.muted }]}>{urlPath}</Text>
        </View>
        <Pill label={tile?.engine ?? 'tile'} tone={chromium ? 'claude' : 'mute'} />
      </View>

      {!tile ? (
        <View style={styles.body}>
          {daemon.phase === 'live' ? (
            <EmptyState
              body="It was closed on the host. Go back to the list to see what is still open."
              title="This tile is gone"
            />
          ) : (
            // The tile list arrives on the host socket, so until that is live
            // a missing tile means "not told yet", not "closed".
            <EmptyState body={daemon.detail} title="Waiting for the host" />
          )}
        </View>
      ) : !chromium ? (
        <View style={styles.body}>
          <EmptyState
            body="Webkit tiles render inside the host's own WebView against its localhost, which this phone cannot reach. Reopen it as a chromium tile from the list and it streams here."
            title="This tile does not stream"
          />
        </View>
      ) : (
        <>
          <View style={styles.chips}>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: !reviewMode }}
              onPress={() => {
                setReviewMode(false)
                setTarget(null)
              }}
              style={[
                styles.chip,
                {
                  backgroundColor: reviewMode ? theme.surface : theme.surfaceSoft,
                  borderColor: reviewMode ? theme.border : theme.borderStrong,
                },
              ]}
            >
              <Text style={[styles.chipLabel, { color: reviewMode ? theme.muted : theme.text }]}>Browse</Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: reviewMode }}
              onPress={() => {
                setReviewMode(true)
                void Haptics.selectionAsync()
              }}
              style={[
                styles.chip,
                {
                  backgroundColor: reviewMode ? withAlpha(theme.amber, 0.14) : theme.surface,
                  borderColor: reviewMode ? theme.amber : theme.border,
                },
              ]}
            >
              <Text style={[styles.chipLabel, { color: reviewMode ? theme.amber : theme.muted }]}>Review</Text>
            </Pressable>
            <View style={styles.chipSpacer} />
            <Pressable
              accessibilityLabel="Reload the page"
              accessibilityRole="button"
              onPress={() => {
                client?.reload()
                setTarget(null)
              }}
              style={[styles.iconChip, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <Feather color={theme.textSoft} name="rotate-cw" size={15} />
            </Pressable>
          </View>

          <View style={styles.body}>
            {state.phase === 'unavailable' || state.phase === 'gone' || state.phase === 'error' ? (
              <View style={[styles.stalled, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.stalledTitle, { color: theme.text }]}>
                  {state.phase === 'unavailable'
                    ? 'Chromium engine unavailable'
                    : state.phase === 'gone'
                      ? 'Tile closed'
                      : 'The stream failed'}
                </Text>
                <Text style={[styles.stalledBody, { color: theme.muted }]}>{state.detail}</Text>
                {state.phase !== 'gone' ? (
                  <Button label="Retry" onPress={() => client?.retry()} />
                ) : (
                  <Button label="Back to tiles" onPress={() => router.back()} />
                )}
              </View>
            ) : (
              <TileSurface
                geometry={geometry}
                highlight={target ? target.rect : null}
                onLayoutSize={setSurface}
                onLongPress={onLongPress}
                onPan={onPan}
                onPinPress={(noteId) => {
                  setSelectedNoteId(noteId)
                  void Haptics.selectionAsync()
                }}
                onTap={onTap}
                pins={pins}
                reviewMode={reviewMode}
                state={state}
              >
                {reviewMode && target ? (
                  <CommentCard
                    busy={busy}
                    onCancel={() => setTarget(null)}
                    onSubmit={queueNote}
                    target={target}
                  />
                ) : null}
              </TileSurface>
            )}

            {!reviewMode && state.phase !== 'gone' ? (
              <TypeBar
                disabled={!client || state.phase === 'unavailable'}
                onKey={(key) => client?.sendInput(tileKeyMessages(key))}
                onType={(text) => client?.sendInput(tileTypingMessages(text))}
              />
            ) : null}

            <PendingStrip
              busy={busy}
              onDismissDropped={() => {
                if (!host || !tile) return
                void run(
                  () => dismissDroppedAnswers(host, tile.id).then(() => undefined),
                  'Could not dismiss the warning',
                )
              }}
              onOpenQueue={() => setDrawerOpen(true)}
              onSendAll={() => sendAll('send')}
              onSendAndBuild={() => sendAll('build')}
              pending={state.pending}
            />
          </View>

          <QueueDrawer
            busy={busy}
            busyNoteId={busyNoteId}
            onClose={() => setDrawerOpen(false)}
            onRemove={removeNote}
            onSave={saveNote}
            onSend={sendOne}
            onSendAll={() => sendAll('send')}
            onSendAndBuild={() => sendAll('build')}
            pending={state.pending}
            visible={drawerOpen}
          />

          <Modal
            animationType="slide"
            onRequestClose={() => setSelectedNoteId(null)}
            presentationStyle="pageSheet"
            visible={selectedNote !== undefined}
          >
            <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
              <View style={[styles.sheetNav, { borderBottomColor: theme.border }]}>
                <Pressable accessibilityRole="button" onPress={() => setSelectedNoteId(null)}>
                  <Text style={[styles.backLabel, { color: theme.accent }]}>Done</Text>
                </Pressable>
                <Text style={[styles.navTitleText, { color: theme.text }]}>Queued item</Text>
                <View style={styles.sheetSpacer} />
              </View>
              <ScrollView contentContainerStyle={styles.sheetBody}>
                {selectedNote ? (
                  <PendingEditorCard
                    busy={busy}
                    note={selectedNote}
                    onRemove={() => removeNote(selectedNote.id)}
                    onSave={(change, expectedRevision) =>
                      saveNote(selectedNote.id, change, expectedRevision)}
                    onSend={() => sendOne(selectedNote.id, selectedNote.revision ?? 1)}
                  />
                ) : null}
              </ScrollView>
            </View>
          </Modal>
        </>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
  back: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  backLabel: { fontSize: 15, fontWeight: '600' },
  navTitle: { flex: 1, minWidth: 0 },
  navTitleText: { fontSize: 16, fontWeight: '700' },
  navSubtitle: { fontSize: 12 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  chip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  chipLabel: { fontSize: 12.5, fontWeight: '600' },
  chipSpacer: { flex: 1 },
  iconChip: {
    borderWidth: 1,
    borderRadius: 10,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  stalled: { flex: 1, borderWidth: 1, borderRadius: 14, padding: 20, gap: 10, justifyContent: 'center' },
  stalledTitle: { fontSize: 16, fontWeight: '700' },
  stalledBody: { fontSize: 13, lineHeight: 19 },
  sheet: { flex: 1 },
  sheetNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  sheetSpacer: { width: 44 },
  sheetBody: { padding: 16, gap: 12 },
})

import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import type { WebPane } from '@commando/protocol'
import { encodeCanvasPath, parseCanvasManifest, type CanvasManifest } from '@commando/canvas-manifest'
import type { RedlinePageResponse } from '@commando/redline-response'

import { daemonFetch } from '../../hosts/api'
import type { Host } from '../../hosts/types'
import { useTheme } from '../../theme'
import { EmptyState, Segmented, SectionHeader } from '../../ui/primitives'
import { addPendingResponse } from '../api'
import { useQueueActions } from '../useQueueActions'
import { NativePageView } from './NativePageView'
import { QuestionCard } from './QuestionCard'
import { QueueChrome } from './QueueChrome'
import { canvasQuestions, canvasQuestionsPage, pendingForQuestion, sentForQuestion } from './questions'
import type { NativeTileSource } from './target'
import { usePendingQueue } from './usePendingQueue'

type CanvasSource = Extract<NativeTileSource, { kind: 'canvas' }>

const MANIFEST_POLL_MS = 10_000

async function fetchManifest(host: Host, source: CanvasSource): Promise<CanvasManifest> {
  const path = `/api/redline/artifacts/${source.artifactId}/canvas?manifest=${encodeURIComponent(source.manifest)}`
  const response = await daemonFetch(host, path)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `The canvas could not be read (${response.status})`
    throw new Error(error)
  }
  // Re-validate: the phone renders whatever the manifest says.
  return parseCanvasManifest((body as { manifest?: unknown } | null)?.manifest ?? {}).manifest
}

/**
 * A canvas tab on the phone. The pan-and-zoom board is a desktop surface, so
 * the phone reads the same `canvas.json` and offers its two halves natively:
 * the question notes, answered with native controls into the canvas's own
 * answer queue (keyed under the manifest URL, exactly as the desktop does),
 * and each frame as its own page in the native WebView.
 */
export function CanvasView({ host, tile, source, active }: {
  host: Host
  tile: WebPane
  source: CanvasSource
  active: boolean
}): React.JSX.Element {
  const theme = useTheme()
  const [manifest, setManifest] = useState<CanvasManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'questions' | 'frames'>('questions')
  const [frameId, setFrameId] = useState<string | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState<number | null>(null)
  const questionsPage = canvasQuestionsPage(source.canonicalBase, source.manifest)

  const { pending, apply } = usePendingQueue(host, tile, questionsPage, active && frameId === null)
  const queue = useQueueActions({ host, webPaneId: tile.id, pending, onSnapshot: apply })

  const load = useCallback(() => {
    void fetchManifest(host, source)
      .then((next) => { setManifest(next); setError(null) })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The canvas could not be read'))
  }, [host, source.artifactId, source.manifest])

  useEffect(() => {
    if (!active) return
    load()
    // An agent records answers in canvas.json; pick them up while the screen is open.
    const timer = setInterval(load, MANIFEST_POLL_MS)
    return () => clearInterval(timer)
  }, [active, load])

  const questions = useMemo(() => canvasQuestions(manifest?.annotations ?? []), [manifest])
  const openCount = questions.filter(({ note, question }) => (
    note.answer === undefined && !sentForQuestion(question, pending.sent, questionsPage)
  )).length
  const frame = manifest?.frames.find((candidate) => candidate.id === frameId)

  const queueAnswer = (response: RedlinePageResponse): void => {
    void queue.run(async () => {
      apply(await addPendingResponse(host, tile.id, questionsPage, response))
    }, 'Could not queue the answer')
  }

  if (frame) {
    const path = encodeCanvasPath(frame.src)
    return (
      <View style={styles.root}>
        <Pressable accessibilityRole="button" onPress={() => setFrameId(null)} style={styles.backRow}>
          <Feather color={theme.accent} name="chevron-left" size={18} />
          <Text style={[styles.backLabel, { color: theme.accent }]}>Canvas</Text>
          <Text numberOfLines={1} style={[styles.frameTitle, { color: theme.text }]}>{frame.title}</Text>
        </Pressable>
        <NativePageView
          active={active}
          host={host}
          onLoadFailed={(detail) => setError(detail)}
          source={{
            kind: 'page',
            url: `${source.phoneBase}${path}`,
            canonicalOrigin: source.canonicalOrigin,
            phoneOrigin: source.phoneOrigin,
            daemonServed: true,
          }}
          tile={tile}
        />
      </View>
    )
  }

  const pageTitle = (pageId: string | undefined): string | undefined =>
    manifest?.pages.find((page) => page.id === pageId)?.title
  const frameTitle = (id: string | undefined): string | undefined =>
    manifest?.frames.find((candidate) => candidate.id === id)?.title

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
      <View style={styles.toolbar}>
        <Segmented
          onChange={setView}
          options={[
            { value: 'questions', label: openCount ? `Questions · ${openCount}` : 'Questions' },
            { value: 'frames', label: `Frames · ${manifest?.frames.length ?? 0}` },
          ]}
          value={view}
        />
      </View>
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        {error ? <Text accessibilityRole="alert" style={[styles.error, { color: theme.red }]}>{error}</Text> : null}
        {!manifest ? (
          <EmptyState title="Reading the canvas…" />
        ) : view === 'questions' ? (
          questions.length === 0 ? (
            <EmptyState title="No questions on this canvas" body="The agent has not asked anything here yet." />
          ) : questions.map(({ note, question }) => {
            const where = [pageTitle(note.page), frameTitle(note.target?.frame), note.title].filter(Boolean).join(' · ')
            return (
              <QuestionCard
                busy={queue.busy}
                context={where || 'Question'}
                key={`${question.queueKey}:${question.question}:${(question.options ?? []).join('|')}`}
                onQueue={queueAnswer}
                onRemove={(noteId) => void queue.removeNote(noteId)}
                {...(note.target?.frame ? { onReveal: () => setFrameId(note.target!.frame) } : {})}
                pending={pendingForQuestion(question, pending.notes, questionsPage)}
                question={question}
                recorded={note.answer}
                sent={sentForQuestion(question, pending.sent, questionsPage)}
              />
            )
          })
        ) : (
          (manifest.pages.length ? manifest.pages : [{ id: undefined, title: manifest.title }]).map((page) => {
            const frames = manifest.frames.filter((candidate) => candidate.page === page.id)
            if (frames.length === 0) return null
            return (
              <View key={page.id ?? 'page'} style={styles.group}>
                <SectionHeader label={page.title} note={frames.length === 1 ? '1 frame' : `${frames.length} frames`} />
                {frames.map((candidate) => (
                  <Pressable
                    accessibilityRole="button"
                    key={candidate.id}
                    onPress={() => setFrameId(candidate.id)}
                    style={[styles.frameRow, { backgroundColor: theme.surface, borderColor: theme.border }]}
                  >
                    <Feather color={theme.accent} name={candidate.interactive ? 'play-circle' : 'image'} size={18} />
                    <View style={styles.frameText}>
                      <Text numberOfLines={1} style={[styles.frameName, { color: theme.text }]}>{candidate.title}</Text>
                      <Text numberOfLines={1} style={[styles.frameMeta, { color: theme.muted }]}>
                        {[candidate.platform, `${candidate.w}×${candidate.h}`, candidate.variant?.title].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    <Feather color={theme.textDim} name="chevron-right" size={18} />
                  </Pressable>
                ))}
              </View>
            )
          })
        )}
      </ScrollView>
      <View style={styles.queue}>
        <QueueChrome onSelectNote={setSelectedNoteId} pending={pending} queue={queue} selectedNoteId={selectedNoteId} />
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  toolbar: { paddingHorizontal: 12, paddingBottom: 8 },
  list: { padding: 12, gap: 12 },
  error: { fontSize: 13 },
  group: { gap: 8 },
  frameRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 12, padding: 12 },
  frameText: { flex: 1, minWidth: 0, gap: 2 },
  frameName: { fontSize: 14.5, fontWeight: '600' },
  frameMeta: { fontSize: 12 },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingBottom: 8, minHeight: 36 },
  backLabel: { fontSize: 14, fontWeight: '600' },
  frameTitle: { flex: 1, fontSize: 14, fontWeight: '600', marginLeft: 8 },
  queue: { paddingHorizontal: 12, paddingBottom: 12 },
})

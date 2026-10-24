import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import type { WebPane } from '@commando/protocol'
import {
  EMPTY_REDLINE_PAGE_QUESTION_SNAPSHOT,
  redlinePageKey,
  redlinePendingSnapshotForPage,
  type RedlinePageQuestionSnapshot,
  type RedlinePageResponse,
} from '@commando/redline-response'

import type { Host } from '../../hosts/types'
import { useTheme } from '../../theme'
import { Button, EmptyState, withAlpha } from '../../ui/primitives'
import { addPendingNote, addPendingResponse } from '../api'
import { CommentCard } from '../CommentCard'
import type { TileInspectSuccess } from '../protocol'
import { useQueueActions } from '../useQueueActions'
import { pinsForPage, type NativeTileEvent } from './bridge'
import { NativeWebTile, type NativeWebTileHandle } from './NativeWebTile'
import { QuestionCard } from './QuestionCard'
import { QueueChrome } from './QueueChrome'
import { pendingForQuestion, sentForQuestion } from './questions'
import { toCanonicalUrl, type NativeTileSource } from './target'
import { usePendingQueue } from './usePendingQueue'

type PageSource = Extract<NativeTileSource, { kind: 'page' }>

/**
 * A tile rendered by the phone's own WebView, with the redline review flow:
 * page questions answered natively or in the page, element comments in
 * Review, and the pending queue's Send all / Send + Build.
 */
export function NativePageView({
  host,
  tile,
  source,
  active,
  onLoadFailed,
  onPageUrl,
}: {
  host: Host
  tile: WebPane
  source: PageSource
  active: boolean
  onLoadFailed: (detail: string) => void
  onPageUrl?: (canonicalUrl: string) => void
}): React.JSX.Element {
  const theme = useTheme()
  const webView = useRef<NativeWebTileHandle>(null)
  const [phoneUrl, setPhoneUrl] = useState(source.url)
  const canonicalPage = toCanonicalUrl(source, phoneUrl)
  const [questions, setQuestions] = useState<{ page: string; snapshot: RedlinePageQuestionSnapshot }>({
    page: redlinePageKey(canonicalPage),
    snapshot: EMPTY_REDLINE_PAGE_QUESTION_SNAPSHOT,
  })
  const [reviewMode, setReviewMode] = useState(false)
  const [target, setTarget] = useState<TileInspectSuccess | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState<number | null>(null)
  const [questionsOpen, setQuestionsOpen] = useState(false)

  const { pending, apply } = usePendingQueue(host, tile, canonicalPage, active)
  const queue = useQueueActions({ host, webPaneId: tile.id, pending, onSnapshot: apply })

  useEffect(() => { onPageUrl?.(canonicalPage) }, [canonicalPage, onPageUrl])

  // Questions belong to one document; another page starts with none.
  const pageKey = redlinePageKey(canonicalPage)
  const openQuestions = questions.page === pageKey ? questions.snapshot.questions : []

  const pageSnapshot = useMemo(() => redlinePendingSnapshotForPage(pending, canonicalPage), [pending, canonicalPage])
  const pins = useMemo(
    () => pinsForPage(pending.notes, canonicalPage, selectedNoteId),
    [pending.notes, canonicalPage, selectedNoteId],
  )

  // Everything the page should know is re-sent on change and on every new document.
  const sync = useCallback(() => {
    const view = webView.current
    if (!view) return
    view.send({ type: 'applyPending', snapshot: pageSnapshot })
    view.send({ type: 'setReview', enabled: reviewMode })
    view.send({ type: 'setPins', pins })
    view.send({ type: 'setFocus', selector: target?.selector ?? null })
  }, [pageSnapshot, pins, reviewMode, target?.selector])
  const syncRef = useRef(sync)
  syncRef.current = sync
  useEffect(() => { sync() }, [sync])

  const queueResponse = useCallback((pageUrl: string, response: RedlinePageResponse) => {
    void queue.run(async () => {
      apply(await addPendingResponse(host, tile.id, pageUrl, response))
    }, 'Could not queue the answer')
  }, [apply, host, queue.run, tile.id])

  const onEvent = useCallback((event: NativeTileEvent) => {
    switch (event.type) {
      case 'ready':
        syncRef.current()
        return
      case 'questions':
        setQuestions({ page: redlinePageKey(toCanonicalUrl(source, event.url)), snapshot: event.snapshot })
        return
      case 'response':
        queueResponse(toCanonicalUrl(source, event.url), event.response)
        return
      case 'inspect':
        void Haptics.selectionAsync()
        setTarget(event.result)
        return
      case 'pin':
        setSelectedNoteId(event.noteId)
        return
    }
  }, [queueResponse, source])

  const queueNote = useCallback((comment: string) => {
    if (!target) return
    void queue.run(async () => {
      apply(await addPendingNote(host, tile.id, {
        selector: target.selector,
        tag: target.tag,
        ...(target.text !== undefined ? { text: target.text } : {}),
        rect: target.rect,
        comment,
        pageUrl: canonicalPage,
      }))
      setTarget(null)
    }, 'Could not queue the note')
  }, [apply, canonicalPage, host, queue.run, target, tile.id])

  return (
    <View style={styles.root}>
      <View style={styles.chips}>
        <Chip label="Browse" selected={!reviewMode} onPress={() => { setReviewMode(false); setTarget(null) }} />
        <Chip
          label="Review"
          selected={reviewMode}
          tone="amber"
          onPress={() => { setReviewMode(true); void Haptics.selectionAsync() }}
        />
        <Chip
          label={openQuestions.length ? `Questions · ${openQuestions.length}` : 'Questions'}
          selected={false}
          tone="cyan"
          disabled={openQuestions.length === 0}
          onPress={() => setQuestionsOpen(true)}
        />
        <View style={styles.spacer} />
        <Pressable
          accessibilityLabel="Reload the page"
          accessibilityRole="button"
          onPress={() => { webView.current?.reload(); setTarget(null) }}
          style={[styles.iconChip, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
          <Feather color={theme.textSoft} name="rotate-cw" size={15} />
        </Pressable>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.body}>
        <View style={styles.page}>
          <NativeWebTile
            expectedOrigin={source.phoneOrigin}
            onEvent={onEvent}
            onLoadFailed={onLoadFailed}
            onNavigate={setPhoneUrl}
            ref={webView}
            url={source.url}
          />
          {reviewMode && !target ? (
            <View pointerEvents="none" style={[styles.hint, { backgroundColor: withAlpha(theme.amber, 0.16), borderColor: theme.amber }]}>
              <Text style={[styles.hintText, { color: theme.amber }]}>Tap an element to comment on it</Text>
            </View>
          ) : null}
          {reviewMode && target ? (
            <CommentCard busy={queue.busy} onCancel={() => setTarget(null)} onSubmit={queueNote} target={target} />
          ) : null}
        </View>
        <QueueChrome onSelectNote={setSelectedNoteId} pending={pending} queue={queue} selectedNoteId={selectedNoteId} />
      </KeyboardAvoidingView>

      <Modal animationType="slide" onRequestClose={() => setQuestionsOpen(false)} presentationStyle="pageSheet" visible={questionsOpen}>
        <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
          <View style={[styles.sheetNav, { borderBottomColor: theme.border }]}>
            <Pressable accessibilityRole="button" onPress={() => setQuestionsOpen(false)}>
              <Text style={[styles.done, { color: theme.accent }]}>Done</Text>
            </Pressable>
            <Text style={[styles.sheetTitle, { color: theme.text }]}>Questions on this page</Text>
            <View style={styles.sheetSpacer} />
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
            {openQuestions.length === 0 ? (
              <EmptyState title="No open questions" body="The page has no redline questions waiting for an answer." />
            ) : openQuestions.map((question) => (
              <QuestionCard
                busy={queue.busy}
                key={`${question.queueKey ?? question.selector}:${question.question}`}
                onQueue={(response) => queueResponse(canonicalPage, response)}
                onRemove={(noteId) => void queue.removeNote(noteId)}
                onReveal={() => {
                  setQuestionsOpen(false)
                  webView.current?.send({ type: 'reveal', selector: question.selector })
                }}
                context="Show on page"
                pending={pendingForQuestion(question, pending.notes, canonicalPage)}
                question={question}
                sent={sentForQuestion(question, pending.sent, canonicalPage)}
              />
            ))}
            <Button label="Done" onPress={() => setQuestionsOpen(false)} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  )
}

function Chip({ label, selected, onPress, tone, disabled }: {
  label: string
  selected: boolean
  onPress: () => void
  tone?: 'amber' | 'cyan'
  disabled?: boolean
}): React.JSX.Element {
  const theme = useTheme()
  const color = tone === 'amber' ? theme.amber : tone === 'cyan' ? theme.cyan : theme.text
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.chip,
        {
          opacity: disabled ? 0.5 : 1,
          backgroundColor: selected ? (tone ? withAlpha(color, 0.14) : theme.surfaceSoft) : theme.surface,
          borderColor: selected ? (tone ? color : theme.borderStrong) : tone === 'cyan' && !disabled ? withAlpha(color, 0.5) : theme.border,
        },
      ]}
    >
      <Text style={[styles.chipLabel, { color: selected || (tone === 'cyan' && !disabled) ? color : theme.muted }]}>{label}</Text>
    </Pressable>
  )
}

/** Shown in place of the page when the WebView cannot load it and there is no stream to fall back to. */
export function NativeLoadFailed({ detail, onRetry, onStream }: {
  detail: string
  onRetry: () => void
  onStream?: () => void
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={[styles.failed, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Text style={[styles.failedTitle, { color: theme.text }]}>The phone could not load this page</Text>
      <Text style={[styles.failedBody, { color: theme.muted }]}>{detail}</Text>
      <Button label="Try again" onPress={onRetry} />
      {onStream ? <Button label="Stream it from the Mac" onPress={onStream} variant="primary" /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  chip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  chipLabel: { fontSize: 12.5, fontWeight: '600' },
  spacer: { flex: 1 },
  iconChip: { borderWidth: 1, borderRadius: 10, width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  page: { flex: 1 },
  hint: { position: 'absolute', top: 10, alignSelf: 'center', borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  hintText: { fontSize: 12, fontWeight: '700' },
  sheet: { flex: 1 },
  sheetNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  done: { fontSize: 15, fontWeight: '600' },
  sheetTitle: { fontSize: 16, fontWeight: '700' },
  sheetSpacer: { width: 44 },
  sheetBody: { padding: 16, gap: 12 },
  failed: { flex: 1, borderWidth: 1, borderRadius: 14, padding: 20, gap: 10, justifyContent: 'center' },
  failedTitle: { fontSize: 16, fontWeight: '700' },
  failedBody: { fontSize: 13, lineHeight: 19 },
})

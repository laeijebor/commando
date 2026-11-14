import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import type { CanvasThread } from '@commando/protocol'
import type { CanvasManifest } from '@commando/canvas-manifest'

import { useDaemonClient } from '../../daemon/useDaemonConnection'
import type { Host } from '../../hosts/types'
import { useTheme } from '../../theme'
import { Button, EmptyState, SectionHeader } from '../../ui/primitives'
import { fetchCanvasThreads, replyCanvasThread, setCanvasThreadStatus } from '../api'

/** A fallback for a missed `canvas_threads_changed`; the event is what normally refreshes. */
const THREADS_POLL_MS = 15_000

const lastAt = (thread: CanvasThread): number => thread.messages.at(-1)?.at ?? thread.createdAt

/** Open threads first, each group newest activity first. */
export function sortThreads(threads: readonly CanvasThread[]): CanvasThread[] {
  return [...threads].sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || lastAt(b) - lastAt(a))
}

/**
 * A canvas tab's threads: sent pins and the agent's replies. Re-read when the
 * daemon says this tab's threads changed, and on a slow poll as a fallback.
 */
export function useCanvasThreads(host: Host, webPaneId: string, active: boolean) {
  const client = useDaemonClient(host)
  const [threads, setThreads] = useState<CanvasThread[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  const reload = useCallback(() => {
    const request = ++latest.current
    void fetchCanvasThreads(host, webPaneId)
      .then((next) => {
        if (request !== latest.current) return
        setThreads(next)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (request === latest.current) setError(reason instanceof Error ? reason.message : 'The threads could not be read')
      })
  }, [host, webPaneId])

  useEffect(() => {
    if (!active) return
    reload()
    const timer = setInterval(reload, THREADS_POLL_MS)
    const unsubscribe = client?.subscribe((message) => {
      if (message.type === 'canvas_threads_changed' && message.webPaneId === webPaneId) reload()
    })
    return () => {
      clearInterval(timer)
      unsubscribe?.()
    }
  }, [active, client, reload, webPaneId])

  /** Keeps the daemon's copy of one thread until the next read. */
  const replace = useCallback((thread: CanvasThread) => {
    latest.current += 1
    setThreads((current) => current?.map((candidate) => (candidate.id === thread.id ? thread : candidate)) ?? [thread])
    reload()
  }, [reload])

  const reply = useCallback(async (threadId: string, text: string) => {
    replace(await replyCanvasThread(host, webPaneId, threadId, text))
  }, [host, replace, webPaneId])

  const setStatus = useCallback(async (threadId: string, status: CanvasThread['status']) => {
    replace(await setCanvasThreadStatus(host, webPaneId, threadId, status))
  }, [host, replace, webPaneId])

  return { threads, error, reply, setStatus }
}

/** The Threads segment of a canvas tab: open discussions, then resolved ones folded away. */
export function CanvasThreadList({ threads, manifest, onReply, onStatus, onReveal }: {
  threads: readonly CanvasThread[] | null
  manifest: CanvasManifest | null
  onReply: (threadId: string, text: string) => Promise<void>
  onStatus: (threadId: string, status: CanvasThread['status']) => Promise<void>
  onReveal: (frameId: string) => void
}): React.JSX.Element {
  const theme = useTheme()
  const [showResolved, setShowResolved] = useState(false)
  if (!threads) return <EmptyState title="Reading the threads…" />
  if (threads.length === 0) {
    return <EmptyState title="No threads yet" body="Comments you send from a frame in Review start a thread the agent can reply to." />
  }
  const sorted = sortThreads(threads)
  const open = sorted.filter((thread) => thread.status === 'open').length
  const resolved = sorted.length - open
  // One keyed list, so a thread that changes status keeps its card (and a half-typed reply).
  return (
    <View style={styles.list}>
      {open === 0 ? <EmptyState key="none-open" title="Nothing open" body="Every thread on this canvas is resolved." /> : null}
      {sorted.flatMap((thread, index) => {
        const frame = manifest?.frames.find((candidate) => candidate.id === thread.frameId)
        const hidden = thread.status === 'resolved' && !showResolved
        const card = (
          <View key={thread.id} style={hidden ? styles.hidden : undefined}>
            <ThreadCard
              frameTitle={frame?.title ?? thread.canvas?.frameTitle ?? thread.frameId}
              onReply={(text) => onReply(thread.id, text)}
              {...(frame ? { onReveal: () => onReveal(frame.id) } : {})}
              onStatus={(status) => onStatus(thread.id, status)}
              thread={thread}
            />
          </View>
        )
        if (index !== open) return [card]
        return [
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showResolved }}
            key="resolved-toggle"
            onPress={() => setShowResolved((value) => !value)}
            style={styles.resolvedToggle}
          >
            <SectionHeader label={`Resolved · ${resolved}`} />
            <Feather color={theme.muted} name={showResolved ? 'chevron-down' : 'chevron-right'} size={14} />
          </Pressable>,
          card,
        ]
      })}
    </View>
  )
}

const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function ThreadCard({ thread, frameTitle, onReply, onStatus, onReveal }: {
  thread: CanvasThread
  frameTitle: string
  onReply: (text: string) => Promise<void>
  onStatus: (status: CanvasThread['status']) => Promise<void>
  onReveal?: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resolved = thread.status === 'resolved'
  const where = [frameTitle, thread.label ?? thread.canvas?.label].filter(Boolean).join(' › ')

  const run = async (work: () => Promise<void>, failure: string): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : failure)
      return false
    } finally {
      setBusy(false)
    }
  }
  const send = async () => {
    const text = draft.trim()
    if (!text) return
    if (await run(() => onReply(text), 'Could not send the reply')) setDraft('')
  }

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }, resolved && styles.resolvedCard]} testID="canvas-thread">
      <View style={styles.header}>
        <Feather color={resolved ? theme.green : theme.accent} name={resolved ? 'check-circle' : 'message-circle'} size={15} />
        <Text numberOfLines={1} style={[styles.where, { color: theme.text }]}>{where}</Text>
        {onReveal ? (
          <Pressable accessibilityLabel={`Show ${frameTitle}`} accessibilityRole="button" hitSlop={8} onPress={onReveal}>
            <Text style={[styles.link, { color: theme.accent }]}>Show</Text>
          </Pressable>
        ) : null}
      </View>
      {thread.messages.map((message, index) => (
        <View
          key={`${message.at}:${index}`}
          style={[
            styles.message,
            message.author === 'agent'
              ? { backgroundColor: theme.surfaceSoft, borderColor: theme.border }
              : [styles.userMessage, { borderColor: theme.border }],
          ]}
        >
          <Text style={[styles.author, { color: message.author === 'agent' ? theme.accent : theme.muted }]}>
            {message.author === 'agent' ? 'Agent' : 'You'} · {time(message.at)}
          </Text>
          <Text selectable style={[styles.text, { color: theme.text }]}>{message.text}</Text>
        </View>
      ))}
      <TextInput
        accessibilityLabel={`Reply to ${where}`}
        editable={!busy}
        multiline
        onChangeText={setDraft}
        placeholder={resolved ? 'Reply to reopen…' : 'Reply…'}
        placeholderTextColor={theme.textDim}
        style={[styles.input, { backgroundColor: theme.surfaceRaised, borderColor: theme.border, color: theme.text }]}
        value={draft}
      />
      {error ? <Text accessibilityRole="alert" style={[styles.error, { color: theme.red }]}>{error}</Text> : null}
      <View style={styles.actions}>
        <Button
          disabled={busy}
          label={resolved ? 'Reopen' : 'Resolve'}
          onPress={() => void run(() => onStatus(resolved ? 'open' : 'resolved'), 'Could not change the thread')}
          style={styles.action}
        />
        <Button
          busy={busy}
          disabled={!draft.trim()}
          label="Reply"
          onPress={() => void send()}
          style={styles.action}
          variant="primary"
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  list: { gap: 12 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  resolvedCard: { opacity: 0.85 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  where: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '600' },
  link: { fontSize: 13, fontWeight: '600' },
  message: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, gap: 3 },
  userMessage: { marginLeft: 24 },
  author: { fontSize: 11.5, fontWeight: '600' },
  text: { fontSize: 14, lineHeight: 20 },
  input: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14, minHeight: 44 },
  error: { fontSize: 13 },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1, paddingVertical: 9 },
  hidden: { display: 'none' },
  resolvedToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4 },
})

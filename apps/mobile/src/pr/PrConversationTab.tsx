import { memo, useMemo, useState } from 'react'
import { FlatList, Linking, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'

import { Markdown } from '../chat/Markdown'
import { useTheme, type Theme } from '../theme'
import { relativeTime } from '../time'
import { Meta, Pill, withAlpha } from '../ui/primitives'
import type { PrConversationEntry, PrDetails } from './api'
import { githubMarkdown } from './markdown'
import { PatchView } from './PatchView'
import { StaleNote } from './StaleNote'
import { prTimelineHeadline, prTimelineSummary, type PrReviewState, type PrTimelineItem } from './timeline'

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

/**
 * The PR's timeline: top-level comments, reviews with their verdicts, and
 * inline review threads with their file, line, code, replies and state.
 * Resolved threads fold away the way GitHub folds them.
 */
export function PrConversationTab({ items, details, error, loading, onRefresh, url }: {
  items: readonly PrTimelineItem[]
  details?: PrDetails | undefined
  error?: string | undefined
  loading: boolean
  onRefresh: () => void
  url: string
}): React.JSX.Element {
  const theme = useTheme()
  const [unresolvedOnly, setUnresolvedOnly] = useState(false)
  const summary = useMemo(() => prTimelineSummary(items, details), [items, details])
  const shown = useMemo(() => unresolvedOnly ? items.filter((item) => item.type === 'thread' && !item.resolved) : items, [items, unresolvedOnly])
  const header = (
    <View style={styles.header}>
      {details ? <Text style={[styles.headline, { color: theme.textSoft }]}>{prTimelineHeadline(summary)}</Text> : null}
      {summary.threads ? (
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: unresolvedOnly }} onPress={() => setUnresolvedOnly((value) => !value)}
          style={[styles.filter, { borderColor: unresolvedOnly ? theme.accent : theme.borderMid, backgroundColor: unresolvedOnly ? withAlpha(theme.accent, 0.12) : theme.surfaceSoft }]}>
          <Feather name={unresolvedOnly ? 'check-square' : 'square'} size={13} color={unresolvedOnly ? theme.accent : theme.muted} />
          <Text style={[styles.filterLabel, { color: unresolvedOnly ? theme.accent : theme.textSoft }]}>Unresolved threads only</Text>
        </Pressable>
      ) : null}
      {details?.stale ? <StaleNote details={details} /> : null}
      {error ? <Text accessibilityRole="alert" style={[styles.note, { color: theme.red }]}>{error}</Text> : null}
      {!details && !error ? <Meta>Loading the conversation…</Meta> : null}
    </View>
  )
  return (
    <FlatList
      data={shown}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={header}
      ListEmptyComponent={details ? <Meta>{unresolvedOnly ? 'Every thread is resolved.' : 'No conversation yet.'}</Meta> : null}
      renderItem={({ item }) => <TimelineItem item={item} url={url} />}
      contentContainerStyle={styles.list}
      initialNumToRender={8}
      windowSize={9}
      refreshControl={<RefreshControl refreshing={loading && Boolean(details)} onRefresh={onRefresh} tintColor={theme.muted} />}
    />
  )
}

const TimelineItem = memo(function TimelineItem({ item, url }: { item: PrTimelineItem; url: string }) {
  if (item.type === 'thread') return <Thread item={item} url={url} />
  if (item.type === 'review') return <Review entry={item.entry} state={item.state} url={url} />
  return <Comment entry={item.entry} url={url} />
})

function Byline({ entry, action, url, color }: { entry: PrConversationEntry; action: string; url: string; color?: string }): React.JSX.Element {
  const theme = useTheme()
  const at = Date.parse(entry.createdAt)
  return (
    <View style={styles.byline}>
      <Text numberOfLines={1} style={[styles.bylineText, { color: theme.muted }]}>
        <Text style={[styles.author, { color: theme.text }]}>{entry.author}</Text> <Text style={color ? { color } : null}>{action}</Text>
      </Text>
      <Text accessibilityRole="link" onPress={() => void Linking.openURL(entry.url || url).catch(() => undefined)} style={[styles.time, { color: theme.textDim }]}>
        {Number.isFinite(at) ? relativeTime(at) || 'now' : 'GitHub'}
      </Text>
    </View>
  )
}

function Body({ entry, empty }: { entry: PrConversationEntry; empty?: string }): React.JSX.Element | null {
  const text = githubMarkdown(entry.body)
  if (!text) return empty ? <Meta>{empty}</Meta> : null
  return <Markdown text={text} baseUrl="" />
}

function Comment({ entry, url }: { entry: PrConversationEntry; url: string }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      <Byline entry={entry} action="commented" url={url} />
      <Body entry={entry} empty="No comment body." />
    </View>
  )
}

const REVIEW_PRESENTATION: Record<PrReviewState, { action: string; icon: React.ComponentProps<typeof Feather>['name']; tone: (theme: Theme) => string }> = {
  approved: { action: 'approved these changes', icon: 'check-circle', tone: (theme) => theme.green },
  'changes requested': { action: 'requested changes', icon: 'x-circle', tone: (theme) => theme.red },
  commented: { action: 'reviewed', icon: 'eye', tone: (theme) => theme.muted },
  dismissed: { action: 'review dismissed', icon: 'slash', tone: (theme) => theme.textDim },
  pending: { action: 'has a pending review', icon: 'clock', tone: (theme) => theme.amber },
}

function Review({ entry, state, url }: { entry: PrConversationEntry; state: PrReviewState; url: string }): React.JSX.Element {
  const theme = useTheme()
  const presentation = REVIEW_PRESENTATION[state] ?? REVIEW_PRESENTATION.commented
  const color = presentation.tone(theme)
  return (
    <View accessibilityLabel={`Review by ${entry.author}: ${state}`} style={[styles.card, { borderColor: entry.body.trim() ? theme.border : 'transparent', backgroundColor: entry.body.trim() ? theme.surface : 'transparent' }]}>
      <View style={styles.reviewHead}>
        <Feather name={presentation.icon} size={16} color={color} />
        <View style={styles.flex}><Byline entry={entry} action={presentation.action} url={url} color={color} /></View>
      </View>
      <Body entry={entry} />
    </View>
  )
}

function Thread({ item, url }: { item: Extract<PrTimelineItem, { type: 'thread' }>; url: string }): React.JSX.Element {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(!item.resolved)
  const location = `${item.path ?? 'review thread'}${item.line ? `:${item.line}` : ''}`
  const count = 1 + item.replies.length
  return (
    <View accessibilityLabel={`Review thread on ${location}${item.resolved ? ', resolved' : ''}${item.outdated ? ', outdated' : ''}`}
      style={[styles.card, styles.thread, { borderColor: item.resolved ? theme.border : withAlpha(theme.amber, 0.35), backgroundColor: theme.surface }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={styles.threadHead}>
        <Feather name="file-text" size={13} color={theme.muted} />
        <Text numberOfLines={1} ellipsizeMode="head" style={[styles.location, { color: theme.textSoft }]}>{location}</Text>
        {item.outdated ? <Pill label="Outdated" tone="warn" /> : null}
        <Pill label={item.resolved ? 'Resolved' : 'Open'} tone={item.resolved ? 'ok' : 'mute'} />
      </Pressable>
      {expanded ? (
        <>
          {item.diffHunk ? <PatchView patch={item.diffHunk} numbers={false} chunk={40} /> : null}
          <View style={styles.threadComment}>
            <Byline entry={item.entry} action={item.detached ? 'replied (original comment unavailable)' : 'commented'} url={url} />
            <Body entry={item.entry} />
          </View>
          {item.replies.map((reply) => (
            <View key={reply.id} accessibilityLabel={`Reply by ${reply.author}`} style={[styles.reply, { borderLeftColor: theme.borderStrong }]}>
              <Byline entry={reply} action="replied" url={url} />
              <Body entry={reply} />
            </View>
          ))}
        </>
      ) : (
        <Text style={[styles.note, { color: theme.muted }]}>{item.entry.author} · {count} {count === 1 ? 'comment' : 'comments'} · tap to show</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 10, maxWidth: 776, width: '100%', alignSelf: 'center' },
  header: { gap: 8, paddingBottom: 4 },
  headline: { fontSize: 13.5 },
  note: { fontSize: 12.5, lineHeight: 17 },
  filter: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  filterLabel: { fontSize: 12.5, fontWeight: '600' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 8 },
  thread: { borderWidth: 1 },
  byline: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  bylineText: { flex: 1, fontSize: 13 },
  author: { fontWeight: '700' },
  time: { fontSize: 12 },
  reviewHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1, minWidth: 0 },
  threadHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  location: { flex: 1, fontFamily: MONO, fontSize: 12 },
  threadComment: { gap: 6 },
  reply: { borderLeftWidth: 2, paddingLeft: 10, gap: 6, marginLeft: 4 },
})

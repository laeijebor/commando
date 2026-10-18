import { createContext, memo, use, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import * as Clipboard from 'expo-clipboard'

import { PLAN_IMPLEMENTATION_PREFIX, chatImageUrl, chatPlanTitle, type ChatImageRef, type ChatItem } from '@commando/agent-chat'
import {
  canCollapsePlan,
  collapsedPlanPreview,
  deriveTimelineRows,
  mergeActivityRows,
  activitySummary,
  type QuietTimelineRow,
  type ActivityRow,
  patchLines,
  planBody,
  shortPath,
  thoughtLabel,
  type PlanItem,
  type ReasoningItem,
  type SubagentItem,
  type WorkItem,
} from '@commando/chat-timeline'

import { providerPresentation } from '../ui/providerPresentation'
import { WorkingPulse } from '../ui/ChatIndicator'
import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'
import { Markdown } from './Markdown'

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

/** What rows need beyond their own item: where images load from and the session folder. */
const TimelineContext = createContext<{ baseUrl: string; cwd: string; provider: string }>({ baseUrl: '', cwd: '', provider: 'Agent' })

type Entry = QuietTimelineRow | { kind: 'working'; id: 'working' }

/**
 * The chat's turns, drawn from the same rows as the web's ChatTimeline:
 * messages, collapsed work groups, thoughts, notices and plan cards. The list
 * is inverted, so it opens on the newest turn and stays pinned to it while
 * Claude streams, unless the reader has scrolled up.
 */
export function ChatTimeline({ items, cwd, baseUrl, working, provider }: {
  provider?: string
  items: readonly ChatItem[]
  cwd: string
  baseUrl: string
  working: boolean
}): React.JSX.Element {
  const theme = useTheme()
  const rows = useMemo(() => mergeActivityRows(deriveTimelineRows(items)), [items])
  const last = rows.at(-1)
  const streaming = last?.kind === 'assistant' && last.item.status === 'running'
  const liveWork = (last?.kind === 'activity' || last?.kind === 'subagents') && last.live
  const data = useMemo<Entry[]>(() => {
    const entries: Entry[] = rows.slice().reverse()
    return working && !streaming && !liveWork ? [{ kind: 'working', id: 'working' }, ...entries] : entries
  }, [rows, working, streaming, liveWork])
  const context = useMemo(() => ({ baseUrl, cwd, provider: providerPresentation(provider).name }), [baseUrl, cwd, provider])
  const list = useRef<FlatList<Entry>>(null)
  // Inverted: offset 0 is the newest turn.
  const [scrolledBack, setScrolledBack] = useState(false)

  return (
    <TimelineContext value={context}>
      <View style={styles.list}>
        <FlatList
          contentContainerStyle={styles.content}
          data={data}
          inverted
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(entry) => entry.id}
          ListEmptyComponent={(
            // An inverted list draws its empty view upside down too.
            <View style={styles.empty}>
              <Text style={[styles.emptyText, { color: theme.muted }]}>Ask {context.provider} anything about this folder.</Text>
            </View>
          )}
          onScroll={(event) => setScrolledBack(event.nativeEvent.contentOffset.y > 240)}
          ref={list}
          renderItem={({ item }) => <Row entry={item} />}
          scrollEventThrottle={100}
          style={styles.list}
          testID="chat-timeline"
        />
        {scrolledBack ? (
          <Pressable
            accessibilityLabel="Jump to the newest turn"
            accessibilityRole="button"
            onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
            style={[styles.jump, { backgroundColor: withAlpha(theme.accent, 0.9) }]}
          >
            <Text style={[styles.jumpLabel, { color: theme.accentInk }]}>Jump to latest</Text>
          </Pressable>
        ) : null}
      </View>
    </TimelineContext>
  )
}

const Row = memo(function Row({ entry }: { entry: Entry }) {
  const theme = useTheme()
  switch (entry.kind) {
    case 'working':
      return (
        <View style={styles.working}>
          <WorkingPulse />
          <Text style={[styles.mutedLine, { color: theme.muted }]}>Working…</Text>
        </View>
      )
    case 'user':
      return <UserRow item={entry.item} />
    case 'assistant':
      return <View style={styles.assistant}><Markdown text={entry.item.text} /></View>
    case 'activity':
      return <WorkGroup row={entry} />
    case 'notice':
      return (
        <View style={styles.notice}>
          <Feather color={entry.item.level === 'error' ? theme.red : theme.muted} name={entry.item.level === 'error' ? 'alert-circle' : 'info'} size={13} style={styles.noticeIcon} />
          <Text selectable style={[styles.noticeText, { color: entry.item.level === 'error' ? theme.red : theme.muted }]}>{entry.item.text}</Text>
        </View>
      )
    case 'plan':
      return <PlanCard item={entry.item} />
    case 'subagents':
      return <SubagentRows items={entry.items} />
  }
})

function UserRow({ item }: { item: Extract<ChatItem, { kind: 'user_message' }> }): React.JSX.Element {
  const theme = useTheme()
  const { provider } = use(TimelineContext)
  return (
    <View style={styles.userRow}>
      {item.steered || item.relayTo ? (
        <View style={styles.userTag}>
          <Feather color={theme.muted} name={item.relayTo ? 'share' : 'zap'} size={11} />
          <Text numberOfLines={1} style={[styles.userTagText, { color: theme.muted }]}>
            {item.relayTo ? `To @${item.relayTo.label}, relayed through main ${provider}` : `Steered: sent while ${provider} worked`}
          </Text>
        </View>
      ) : null}
      {item.images?.length ? <ImageStrip images={item.images} /> : null}
      {item.text ? (
        <View style={[styles.bubble, { backgroundColor: theme.surfaceSoft, borderColor: theme.border }]}>
          <UserText text={item.text} />
        </View>
      ) : null}
    </View>
  )
}

/** "Implement this plan" messages carry the whole plan; it is already on the card above. */
function UserText({ text }: { text: string }): React.JSX.Element {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  if (!text.startsWith(PLAN_IMPLEMENTATION_PREFIX)) {
    return <Text selectable style={[styles.userText, { color: theme.text }]}>{text}</Text>
  }
  const plan = text.slice(PLAN_IMPLEMENTATION_PREFIX.length)
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)}>
      <Text style={[styles.userText, { color: theme.text }]}>
        Implement the plan: {chatPlanTitle(plan)} {open ? '▾' : '▸'}
      </Text>
      {open ? <Text selectable style={[styles.planText, { color: theme.textSoft }]}>{plan}</Text> : null}
    </Pressable>
  )
}

export function ImageStrip({ images }: { images: readonly ChatImageRef[] }): React.JSX.Element {
  const { baseUrl } = use(TimelineContext)
  const theme = useTheme()
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.images} style={styles.imagesScroll}>
      {images.map((image) => (
        <Image
          accessibilityLabel={image.name ?? 'Attached image'}
          key={image.id}
          source={{ uri: `${baseUrl}${chatImageUrl(image.id)}` }}
          style={[styles.image, { borderColor: theme.border, backgroundColor: theme.surface }]}
        />
      ))}
    </ScrollView>
  )
}

function workIcon(item: WorkItem): React.ComponentProps<typeof Feather>['name'] {
  switch (item.kind) {
    case 'command': return 'terminal'
    case 'file_change': return 'edit-3'
    case 'request':
      if (item.requestKind === 'question') return 'help-circle'
      return item.answer?.kind === 'approval' && item.answer.decision !== 'deny' ? 'shield' : 'shield-off'
    default:
      return item.toolName === 'Grep' || item.toolName === 'Glob' || item.toolName === 'WebSearch' ? 'search' : 'tool'
  }
}

function workLabel(item: WorkItem, cwd: string): string {
  switch (item.kind) {
    case 'command': return item.command || 'Running a command'
    case 'file_change': return `${item.toolName === 'Write' ? 'Wrote' : 'Edited'} ${shortPath(item.path, cwd)}`
    case 'request': {
      const answer = item.answer
      if (answer?.kind === 'approval') return `${answer.decision === 'deny' ? 'Denied' : answer.decision === 'allow_always' ? 'Always allowed' : 'Allowed'} ${item.toolName}`
      if (answer?.kind === 'question') return `Answered: ${Object.values(answer.answers).join(' · ')}`
      return `${item.title} (cancelled)`
    }
    default:
      return shortPath(item.title, cwd)
  }
}

function hasDetails(item: WorkItem): boolean {
  switch (item.kind) {
    case 'command': return Boolean(item.output)
    case 'file_change': return Boolean(item.patch || item.output)
    case 'tool': return Boolean(item.detail || item.output || item.images?.length)
    default: return false
  }
}

function WorkEntry({ item }: { item: WorkItem }): React.JSX.Element {
  const theme = useTheme()
  const { cwd } = use(TimelineContext)
  const [open, setOpen] = useState(false)
  const expandable = hasDetails(item)
  const color = item.status === 'failed' ? theme.red : theme.muted
  return (
    <View>
      <Pressable
        accessibilityRole={expandable ? 'button' : 'text'}
        accessibilityState={expandable ? { expanded: open } : {}}
        disabled={!expandable}
        onPress={() => setOpen((value) => !value)}
        style={styles.workLine}
      >
        <View style={styles.workIcon}>
          {item.status === 'running'
            ? <ActivityIndicator color={theme.accent} size="small" style={styles.spinner} />
            : <Feather color={color} name={workIcon(item)} size={13} />}
        </View>
        <Text numberOfLines={1} style={[styles.workLabel, { color: theme.textSoft }, item.kind === 'command' && styles.mono]}>
          {workLabel(item, cwd)}
        </Text>
        {item.kind === 'file_change' ? (
          <Text style={styles.counts}>
            <Text style={{ color: theme.green }}>+{item.additions}</Text> <Text style={{ color: theme.red }}>−{item.deletions}</Text>
          </Text>
        ) : item.kind === 'command' && item.isError ? (
          <Text style={[styles.counts, { color: theme.red }]}>failed</Text>
        ) : null}
      </Pressable>
      {open ? <WorkDetails item={item} /> : null}
    </View>
  )
}

function WorkDetails({ item }: { item: WorkItem }): React.JSX.Element | null {
  switch (item.kind) {
    case 'command':
      return item.output ? <View style={styles.details}><Output text={item.output} /></View> : null
    case 'file_change':
      return (
        <View style={styles.details}>
          {item.patch ? <PatchView patch={item.patch} /> : null}
          {item.isError && item.output ? <Output text={item.output} /> : null}
        </View>
      )
    case 'tool':
      return (
        <View style={styles.details}>
          {item.detail ? <Output text={item.detail} /> : null}
          {item.images?.length ? <ImageStrip images={item.images} /> : null}
          {item.output ? <Output text={item.output} /> : null}
        </View>
      )
    default:
      return null
  }
}

/** The tail of a long output: the end is what tells you how a command went. */
const OUTPUT_TAIL = 6_000

function Output({ text }: { text: string }): React.JSX.Element {
  const theme = useTheme()
  const shown = text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text
  return (
    <ScrollView horizontal style={[styles.output, { backgroundColor: theme.surface, borderColor: theme.border }]} contentContainerStyle={styles.outputContent}>
      <Text selectable style={[styles.outputText, { color: theme.textSoft }]}>{shown}</Text>
    </ScrollView>
  )
}

function PatchView({ patch }: { patch: string }): React.JSX.Element {
  const theme = useTheme()
  return (
    <ScrollView horizontal style={[styles.output, { backgroundColor: theme.surface, borderColor: theme.border }]} contentContainerStyle={styles.outputContent}>
      <View>
        {patchLines(patch).map((line, index) => (
          <Text
            key={index}
            style={[
              styles.outputText,
              { color: line.kind === 'add' ? theme.green : line.kind === 'del' ? theme.red : line.kind === 'gap' ? theme.textDim : theme.textSoft },
              line.kind === 'add' && { backgroundColor: withAlpha(theme.green, 0.08) },
              line.kind === 'del' && { backgroundColor: withAlpha(theme.red, 0.08) },
            ]}
          >
            {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}{line.text}
          </Text>
        ))}
      </View>
    </ScrollView>
  )
}

function WorkGroup({ row }: { row: ActivityRow }): React.JSX.Element {
  const theme = useTheme()
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  // Live groups show their rows; finished ones fold to a summary unless opened.
  const open = userOpen ?? row.live
  const summary = activitySummary(row.items)
  const label = [summary.edits?.label, summary.rest].filter(Boolean).join(', ')
  if (row.items.length === 1 && row.items[0]!.kind === 'reasoning') return <ThoughtRow item={row.items[0]!} />
  return (
    <View style={[styles.work, { backgroundColor: 'transparent', borderColor: theme.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setUserOpen(!open)}
        style={styles.workHead}
      >
        {row.live
          ? <ActivityIndicator color={theme.accent} size="small" style={styles.spinner} />
          : <Feather color={theme.muted} name={open ? 'chevron-down' : 'chevron-right'} size={14} />}
        <Text numberOfLines={open ? undefined : 1} style={[styles.workSummary, { color: theme.textSoft }]}>{label}{summary.failed ? ` · ${summary.failed} failed` : ''}</Text>
      </Pressable>
      {open ? (
        <View style={[styles.workList, { borderLeftColor: theme.border }]}>
          {row.items.map((item) => item.kind === 'reasoning' ? <ThoughtRow item={item} key={item.id} /> : <WorkEntry item={item} key={item.id} />)}
        </View>
      ) : null}
    </View>
  )
}

/** Claude's thinking summary: a collapsed "Thought for 14s" row that opens to the text. */
function ThoughtRow({ item }: { item: ReasoningItem }): React.JSX.Element {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const expandable = Boolean(item.text)
  return (
    <View style={styles.thought}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: !expandable }}
        disabled={!expandable}
        onPress={() => setOpen((value) => !value)}
        style={styles.thoughtHead}
      >
        <Text style={{ color: theme.accent, fontSize: 11 }}>◆</Text>
        <Text style={[styles.mutedLine, { color: theme.muted }]}>{thoughtLabel(item)}</Text>
        {expandable ? <Feather color={theme.textDim} name={open ? 'chevron-down' : 'chevron-right'} size={13} /> : null}
      </Pressable>
      {open ? (
        <View style={[styles.thoughtBody, { borderLeftColor: theme.border }]}>
          <Markdown text={item.text} tone="thought" />
        </View>
      ) : null}
    </View>
  )
}

function PlanCard({ item }: { item: PlanItem }): React.JSX.Element {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const collapsible = canCollapsePlan(item.text)
  const collapsed = collapsible && !expanded
  const copy = () => {
    Clipboard.setStringAsync(`${item.text.trimEnd()}\n`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }, () => undefined)
  }
  return (
    <View accessibilityLabel="Plan" style={[styles.plan, { backgroundColor: theme.surface, borderColor: theme.border }]} testID="plan-card">
      <View style={styles.planHead}>
        <View style={[styles.planTag, { backgroundColor: theme.surfaceSoft }]}>
          <Feather color={theme.accent} name="list" size={11} />
          <Text style={[styles.planTagText, { color: theme.accent }]}>PLAN</Text>
        </View>
        <Text numberOfLines={1} style={[styles.planTitle, { color: theme.text }]}>{chatPlanTitle(item.text)}</Text>
        <Pressable accessibilityLabel={copied ? 'Copied' : 'Copy plan'} accessibilityRole="button" hitSlop={8} onPress={copy}>
          <Feather color={copied ? theme.green : theme.muted} name={copied ? 'check' : 'copy'} size={15} />
        </Pressable>
      </View>
      <Markdown text={collapsed ? collapsedPlanPreview(item.text) : planBody(item.text)} />
      {collapsible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={[styles.planToggle, { borderColor: theme.borderMid }]}
        >
          <Text style={[styles.planToggleText, { color: theme.textSoft }]}>{expanded ? 'Collapse plan' : 'Expand plan'}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const SUBAGENT_STATES: Record<SubagentItem['state'], string> = { quiet: 'quiet', running: 'running', completed: 'done', failed: 'failed', stopped: 'stopped' }

/** Subagents as a summary; their own transcripts stay on the desktop for now. */
function SubagentRows({ items }: { items: SubagentItem[] }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={[styles.work, { backgroundColor: 'transparent', borderColor: theme.border }]}>
      {items.map((agent) => (
        <View key={agent.id} style={styles.workLine}>
          <View style={styles.workIcon}>
            {agent.state === 'running'
              ? <ActivityIndicator color={theme.accent} size="small" style={styles.spinner} />
              : <Feather color={agent.state === 'failed' ? theme.red : agent.state === 'quiet' ? theme.amber : theme.muted} name={agent.state === 'quiet' ? 'alert-circle' : 'cpu'} size={13} />}
          </View>
          <Text numberOfLines={1} style={[styles.workLabel, { color: theme.textSoft }]}>
            {agent.description || agent.subagentType || 'Subagent'}
          </Text>
          <Text style={[styles.counts, { color: theme.textDim }]}>{agent.background ? 'background · ' : ''}{SUBAGENT_STATES[agent.state]}</Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { flex: 1, minHeight: 0 },
  jump: { position: 'absolute', right: 16, bottom: 10, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  jumpLabel: { fontSize: 12.5, fontWeight: '700' },
  content: { paddingHorizontal: 20, paddingVertical: 24, flexGrow: 1, width: '100%', maxWidth: 776, alignSelf: 'center' },
  // Inverted: this sits at the bottom, under the newest turn.
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', transform: [{ scaleY: -1 }] },
  emptyText: { fontSize: 14 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  pulse: { width: 6, height: 6, borderRadius: 3 },
  mutedLine: { fontSize: 13.5 },
  userRow: { alignItems: 'flex-end', gap: 6, paddingTop: 4, paddingBottom: 24 },
  userTag: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '85%' },
  userTagText: { fontSize: 11.5 },
  bubble: { maxWidth: '88%', borderWidth: 0, borderRadius: 18, borderBottomRightRadius: 5, paddingHorizontal: 12, paddingVertical: 8 },
  userText: { fontSize: 15, lineHeight: 21 },
  planText: { fontSize: 13.5, lineHeight: 19, marginTop: 6 },
  imagesScroll: { flexGrow: 0, maxWidth: '85%' },
  images: { gap: 6 },
  image: { width: 72, height: 72, borderRadius: 10, borderWidth: 1 },
  assistant: { paddingBottom: 24 },
  notice: { flexDirection: 'row', gap: 6, paddingBottom: 10 },
  noticeIcon: { marginTop: 2 },
  noticeText: { flex: 1, fontSize: 12.5, lineHeight: 18 },
  workSingle: { paddingBottom: 8 },
  work: { paddingVertical: 6, marginBottom: 16 },
  workHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  workSummary: { flex: 1, fontSize: 13.5, fontWeight: '600' },
  workList: { marginLeft: 6, paddingLeft: 6, borderLeftWidth: 1, marginTop: 2 },
  workLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
  workIcon: { width: 18, alignItems: 'center' },
  spinner: { transform: [{ scale: 0.7 }] },
  workLabel: { flex: 1, fontSize: 13.5 },
  mono: { fontFamily: MONO, fontSize: 12 },
  counts: { fontFamily: MONO, fontSize: 11.5 },
  details: { marginLeft: 24, gap: 6, paddingBottom: 6 },
  output: { maxHeight: 260, borderWidth: 1, borderRadius: 8 },
  outputContent: { paddingHorizontal: 8, paddingVertical: 6 },
  outputText: { fontFamily: MONO, fontSize: 11.5, lineHeight: 16 },
  thought: { paddingBottom: 8 },
  thoughtHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
  thoughtBody: { marginLeft: 5, paddingLeft: 10, borderLeftWidth: 2, marginTop: 2 },
  plan: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8, marginBottom: 12 },
  planHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  planTag: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  planTagText: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  planTitle: { flex: 1, fontSize: 14, fontWeight: '600' },
  planToggle: { alignSelf: 'center', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5 },
  planToggleText: { fontSize: 12.5, fontWeight: '600' },
})

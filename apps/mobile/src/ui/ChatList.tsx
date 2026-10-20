import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import type { SessionIdentities, SessionIdentity } from '@commando/session-identity'
import type { AgentRow } from '../agents/selectors'
import type { HostDaemonState } from '../daemon/state'
import { useAppActive } from '../daemon/useAppActive'
import { useHostsStore } from '../hosts/store'
import type { Host } from '../hosts/types'
import { useChatStore } from '../chat/store'
import { usePanePrs } from '../pane/usePanePrs'
import { readPreference, writePreference } from '../prefs'
import { useTheme } from '../theme'
import { relativeTime } from '../time'
import { buildChatGroups, chatPaneAttention, type Attention } from './chatListModel'
import { createChatRowSelector } from './chatRowMetadata'
import { chatListDestination } from './chatListSelection'
import { SessionAvatar } from './SessionAvatar'
import { useSessionPreferences } from './sessionPreferences'
import { ChatIndicator } from './ChatIndicator'
import { ProviderMark } from './ProviderMark'
import { EmptyState, withAlpha } from './primitives'

const EMPTY_IDENTITIES: SessionIdentities = {}
const EMPTY_SEEN: Record<string, number> = {}
type SessionRow = {
  id: string; name: string; identity: SessionIdentity
  indicator: ReturnType<typeof buildChatGroups>[number]['sessions'][number]['indicator']
  subtitle: string; provider?: string; updatedAt?: number; pending: boolean; openPaneId?: string
  paneIds: string[]; selected: boolean
  children: { id: string; title: string; provider?: string; attention: Attention; selected: boolean }[]
}
type Entry = { kind: 'header'; key: string; name: string; count: number; collapsed: boolean } | { kind: 'session'; key: string; row: SessionRow }

export function ChatList({ state, hostId, selectedPaneId, onSelectPane, onSelectRow, active = true, refreshing = false, onRefresh }: {
  state: HostDaemonState; hostId?: string; selectedPaneId?: string; onSelectPane: (id: string) => void
  onSelectRow?: (row: AgentRow) => void; active?: boolean; refreshing?: boolean; onRefresh?: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const foreground = useAppActive(active)
  const selector = useMemo(() => createChatRowSelector(hostId), [hostId])
  const chats = useChatStore(selector)
  const identities = useSessionPreferences((store) => store.identities[hostId ?? ''] ?? EMPTY_IDENTITIES)
  const seen = useSessionPreferences((store) => store.seen[hostId ?? ''] ?? EMPTY_SEEN)
  const host = useHostsStore((store) => store.hosts.find((candidate) => candidate.id === hostId))
  const groups = useMemo(() => buildChatGroups(state, chats, identities, seen), [state, chats, identities, seen])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ background: true })
  const collapseRef = useRef(collapsed)
  const touched = useRef(false)
  const [visible, setVisible] = useState<Set<string>>(new Set())
  const callbacks = useRef({ state, chats, onSelectPane, onSelectRow })
  callbacks.current = { state, chats, onSelectPane, onSelectRow }
  useEffect(() => {
    let live = true
    void readPreference('commando.chats.collapsed').then((stored) => {
      if (!live || touched.current) return
      try {
        const value: unknown = JSON.parse(stored ?? '{}')
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const valid = Object.fromEntries(Object.entries(value).filter(([, flag]) => typeof flag === 'boolean'))
          collapseRef.current = { background: true, ...valid }
          setCollapsed(collapseRef.current)
        }
      } catch { /* Ignore corrupt local preferences. */ }
    })
    return () => { live = false }
  }, [])
  const toggle = useCallback((id: string) => {
    touched.current = true
    const next = { ...collapseRef.current, [id]: !collapseRef.current[id] }
    collapseRef.current = next; setCollapsed(next)
    void writePreference('commando.chats.collapsed', JSON.stringify(next))
  }, [])
  const select = useCallback((paneId: string) => {
    const current = callbacks.current
    const destination = chatListDestination(current.state, current.chats, paneId)
    if (destination.kind === 'answer' && current.onSelectRow) current.onSelectRow(destination.row)
    else current.onSelectPane(paneId)
  }, [])
  const entries = useMemo<Entry[]>(() => groups.flatMap((group) => [
    { kind: 'header' as const, key: group.id, name: group.name, count: group.sessions.length, collapsed: Boolean(collapsed[group.id]) },
    ...(!collapsed[group.id] ? group.sessions.map((row): Entry => ({ kind: 'session', key: row.session.id, row: {
      id: row.session.id, name: row.session.name, identity: row.identity, indicator: row.indicator,
      subtitle: row.subtitle, provider: row.provider, updatedAt: row.updatedAt, pending: row.pending, openPaneId: row.openPaneId,
      paneIds: row.agents.map((pane) => pane.id), selected: row.openPaneId === selectedPaneId || row.agents.some((pane) => pane.id === selectedPaneId),
      children: row.agents.length > 1 ? row.agents.map((pane) => ({ id: pane.id, title: chats[pane.id]?.session.title || pane.title || 'Agent', provider: chats[pane.id]?.session.provider ?? state.agentStatuses[pane.id]?.provider, attention: chatPaneAttention(state.agentStatuses[pane.id], chats[pane.id], seen[pane.id]), selected: pane.id === selectedPaneId })) : [],
    } })) : []),
  ]), [groups, collapsed, selectedPaneId, chats, state.agentStatuses, seen])
  const viewability = useRef({ itemVisiblePercentThreshold: 1 }).current
  const onVisible = useRef(({ viewableItems }: { viewableItems: { item: Entry; isViewable: boolean }[] }) => {
    setVisible(new Set(viewableItems.filter((entry) => entry.isViewable && entry.item.kind === 'session').map((entry) => entry.item.key)))
  }).current
  return <FlatList
    style={styles.list}
    contentContainerStyle={styles.content}
    data={entries}
    keyExtractor={(entry) => entry.key}
    initialNumToRender={12}
    windowSize={5}
    maxToRenderPerBatch={8}
    keyboardShouldPersistTaps="handled"
    viewabilityConfig={viewability}
    onViewableItemsChanged={onVisible}
    refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.muted} /> : undefined}
    ListEmptyComponent={<EmptyState title="No chats yet" body="Your sessions will appear when the daemon connects." />}
    renderItem={({ item }) => item.kind === 'header'
      ? <GroupHeader entry={item} toggle={toggle} />
      : <SessionListRow row={item.row} host={host} active={foreground && visible.has(item.key)} select={select} />}
  />
}
const GroupHeader = memo(function GroupHeader({ entry, toggle }: { entry: Extract<Entry, { kind: 'header' }>; toggle: (id: string) => void }) {
  const theme = useTheme()
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded: !entry.collapsed }} onPress={() => toggle(entry.key)} style={styles.groupHead}>
    <Feather name={entry.collapsed ? 'chevron-right' : 'chevron-down'} size={14} color={theme.muted} />
    <Text numberOfLines={1} style={[styles.groupName, { color: entry.key === 'background' ? theme.muted : theme.text }]}>{entry.name}</Text>
    <Text style={[styles.count, { color: theme.textDim }]}>{entry.count}</Text>
    <View style={[styles.rule, { backgroundColor: theme.border }]} />
  </Pressable>
})
const SessionListRow = memo(function SessionListRow({ row, host, active, select }: { row: SessionRow; host?: Host; active: boolean; select: (paneId: string) => void }) {
  const theme = useTheme()
  const prs = usePanePrs(host, row.paneIds, active)
  const prCount = prs.some((result) => result.error) ? 0 : new Set(prs.flatMap((result) => result.data?.pullRequests.map((pr) => `${pr.repo}:${pr.number}`) ?? [])).size
  const [, tick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => tick((value) => value + 1), 60_000)
    return () => clearInterval(timer)
  }, [active])
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={row.name} accessibilityState={{ selected: row.selected }} disabled={!row.openPaneId} onPress={() => row.openPaneId && select(row.openPaneId)} style={({ pressed }) => [styles.row, { backgroundColor: row.selected ? theme.surfaceSoft : pressed ? theme.surfaceHover : 'transparent' }]}>
      <View style={styles.indicator}>{row.indicator?.mark ? <Feather name="flag" size={12} color={theme[row.indicator.mark.tone === 'purple' ? 'accent' : row.indicator.mark.tone]} /> : <ChatIndicator attention={row.indicator?.attention ?? 'unknown'} />}</View>
      <SessionAvatar identity={row.identity} />
      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.name, { color: theme.text }]}>{row.name}</Text>
        <View style={styles.subtitleRow}><ProviderMark provider={row.provider} /><Text numberOfLines={1} style={[styles.subtitle, { color: theme.muted }]}>{row.subtitle}</Text></View>
      </View>
      <View style={styles.meta}>
        {row.updatedAt ? <Text style={[styles.time, { color: theme.textDim }]}>{relativeTime(row.updatedAt)}</Text> : null}
        {prCount ? <View style={styles.prBadge}><Feather name="git-pull-request" size={11} color={theme.muted} /><Text style={[styles.time, { color: theme.muted }]}>{prCount}</Text></View> : null}
        {row.pending ? <Text style={[styles.badge, { color: theme.amber, backgroundColor: withAlpha(theme.amber, 0.12) }]}>Answer</Text> : null}
      </View>
    </Pressable>
    {row.children.length > 0 ? <View style={[styles.children, { borderLeftColor: theme.border }]}>{row.children.map((child) =>
      <Pressable key={child.id} accessibilityRole="button" accessibilityState={{ selected: child.selected }} onPress={() => select(child.id)} style={({ pressed }) => [styles.child, { backgroundColor: child.selected ? theme.surfaceSoft : pressed ? theme.surfaceHover : 'transparent' }]}>
        <ProviderMark provider={child.provider} /><Text numberOfLines={1} style={[styles.childName, { color: theme.textSoft }]}>{child.title}</Text><ChatIndicator attention={child.attention} />
      </Pressable>)}</View> : null}
  </View>
}, (a, b) => a.host === b.host && a.active === b.active && a.select === b.select && JSON.stringify(a.row) === JSON.stringify(b.row))
const styles = StyleSheet.create({
  list: { flex: 1, minHeight: 0, overflow: 'hidden' }, content: { paddingHorizontal: 16, paddingBottom: 112 },
  groupHead: { minHeight: 48, marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 4 },
  groupName: { fontSize: 14, fontWeight: '600', flexShrink: 1 }, count: { fontSize: 12, fontVariant: ['tabular-nums'] }, rule: { height: StyleSheet.hairlineWidth, flex: 1, marginLeft: 3 },
  row: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6, paddingVertical: 10, borderRadius: 9 }, indicator: { width: 12, alignItems: 'center' },
  text: { flex: 1, minWidth: 0, gap: 5 }, name: { fontSize: 16, fontWeight: '600' }, subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 }, subtitle: { fontSize: 13, flex: 1 },
  meta: { alignItems: 'flex-end', gap: 6 }, time: { fontSize: 11.5 }, prBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 }, badge: { fontSize: 11, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5 },
  children: { marginLeft: 39, borderLeftWidth: 1, paddingLeft: 10, marginBottom: 6 }, child: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 8, borderRadius: 7 }, childName: { fontSize: 13, flex: 1 },
})

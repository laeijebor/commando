import { useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import { fetchPanePrs } from '../daemon/paneApi'
import { useHostsStore } from '../hosts/store'
import type { HostDaemonState } from '../daemon/state'
import type { SessionIdentities } from '@commando/session-identity'
import { useChatStore, type HostChats } from '../chat/store'
import { readPreference, writePreference } from '../prefs'
import { useTheme } from '../theme'
import { relativeTime } from '../time'
import { buildChatGroups, chatPaneAttention } from './chatListModel'
import { providerPresentation } from './providerPresentation'
import { SessionAvatar } from './SessionAvatar'
import { useSessionPreferences } from './sessionPreferences'
import { ChatIndicator } from './ChatIndicator'
import { EmptyState, withAlpha } from './primitives'

const EMPTY_CHATS: HostChats = {}
const EMPTY_IDENTITIES: SessionIdentities = {}
const EMPTY_SEEN: Record<string, number> = {}
export function ChatList({ state, hostId, selectedPaneId, onSelectPane }: { state: HostDaemonState; hostId?: string; selectedPaneId?: string; onSelectPane: (id: string) => void }): React.JSX.Element {
  const theme = useTheme()
  const [, tick] = useState(0)
  useEffect(() => { const timer = setInterval(() => tick((value) => value + 1), 60_000); return () => clearInterval(timer) }, [])
  const chats = useChatStore((store) => store.byHost[hostId ?? ''] ?? EMPTY_CHATS)
  const identities = useSessionPreferences((store) => store.identities[hostId ?? ''] ?? EMPTY_IDENTITIES)
  const seen = useSessionPreferences((store) => store.seen[hostId ?? ''] ?? EMPTY_SEEN)
  const groups = useMemo(() => buildChatGroups(state, chats, identities, seen), [state, chats, identities, seen])
  const host = useHostsStore((store) => store.hosts.find((candidate) => candidate.id === hostId))
  const agentKeys = groups.flatMap((group) => group.sessions.flatMap((row) => row.agents.map((pane) => `${row.session.id}:${pane.id}`))).join(',')
  const [prCounts, setPrCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    let current = true
    setPrCounts({})
    if (!host) return
    const refresh = async () => {
      const bySession = new Map<string, Set<string>>()
      await Promise.all(agentKeys.split(',').filter(Boolean).map(async (key) => {
        const [sessionId, paneId] = key.split(':')
        try {
          const list = await fetchPanePrs(host, paneId!)
          const prs = bySession.get(sessionId!) ?? new Set<string>()
          list.pullRequests.forEach((pr) => prs.add(`${pr.repo}:${pr.number}`))
          bySession.set(sessionId!, prs)
        } catch { /* Hide badges when PR data is unavailable. */ }
      }))
      if (current) setPrCounts(Object.fromEntries([...bySession].map(([id, prs]) => [id, prs.size])))
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 60_000)
    return () => { current = false; clearInterval(timer) }
  }, [host, agentKeys])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ background: true })
  const [ready, setReady] = useState(false)
  useEffect(() => { let live = true; void readPreference('commando.chats.collapsed').then((stored) => { if (!live) return; try { const value = JSON.parse(stored ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) setCollapsed({ background: true, ...value }) } catch {} setReady(true) }); return () => { live = false } }, [])
  if (!groups.length) return <EmptyState title="No chats yet" body="Your sessions will appear when the daemon connects." />
  return <View>{groups.map((group) => <View key={group.id} style={styles.group}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: !collapsed[group.id] }} onPress={() => { const next = { ...collapsed, [group.id]: !collapsed[group.id] }; setCollapsed(next); if (ready) void writePreference('commando.chats.collapsed', JSON.stringify(next)) }} style={styles.groupHead}>
      <Feather name={collapsed[group.id] ? 'chevron-right' : 'chevron-down'} size={14} color={theme.muted} />
      <Text numberOfLines={1} style={[styles.groupName, { color: group.id === 'background' ? theme.muted : theme.text }]}>{group.name}</Text>
      <Text style={[styles.count, { color: theme.textDim }]}>{group.sessions.length}</Text><View style={[styles.rule, { backgroundColor: theme.border }]} />
    </Pressable>
    {!collapsed[group.id] && group.sessions.map((row) => <View key={row.session.id}>
      <Pressable accessibilityRole="button" accessibilityLabel={row.session.name} accessibilityState={{ selected: row.agents.some((pane) => pane.id === selectedPaneId) }} disabled={!row.openPaneId} onPress={() => row.openPaneId && onSelectPane(row.openPaneId)} style={[styles.row, { backgroundColor: row.agents.some((pane) => pane.id === selectedPaneId) ? theme.surfaceSoft : 'transparent' }]}>
        <View style={styles.indicator}>{row.indicator?.mark ? <Feather name="flag" size={12} color={theme[row.indicator.mark.tone === 'purple' ? 'accent' : row.indicator.mark.tone]} /> : <ChatIndicator attention={row.indicator?.attention ?? 'unknown'} />}</View>
        <SessionAvatar identity={row.identity} />
        <View style={styles.text}><Text numberOfLines={1} style={[styles.name, { color: theme.text }]}>{row.session.name}</Text><Text numberOfLines={1} style={[styles.subtitle, { color: theme.muted }]}>{providerPresentation(row.provider).mark} · {row.subtitle}</Text></View>
        <View style={styles.meta}>{row.updatedAt ? <Text style={[styles.time, { color: theme.textDim }]}>{relativeTime(row.updatedAt)}</Text> : null}{prCounts[row.session.id] ? <View style={styles.prBadge}><Feather name="git-pull-request" size={11} color={theme.muted} /><Text style={[styles.time, { color: theme.muted }]}>{prCounts[row.session.id]}</Text></View> : null}{row.pending ? <Text style={[styles.badge, { color: theme.amber, backgroundColor: withAlpha(theme.amber, 0.12) }]}>Answer</Text> : null}</View>
      </Pressable>
      {row.agents.length > 1 && <View style={[styles.children, { borderLeftColor: theme.border }]}>{row.agents.map((pane) => { const provider = providerPresentation(chats[pane.id]?.session.provider ?? state.agentStatuses[pane.id]?.provider); return <Pressable key={pane.id} accessibilityRole="button" accessibilityState={{ selected: selectedPaneId === pane.id }} onPress={() => onSelectPane(pane.id)} style={[styles.child, { backgroundColor: selectedPaneId === pane.id ? theme.surfaceSoft : 'transparent' }]}><Text style={[styles.mark, { color: theme[provider.accent] }]}>{provider.mark}</Text><Text numberOfLines={1} style={[styles.childName, { color: theme.textSoft }]}>{chats[pane.id]?.session.title || pane.title || provider.name}</Text><ChatIndicator attention={chatPaneAttention(state.agentStatuses[pane.id], chats[pane.id], seen[pane.id])} /></Pressable> })}</View>}
    </View>)}
  </View>)}</View>
}
const styles = StyleSheet.create({
  group: { marginBottom: 16 },
  groupHead: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 4 },
  groupName: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  count: { fontSize: 12, fontVariant: ['tabular-nums'] },
  rule: { height: StyleSheet.hairlineWidth, flex: 1, marginLeft: 3 },
  row: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6, paddingVertical: 10, borderRadius: 9 },
  indicator: { width: 12, alignItems: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { flex: 1, minWidth: 0, gap: 5 },
  name: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 13 },
  meta: { alignItems: 'flex-end', gap: 6 },
  time: { fontSize: 11.5 },
  prBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  badge: { fontSize: 11, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 5 },
  children: { marginLeft: 39, borderLeftWidth: 1, paddingLeft: 10, marginBottom: 6 },
  child: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 8, borderRadius: 7 },
  mark: { fontSize: 10, fontWeight: '700', width: 22 },
  childName: { fontSize: 13, flex: 1 },
})

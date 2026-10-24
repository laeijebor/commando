import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import { fetchGitSummary } from '../daemon/paneApi'
import { useAppActive } from '../daemon/useAppActive'
import { usePollingQuery } from '../daemon/usePollingQuery'
import { usePanePrs } from './usePanePrs'
import { selectedPaneTab, rememberPaneTab } from './tabSelection'
import { useHostState } from '../daemon/store'
import type { Host } from '../hosts/types'
import type { WebPane } from '@commando/protocol'
import { useTheme } from '../theme'
import { PaneInfoSections } from '../ui/PaneInfo'
import { Button } from '../ui/primitives'
import { openTile, closeTile, confirmTile, markTileSeen } from '../tiles/api'
import { paneTabs, type PaneTab } from './tabs'
import { tileWasViewed } from '../tiles/seen'
import { selectedTabOffset, type TabLayout } from './tabScroll'
import { GuideView } from '../guide/GuideView'
import { isGuideTile } from '../guide/model'

export function PaneTabs({ host, paneId, chat, header, children, onOpenTile, active = true }: { host?: Host; paneId?: string; active?: boolean; chat: boolean; header: ReactNode; children: ReactNode; onOpenTile: (tile: WebPane) => void }): React.JSX.Element {
  const theme = useTheme()
  const state = useHostState(host?.id)
  const foreground = useAppActive(active)
  const selectionKey = `${host?.id}:${paneId}`
  const [selected, setSelected] = useState(() => selectedPaneTab(selectionKey))
  const summary = usePollingQuery(`git:${host?.id}:${host?.baseUrl}:${paneId}`, () => fetchGitSummary(host!, paneId!), foreground && Boolean(host && paneId)).data
  const prs = usePanePrs(host, paneId ? [paneId] : [], foreground).flatMap((result) => result.data?.pullRequests ?? [])
  const tabs = paneTabs({ paneId: paneId ?? '', chat, webPanes: state.webPanes, summary, prs, dismissed: state.dismissedPrTabs?.[paneId ?? ''] })
  const strip = useRef<ScrollView>(null)
  const scrollX = useRef(0)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [contentWidth, setContentWidth] = useState(0)
  const [layouts, setLayouts] = useState<Record<string, TabLayout>>({})
  const reveal = useCallback((id: string) => {
    const layout = layouts[id]
    if (!layout) return
    const x = selectedTabOffset(layout, viewportWidth, contentWidth, scrollX.current)
    if (Math.abs(x - scrollX.current) < 0.5) return
    scrollX.current = x
    strip.current?.scrollTo({ x, y: 0, animated: true })
  }, [layouts, viewportWidth, contentWidth])
  const tab = tabs.find((candidate) => candidate.id === selected) ?? tabs[0]!
  useEffect(() => { reveal(tab.id) }, [tab.id, reveal])
  useEffect(() => {
    if (!host || tab.kind !== 'web' || !tileWasViewed(tab.tile, foreground)) return
    void markTileSeen(host, tab.id).catch(() => undefined)
  }, [foreground, host, tab.id, tab.kind, tab.kind === 'web' && tab.tile.unseen])
  return <View style={styles.root}>
    {header}
    <ScrollView ref={strip} onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)} onContentSizeChange={setContentWidth} onScroll={(event) => { scrollX.current = event.nativeEvent.contentOffset.x }} scrollEventThrottle={16} horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} style={[styles.strip, { borderBottomColor: theme.border }]} contentContainerStyle={styles.tabs}>
      {tabs.map((entry) => <Pressable key={entry.id} onLayout={(event) => {
        const { x, width } = event.nativeEvent.layout
        setLayouts((current) => current[entry.id]?.x === x && current[entry.id]?.width === width ? current : { ...current, [entry.id]: { x, width } })
      }} accessibilityRole="tab" hitSlop={4} accessibilityLabel={entry.kind === 'pr' ? `PR ${entry.label} ${entry.state}` : entry.label} accessibilityState={{ selected: entry.id === tab.id }} onPress={() => { Keyboard.dismiss(); reveal(entry.id); setSelected(entry.id); rememberPaneTab(selectionKey, entry.id) }} style={[styles.tab, { borderBottomColor: entry.id === tab.id ? theme.accent : 'transparent' }]}>
        <Feather name={tabIcon(entry)} size={14} color={entry.id === tab.id ? theme.accent : theme.muted} />
        <Text numberOfLines={1} style={[styles.label, { color: entry.id === tab.id ? theme.text : theme.muted }]}>{entry.label}</Text>
        {entry.kind === 'changes' ? <Text style={styles.counts}><Text style={{ color: theme.green }}>+{entry.additions}</Text> <Text style={{ color: theme.red }}>−{entry.deletions}</Text></Text> : null}
        {entry.kind === 'pr' ? <View accessibilityLabel={entry.state} style={[styles.dot, { backgroundColor: entry.state === 'closed' ? theme.red : entry.state === 'merged' ? theme.accent : entry.state === 'draft' ? theme.muted : theme.green }]} /> : null}
        {entry.kind === 'web' && entry.tile.unseen ? <View accessibilityLabel="Unseen" style={[styles.dot, { backgroundColor: theme.accent }]} /> : null}
      </Pressable>)}
    </ScrollView>
    <View style={[styles.body, tab.kind !== 'body' && styles.hidden]} accessibilityElementsHidden={tab.kind !== 'body'} importantForAccessibility={tab.kind !== 'body' ? 'no-hide-descendants' : 'auto'}>{children}</View>
    {host && paneId && tab.kind !== 'body' ? tab.kind === 'web' ? isGuideTile(tab.tile) ? <GuideView key={tab.id} active={foreground} host={host} tile={tab.tile} /> : <WebTabCard key={tab.id} host={host} tab={tab} onOpenTile={onOpenTile} /> : <ScrollView key={tab.id} contentContainerStyle={styles.sections}>
      <PaneInfoSections active={foreground} host={host} paneId={paneId} brief={state.briefs[paneId]} status={state.agentStatuses[paneId]} pane={state.snapshot?.panes.find((pane) => pane.id === paneId)} ports={state.snapshot?.ports ?? []} sections={[tab.kind]} prFilter={tab.kind === 'pr' ? { repo: tab.pr.repo, number: tab.pr.number } : undefined} />
    </ScrollView> : null}
  </View>
}
function tabIcon(tab: PaneTab): React.ComponentProps<typeof Feather>['name'] {
  if (tab.kind === 'web') return tab.content === 'simulator' ? 'smartphone' : tab.content === 'canvas' ? 'layout' : tab.content === 'guide' ? 'book-open' : 'globe'
  return tab.kind === 'body' ? tab.label === 'Chat' ? 'message-circle' : 'terminal' : tab.kind === 'worklog' ? 'list' : tab.kind === 'changes' ? 'git-commit' : 'git-pull-request'
}
function WebTabCard({ host, tab, onOpenTile }: { host: Host; tab: Extract<PaneTab, { kind: 'web' }>; onOpenTile: (tile: WebPane) => void }): React.JSX.Element {
  const theme = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const streamable = !tab.tile.content && tab.tile.engine === 'chromium' && tab.tile.status === 'open'
  const action = async () => {
    setBusy(true); setError(null)
    try {
      if (tab.tile.status === 'pending') await confirmTile(host, tab.tile.id, false)
      else { await closeTile(host, tab.tile.id); await openTile(host, { url: tab.tile.url, anchor: tab.tile.anchorPaneId, placement: tab.tile.placement, engine: 'chromium' }) }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not open this tab') }
    finally { setBusy(false) }
  }
  const detail = tab.tile.content ? `${tab.label} is a ${tab.content} on your Mac. You can follow its agent here; its native view stays on the host.` : tab.tile.status === 'pending' ? 'This page is waiting for your confirmation before it opens.' : streamable ? 'Open the live page to interact, type and leave review notes with the full tile controls.' : 'This page uses the Mac’s WebKit view. Reopen it as chromium to stream it to your phone.'
  return <View style={styles.webBody}><View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
    <Feather name={tabIcon(tab)} color={theme.accent} size={28} /><Text style={[styles.title, { color: theme.text }]}>{tab.label}</Text><Text style={[styles.description, { color: theme.muted }]}>{detail}</Text>
    {!tab.tile.content ? <Text numberOfLines={2} style={[styles.url, { color: theme.textDim }]}>{tab.tile.url}</Text> : null}
    {streamable ? <Button label="Open" onPress={() => onOpenTile(tab.tile)} variant="primary" /> : !tab.tile.content ? <Button busy={busy} label={tab.tile.status === 'pending' ? 'Confirm page' : 'Reopen as chromium'} onPress={() => void action()} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: theme.red }}>{error}</Text> : null}
  </View></View>
}
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  // A zero base height prevents chat/terminal contents from sizing this viewport.
  body: { flex: 1, height: 0, minHeight: 0, overflow: 'hidden' },
  hidden: { display: 'none' },
  strip: { height: 48, flexGrow: 0, flexShrink: 0, borderBottomWidth: StyleSheet.hairlineWidth },
  tabs: { paddingLeft: 10, paddingRight: 28, gap: 3, alignItems: 'stretch' },
  tab: { flexShrink: 0, minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, borderBottomWidth: 2 },
  label: { flexShrink: 0, fontSize: 13, fontWeight: '600' },
  counts: { fontSize: 11, fontVariant: ['tabular-nums'] },
  state: { fontSize: 10 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  sections: { padding: 20, gap: 16, maxWidth: 776, width: '100%', alignSelf: 'center' },
  webBody: { flex: 1, padding: 24, justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 16, padding: 24, gap: 16, maxWidth: 560, width: '100%', alignSelf: 'center' },
  title: { fontSize: 19, fontWeight: '600' },
  description: { fontSize: 15, lineHeight: 23 },
  url: { fontSize: 12 },
})

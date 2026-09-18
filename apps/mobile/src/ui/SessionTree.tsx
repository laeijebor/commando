import { useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import Feather from '@expo/vector-icons/Feather'

import type { AgentStatusKind } from '@commando/protocol'

import {
  sortStatusKinds,
  type TreeRepoGroup,
  type TreeSessionNode,
  type TreeWindowNode,
} from '../agents/selectors'
import { useTheme } from '../theme'
import { Pill, SectionHeader, StatusDot, withAlpha } from './primitives'

/**
 * Adds a window to a session, or splits a window's active pane. The tree owns
 * the navigation rather than taking it as a prop so the "+" affordances can be
 * added without touching the screen around it.
 */
function useCreateRoutes(): { newWindow: (sessionId: string) => void; newPane: (targetId: string) => void } {
  const router = useRouter()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  return {
    newWindow: (sessionId) => router.push({
      pathname: '/(host)/[hostId]/new-window',
      params: { hostId: hostId ?? '', sessionId },
    }),
    newPane: (targetId) => router.push({
      pathname: '/(host)/[hostId]/new-pane',
      params: { hostId: hostId ?? '', targetId },
    }),
  }
}

function AddButton({ label, onPress }: { label: string; onPress: () => void }): React.JSX.Element {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={[styles.add, { borderColor: theme.border, backgroundColor: theme.surfaceRaised }]}
    >
      <Feather color={theme.muted} name="plus" size={14} />
    </Pressable>
  )
}

/**
 * Screen 02's tree view: repo groups, then sessions with their branch and
 * window/pane counts and a status-dot cluster, expanding into windows and their
 * panes and tiles.
 */
export function SessionTree({
  groups,
  onSelectPane,
  selectedPaneId,
}: {
  groups: readonly TreeRepoGroup[]
  onSelectPane?: (paneId: string) => void
  /** The pane the iPad cockpit is showing, highlighted in the tree. */
  selectedPaneId?: string | undefined
}): React.JSX.Element {
  return (
    <View style={styles.tree}>
      {groups.map((group) => (
        <View key={group.id} style={styles.group}>
          <SectionHeader label={group.name} note={group.path} />
          {group.sessions.map((session) => (
            <SessionNode
              key={session.session.id}
              node={session}
              onSelectPane={onSelectPane}
              selectedPaneId={selectedPaneId}
            />
          ))}
        </View>
      ))}
    </View>
  )
}

function SessionNode({
  node,
  onSelectPane,
  selectedPaneId,
}: {
  node: TreeSessionNode
  onSelectPane?: (paneId: string) => void
  selectedPaneId?: string | undefined
}): React.JSX.Element {
  const theme = useTheme()
  const routes = useCreateRoutes()
  const holdsSelection = selectedPaneId !== undefined &&
    node.windows.some((window) => window.children.some((child) => (
      child.kind === 'pane' && child.pane.id === selectedPaneId
    )))
  const [expanded, setExpanded] = useState(holdsSelection)
  const dots = sortStatusKinds(node.statuses).slice(0, 6)

  return (
    <View style={styles.sessionBlock}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${node.session.name} session`}
        onPress={() => setExpanded((current) => !current)}
        style={[
          styles.sessionRow,
          { backgroundColor: theme.surface, borderColor: expanded ? theme.borderStrong : theme.border },
        ]}
      >
        <Feather color={theme.muted} name={expanded ? 'chevron-down' : 'chevron-right'} size={16} />
        <View style={styles.sessionText}>
          <Text numberOfLines={1} style={[styles.sessionName, { color: theme.text }]}>
            {node.session.name}
          </Text>
          <Text numberOfLines={1} style={[styles.sessionMeta, { color: theme.muted }]}>
            <Text style={styles.mono}>{node.branch ? `⎇ ${node.branch}` : 'no repo'}</Text>
            {` · ${node.windowCount} ${node.windowCount === 1 ? 'window' : 'windows'} · ${node.paneCount} ${node.paneCount === 1 ? 'pane' : 'panes'}`}
          </Text>
        </View>
        <View style={styles.dots}>
          {dots.map((status: AgentStatusKind, index) => (
            <StatusDot key={`${status}-${index}`} size={9} status={status} />
          ))}
        </View>
        <AddButton
          label={`New window in ${node.session.name}`}
          onPress={() => routes.newWindow(node.session.id)}
        />
      </Pressable>

      {expanded ? (
        <View style={[styles.children, { borderLeftColor: theme.border }]}>
          {node.windows.map((window) => (
            <WindowNode
              key={window.id}
              node={window}
              onSelectPane={onSelectPane}
              selectedPaneId={selectedPaneId}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}

function WindowNode({
  node,
  onSelectPane,
  selectedPaneId,
}: {
  node: TreeWindowNode
  onSelectPane?: (paneId: string) => void
  selectedPaneId?: string | undefined
}): React.JSX.Element {
  const theme = useTheme()
  const routes = useCreateRoutes()
  return (
    <View style={styles.windowBlock}>
      <View style={styles.windowHead}>
        <Text style={[styles.windowName, { color: theme.textDim }]}>
          {node.index}: {node.name}
        </Text>
        <AddButton label={`Split ${node.name}`} onPress={() => routes.newPane(node.id)} />
      </View>
      {node.children.map((child) => {
        if (child.kind === 'tile') {
          return (
            <View
              key={child.webPane.id}
              style={[styles.leaf, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <Pill label="tile" tone="mute" />
              <View style={styles.leafText}>
                <Text numberOfLines={1} style={[styles.leafName, { color: theme.text }]}>
                  {child.webPane.url}
                </Text>
                <Text numberOfLines={1} style={[styles.leafMeta, { color: theme.muted }]}>
                  {child.webPane.engine} · {child.webPane.status}
                </Text>
              </View>
              <Feather color={theme.textFaint} name="chevron-right" size={16} />
            </View>
          )
        }
        const status = child.status
        const hot = status?.status === 'needs_input' || status?.status === 'failed'
        const selected = child.pane.id === selectedPaneId
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            key={child.pane.id}
            onPress={() => onSelectPane?.(child.pane.id)}
            style={[
              styles.leaf,
              {
                backgroundColor: selected ? theme.surfaceSoft : theme.surface,
                borderColor: selected
                  ? theme.accent
                  : hot
                    ? withAlpha(theme.amber, 0.45)
                    : theme.border,
              },
            ]}
          >
            <Pill
              label={status ? shortProvider(status.provider) : 'sh'}
              tone={status ? providerTone(status.provider) : 'shell'}
            />
            <View style={styles.leafText}>
              <Text numberOfLines={1} style={[styles.leafName, { color: theme.text }]}>
                {child.pane.title || child.pane.command}
                <Text style={[styles.leafIndex, { color: theme.textDim }]}> {child.pane.targetId}</Text>
              </Text>
              <Text numberOfLines={1} style={[styles.leafMeta, { color: theme.muted }]}>
                {status?.summary ?? child.pane.command}
              </Text>
            </View>
            {status ? <StatusDot size={9} status={status.status} /> : null}
          </Pressable>
        )
      })}
    </View>
  )
}

function shortProvider(provider: string): string {
  if (provider === 'claude') return 'CL'
  if (provider === 'codex') return 'CX'
  if (provider === 'opencode') return 'OC'
  return 'sh'
}

function providerTone(provider: string): 'claude' | 'codex' | 'opencode' | 'shell' {
  if (provider === 'claude') return 'claude'
  if (provider === 'codex') return 'codex'
  if (provider === 'opencode') return 'opencode'
  return 'shell'
}

const styles = StyleSheet.create({
  tree: { gap: 16 },
  group: { gap: 8 },
  sessionBlock: { gap: 6 },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  sessionText: { flex: 1, gap: 3 },
  sessionName: { fontSize: 15, fontWeight: '600' },
  sessionMeta: { fontSize: 12 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  children: { borderLeftWidth: 1, marginLeft: 8, paddingLeft: 14, gap: 8, paddingVertical: 4 },
  windowBlock: { gap: 6 },
  windowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  add: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  windowName: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  leaf: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 10,
  },
  leafText: { flex: 1, gap: 2 },
  leafName: { fontSize: 14, fontWeight: '600' },
  leafIndex: { fontSize: 12, fontWeight: '500' },
  leafMeta: { fontSize: 12 },
})

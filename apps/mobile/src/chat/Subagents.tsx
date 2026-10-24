import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import type { ChatItem, ChatTaskAction } from '@commando/agent-chat'
import {
  relayAvailability,
  subagentControls,
  subagentLabel,
  subagentLive,
  subagentMetrics,
  subagentTypeLabel,
  type SubagentMetrics,
} from '@commando/chat-subagents'
import type { SubagentItem, TimelineRow } from '@commando/chat-timeline'

import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'

// The phone's take on the web chat's Subagents.tsx: rich rows in a turn, the
// subagent view's header, and the agent switcher. Same helpers, same messages.

export type SubagentTask = (action: ChatTaskAction, agent: SubagentItem) => void

/** A clock that ticks once a second while something live is on screen. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const STATE_NAMES: Record<SubagentItem['state'], string> = { quiet: 'Quiet', running: 'Running', completed: 'Done', failed: 'Failed', stopped: 'Stopped' }

export function SubagentStateIcon({ agent }: { agent: SubagentItem }): React.JSX.Element {
  const theme = useTheme()
  const label = STATE_NAMES[agent.state]
  if (agent.state === 'running') {
    return <View accessibilityLabel={label} style={styles.icon}><ActivityIndicator color={theme.accent} size="small" style={styles.spinner} /></View>
  }
  const [name, color]: [React.ComponentProps<typeof Feather>['name'], string] = agent.state === 'quiet'
    ? ['alert-circle', theme.amber]
    : agent.state === 'completed' ? ['check-circle', theme.green]
      : agent.state === 'failed' ? ['x-circle', theme.red]
        : ['slash', theme.muted]
  return <View accessibilityLabel={label} style={styles.icon}><Feather color={color} name={name} size={14} /></View>
}

/** "background · 3 tools · 1m 05s · quiet for 4m · last action". */
function MetricsText({ info, showLastAction = true, lines = 1 }: { info: SubagentMetrics; showLastAction?: boolean; lines?: number }): React.JSX.Element {
  const theme = useTheme()
  return (
    <Text numberOfLines={lines} style={[styles.metrics, { color: theme.muted }]}>
      {info.line}
      {info.quiet ? <>{info.line ? ' · ' : ''}<Text style={{ color: theme.amber }}>{info.quiet}</Text></> : null}
      {showLastAction && info.lastAction ? ` · ${info.lastAction}` : ''}
    </Text>
  )
}

function AgentName({ agent, size = 14 }: { agent: SubagentItem; size?: number }): React.JSX.Element {
  const theme = useTheme()
  const type = subagentTypeLabel(agent)
  return (
    <Text numberOfLines={1} style={[styles.name, { color: theme.text, fontSize: size }]}>
      {subagentLabel(agent)}
      {type ? <Text style={[styles.type, { color: theme.muted }]}>{'  '}{type}</Text> : null}
    </Text>
  )
}

/** Asks before stopping: a stopped subagent can't be resumed from here. */
export function confirmStop(agent: SubagentItem, provider: string, onStop: () => void): void {
  // Otherwise the composer takes the keyboard back when the alert closes.
  Keyboard.dismiss()
  const external = Boolean(agent.runtime)
  Alert.alert(
    `Stop ${subagentLabel(agent)}?`,
    external
      ? 'This ends the external run on the host. Its output so far stays in its own log.'
      : `${provider} gets the subagent's work so far and carries on without it.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop', style: 'destructive', onPress: onStop },
    ],
  )
}

/** Background and Stop for a running subagent (Stop asks first). */
export function SubagentControls({ agent, onTask, disabled, provider = 'Claude' }: {
  agent: SubagentItem
  onTask: SubagentTask
  disabled?: boolean
  provider?: string
}): React.JSX.Element | null {
  const theme = useTheme()
  const controls = subagentControls(agent)
  if (!controls.stop) return null
  const label = subagentLabel(agent)
  return (
    <View style={styles.controls}>
      {controls.background ? (
        <Pressable
          accessibilityHint={`Runs in the background; ${provider} carries on`}
          accessibilityLabel={`Background ${label}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: Boolean(disabled) }}
          disabled={disabled}
          hitSlop={6}
          onPress={() => {
            void Haptics.selectionAsync()
            onTask('background', agent)
          }}
          style={[styles.control, { borderColor: theme.borderMid, opacity: disabled ? 0.4 : 1 }]}
        >
          <Feather color={theme.textSoft} name="corner-right-down" size={14} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityLabel={`Stop ${label}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: Boolean(disabled) }}
        disabled={disabled}
        hitSlop={6}
        onPress={() => confirmStop(agent, provider, () => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
          onTask('stop', agent)
        })}
        style={[styles.control, { borderColor: theme.borderMid, opacity: disabled ? 0.4 : 1 }]}
      >
        <View style={[styles.stopGlyph, { backgroundColor: theme.red }]} />
      </Pressable>
    </View>
  )
}

/** One turn's subagents as a card; SDK rows open their transcript, external runs offer Stop. */
export function SubagentGroup({ row, items, now, onOpen, onTask, controlsDisabled, provider }: {
  row: Extract<TimelineRow, { kind: 'subagents' }>
  items: readonly ChatItem[]
  now: number
  onOpen?: ((toolUseId: string) => void) | undefined
  onTask?: SubagentTask | undefined
  controlsDisabled?: boolean | undefined
  provider?: string
}): React.JSX.Element {
  const theme = useTheme()
  const running = row.items.filter(subagentLive).length
  return (
    <View style={[styles.group, { borderColor: theme.border, backgroundColor: theme.surface }]} testID="subagent-group">
      {row.items.length > 1 ? (
        <View style={[styles.groupHead, { borderBottomColor: theme.border }]}>
          <Feather color={theme.muted} name="cpu" size={12} />
          <Text style={[styles.groupHeadText, { color: theme.muted }]}>{row.items.length} subagents{running ? ` · ${running} running` : ''}</Text>
        </View>
      ) : null}
      {row.items.map((agent, index) => {
        const openable = Boolean(onOpen) && !agent.runtime
        return (
          <View key={agent.id} style={[styles.groupRow, index > 0 && { borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
            <Pressable
              accessibilityLabel={openable ? `Open subagent ${subagentLabel(agent)}` : subagentLabel(agent)}
              accessibilityRole="button"
              accessibilityState={{ disabled: !openable }}
              disabled={!openable}
              onPress={() => onOpen?.(agent.id)}
              style={({ pressed }) => [styles.groupMain, pressed && { backgroundColor: theme.surfaceHover }]}
              testID={`subagent-row-${agent.id}`}
            >
              <SubagentStateIcon agent={agent} />
              <View style={styles.groupText}>
                <AgentName agent={agent} />
                <MetricsText info={subagentMetrics(agent, items, now)} lines={2} />
              </View>
              {openable ? <Feather color={theme.textDim} name="chevron-right" size={15} /> : null}
            </Pressable>
            {agent.runtime && onTask ? <SubagentControls agent={agent} disabled={controlsDisabled} onTask={onTask} {...(provider ? { provider } : {})} /> : null}
          </View>
        )
      })}
    </View>
  )
}

/** The top of a subagent's view: back to main, what it is, and what can be done with it. */
export function SubagentHeader({ agent, items, now, disabled, onBack, onTask, onMessage, provider = 'Claude' }: {
  agent: SubagentItem
  items: readonly ChatItem[]
  now: number
  disabled?: boolean
  onBack: () => void
  onTask: SubagentTask
  /** Starts a relayed message to it; absent when relaying isn't possible. */
  onMessage?: (() => void) | undefined
  provider?: string
}): React.JSX.Element {
  const theme = useTheme()
  const relay = relayAvailability(agent)
  const message = () => {
    if (relay.ok) onMessage?.()
    else Alert.alert(`Can't message ${subagentLabel(agent)} yet`, relay.reason)
  }
  return (
    <View style={[styles.header, { borderBottomColor: theme.border, backgroundColor: theme.surface }]} testID="subagent-header">
      <View style={styles.headerBar}>
        <Pressable accessibilityLabel="Back to main" accessibilityRole="button" hitSlop={8} onPress={onBack} style={styles.back}>
          <Feather color={theme.accent} name="chevron-left" size={18} />
          <Text style={[styles.backText, { color: theme.accent }]}>Main</Text>
        </Pressable>
        <View style={styles.headerSpacer} />
        <SubagentControls agent={agent} disabled={disabled} onTask={onTask} provider={provider} />
        {onMessage ? (
          <Pressable
            accessibilityHint={relay.ok ? `Main ${provider} forwards your message with its SendMessage tool` : relay.reason}
            accessibilityLabel={`Message ${subagentLabel(agent)}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: Boolean(disabled) || !relay.ok }}
            disabled={disabled}
            hitSlop={4}
            onPress={message}
            style={[styles.message, { borderColor: theme.borderMid, opacity: disabled || !relay.ok ? 0.45 : 1 }]}
          >
            <Feather color={theme.textSoft} name="share" size={12} />
            <Text style={[styles.messageText, { color: theme.textSoft }]}>Message</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.headerAgent}>
        <SubagentStateIcon agent={agent} />
        <View style={styles.headerText}>
          <AgentName agent={agent} size={15} />
          <MetricsText info={subagentMetrics(agent, items, now)} showLastAction={false} />
        </View>
      </View>
    </View>
  )
}

/**
 * Main plus each subagent, after the Claude Code TUI's agent list: a strip
 * above the composer saying which one is on screen, opening to a sheet that
 * switches between them.
 */
export function AgentSwitcher({ agents, items, viewing, now, disabled, externalDisabled, onSelect, onTask, provider = 'Claude' }: {
  agents: SubagentItem[]
  items: readonly ChatItem[]
  /** The viewed subagent's id, or undefined for main. */
  viewing: string | undefined
  now: number
  disabled?: boolean
  externalDisabled?: boolean
  onSelect: (toolUseId: string | undefined) => void
  onTask: SubagentTask
  provider?: string
}): React.JSX.Element {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const running = agents.filter(subagentLive).length
  const viewed = agents.find((agent) => agent.id === viewing)
  const entries: (SubagentItem | undefined)[] = [undefined, ...agents]
  const choose = (agent: SubagentItem | undefined) => {
    if (agent?.runtime) return
    void Haptics.selectionAsync()
    setOpen(false)
    onSelect(agent?.id)
  }
  return (
    <>
      <Pressable
        accessibilityHint="Lists main and its subagents"
        accessibilityLabel={`Agents, viewing ${viewed ? subagentLabel(viewed) : 'Main'}${running ? `, ${running} running` : ''}`}
        accessibilityRole="button"
        onPress={() => {
          Keyboard.dismiss()
          setOpen(true)
        }}
        style={[styles.strip, { borderColor: theme.border, backgroundColor: theme.surface }]}
        testID="agent-switcher"
      >
        {viewed ? <SubagentStateIcon agent={viewed} /> : <Feather color={theme.muted} name="cpu" size={13} />}
        <Text numberOfLines={1} style={[styles.stripText, { color: theme.textSoft }]}>
          Agents · viewing <Text style={{ color: theme.text, fontWeight: '600' }}>{viewed ? subagentLabel(viewed) : 'Main'}</Text>
          {running ? <Text style={{ color: theme.muted }}> · {running} running</Text> : null}
        </Text>
        <Feather color={theme.muted} name="chevron-up" size={14} />
      </Pressable>
      <Modal animationType="slide" onRequestClose={() => setOpen(false)} transparent visible={open}>
        <Pressable accessibilityLabel="Close the agent list" onPress={() => setOpen(false)} style={[styles.backdrop, { backgroundColor: withAlpha('#000000', 0.45) }]} />
        <View style={[styles.sheet, { backgroundColor: theme.surfaceRaised, borderColor: theme.borderMid, paddingBottom: 34 }]} testID="agent-switcher-sheet">
          <View style={[styles.grabber, { backgroundColor: theme.borderStrong }]} />
          <Text style={[styles.sheetTitle, { color: theme.text }]}>Agents</Text>
          <ScrollView accessibilityRole="list" style={styles.sheetList}>
            {entries.map((agent) => {
              const selected = agent?.id === viewing
              const info = agent ? subagentMetrics(agent, items, now) : null
              return (
                <View key={agent?.id ?? 'main'} style={[styles.option, selected && { backgroundColor: withAlpha(theme.accent, 0.12) }]}>
                  <Pressable
                    accessibilityLabel={agent ? subagentLabel(agent) : 'Main'}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled: Boolean(agent?.runtime) }}
                    disabled={Boolean(agent?.runtime)}
                    onPress={() => choose(agent)}
                    style={styles.optionMain}
                  >
                    {agent ? <SubagentStateIcon agent={agent} /> : <View style={styles.icon}><View style={[styles.mainDot, { backgroundColor: theme.accent }]} /></View>}
                    <View style={styles.groupText}>
                      {agent ? <AgentName agent={agent} /> : <Text style={[styles.name, { color: theme.text }]}>Main {provider}</Text>}
                      {info ? <MetricsText info={info} lines={2} showLastAction={Boolean(agent?.runtime)} /> : null}
                    </View>
                    {selected ? <Feather color={theme.accent} name="check" size={15} /> : null}
                  </Pressable>
                  {agent ? <SubagentControls agent={agent} disabled={agent.runtime ? externalDisabled : disabled} onTask={onTask} provider={provider} /> : null}
                </View>
              )
            })}
          </ScrollView>
        </View>
      </Modal>
    </>
  )
}

/** Above the composer while messages go to a subagent through main Claude. */
export function RelayChip({ label, provider = 'Claude', onClear }: { label: string; provider?: string; onClear: () => void }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={[styles.relay, { borderBottomColor: theme.border, backgroundColor: theme.surfaceSoft }]} testID="relay-chip">
      <Feather color={theme.accent} name="share" size={13} />
      <Text numberOfLines={1} style={[styles.relayText, { color: theme.textSoft }]}>
        To <Text style={{ color: theme.text, fontWeight: '600' }}>@{label}</Text>, relayed through main {provider}'s SendMessage
      </Text>
      <Pressable accessibilityLabel="Stop messaging this subagent" accessibilityRole="button" hitSlop={8} onPress={onClear}>
        <Feather color={theme.muted} name="x" size={15} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  icon: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  spinner: { transform: [{ scale: 0.7 }] },
  name: { fontSize: 14, fontWeight: '500' },
  type: { fontSize: 12, fontWeight: '400' },
  metrics: { fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  control: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stopGlyph: { width: 10, height: 10, borderRadius: 2 },
  group: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', marginBottom: 16 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  groupHeadText: { fontSize: 12 },
  groupRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 10 },
  groupMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, paddingRight: 6, paddingVertical: 9, minHeight: 52 },
  groupText: { flex: 1, minWidth: 0, gap: 2 },
  header: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 10, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  headerBar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerSpacer: { flex: 1 },
  headerAgent: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 2 },
  back: { flexDirection: 'row', alignItems: 'center', paddingRight: 4, minHeight: 32 },
  backText: { fontSize: 14, fontWeight: '600' },
  headerText: { flex: 1, minWidth: 0, gap: 1 },
  message: { flexDirection: 'row', gap: 4, height: 30, borderRadius: 15, borderWidth: 1, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  messageText: { fontSize: 12.5, fontWeight: '600' },
  strip: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginTop: 4, paddingHorizontal: 12, minHeight: 36, borderRadius: 18, borderWidth: 1, width: 'auto', maxWidth: 776 },
  stripText: { flex: 1, fontSize: 12.5 },
  backdrop: { flex: 1 },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, paddingTop: 8, maxHeight: '70%' },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginBottom: 8 },
  sheetTitle: { fontSize: 15, fontWeight: '700', paddingHorizontal: 18, paddingBottom: 6 },
  sheetList: { paddingHorizontal: 8 },
  option: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingRight: 8 },
  optionMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 10, minHeight: 52 },
  mainDot: { width: 8, height: 8, borderRadius: 4 },
  relay: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  relayText: { flex: 1, fontSize: 12.5 },
})

import { useEffect, useRef, useState } from 'react'
import { ActionSheetIOS, findNodeHandle, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import {
  hostTakesSettings,
  selectedModelOption,
  type ChatCommand,
  type ChatContextUsage,
  type ChatFileEntry,
  type ChatQueueAction,
  type ChatQueuedMessage,
  type ChatSessionInfo,
  type ChatSettingsChange,
} from '@commando/agent-chat'
import { EFFORT_LABELS, formatTokens, modelLabel, modelMenuAvailable, permissionLabel, permissionModeOptions } from '@commando/chat-composer'

import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'

/**
 * Messages the host holds until Claude's turn ends (the web's QueuedMessages):
 * edit, remove, or steer one in now.
 */
export function QueueList({ queue, disabled, onChange, onEditOrphaned }: {
  queue: ChatQueuedMessage[]
  disabled: boolean
  onChange: (change: ChatQueueAction) => void
  /** The message being edited was sent meanwhile; the edit goes to the composer instead of being lost. */
  onEditOrphaned: (text: string) => void
}): React.JSX.Element {
  const theme = useTheme()
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const latest = useRef({ editing, onEditOrphaned })
  latest.current = { editing, onEditOrphaned }
  useEffect(() => {
    const current = latest.current.editing
    if (!current || queue.some((queued) => queued.id === current.id)) return
    setEditing(null)
    if (current.text.trim()) latest.current.onEditOrphaned(current.text)
  }, [queue])
  // The list unmounts once the queue empties, which also orphans an edit in progress.
  useEffect(() => () => {
    const current = latest.current.editing
    if (current?.text.trim()) latest.current.onEditOrphaned(current.text)
  }, [])
  return (
    <View style={[styles.queue, { borderBottomColor: theme.border }]} testID="chat-queue">
      <Text style={[styles.queueNote, { color: theme.muted }]}>Queued · sent together when Claude's turn ends</Text>
      <ScrollView contentContainerStyle={styles.queueRows} keyboardShouldPersistTaps="handled" nestedScrollEnabled style={styles.queueScroll}>
        {queue.map((queued) => (
          <View key={queued.id} style={[styles.queued, { backgroundColor: theme.surfaceSoft }]}>
            {editing?.id === queued.id ? (
              <View style={styles.queuedEdit}>
                <TextInput
                  accessibilityLabel="Edit queued message"
                  autoFocus
                  multiline
                  onChangeText={(text) => setEditing({ id: queued.id, text })}
                  style={[styles.queuedInput, { color: theme.text, borderColor: theme.borderMid, backgroundColor: theme.surface }]}
                  value={editing.text}
                />
                <View style={styles.queuedActions}>
                  <SmallButton
                    disabled={disabled || !editing.text.trim()}
                    label="Save"
                    onPress={() => {
                      if (editing.text.trim()) onChange({ action: 'edit', id: queued.id, text: editing.text })
                      setEditing(null)
                    }}
                    primary
                  />
                  <SmallButton label="Cancel" onPress={() => setEditing(null)} />
                </View>
              </View>
            ) : (
              <>
                <Text numberOfLines={2} style={[styles.queuedText, { color: theme.textSoft }]}>
                  {queued.images?.length ? `▣ ${queued.images.length} · ` : ''}{queued.text || '(images only)'}
                </Text>
                <IconButton disabled={disabled || !queued.text} icon="edit-2" label="Edit queued message" onPress={() => setEditing({ id: queued.id, text: queued.text })} />
                <SmallButton disabled={disabled} icon="zap" label="Steer" onPress={() => onChange({ action: 'steer', id: queued.id })} />
                <IconButton disabled={disabled} icon="x" label="Remove queued message" onPress={() => onChange({ action: 'remove', id: queued.id })} />
              </>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

export type MenuItem =
  | { key: string; type: 'native'; name: 'model' | 'plan'; description: string }
  | { key: string; type: 'command'; command: ChatCommand; runsHere: boolean }
  | { key: string; type: 'file'; entry: ChatFileEntry }

/** The `/` and `@` menus, above the composer (the web's ComposerMenu). */
export function TriggerMenu({ label, items, status, onPick, onDismiss }: {
  label: string
  items: MenuItem[]
  status: string | null
  onPick: (item: MenuItem) => void
  onDismiss: () => void
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <View accessibilityLabel={label} style={[styles.menu, { borderBottomColor: theme.border }]} testID="chat-menu">
      <View style={styles.menuHead}>
        <Text style={[styles.menuLabel, { color: theme.muted }]}>{label.toUpperCase()}</Text>
        <IconButton icon="x" label="Close menu" onPress={onDismiss} />
      </View>
      <ScrollView keyboardShouldPersistTaps="always" style={styles.menuList} nestedScrollEnabled>
        {items.map((item) => (
          <Pressable
            accessibilityRole="button"
            key={item.key}
            onPress={() => onPick(item)}
            style={({ pressed }) => [styles.menuItem, pressed && { backgroundColor: theme.surfaceHover }]}
          >
            {item.type === 'file' ? (
              <>
                <Feather color={theme.muted} name={item.entry.kind === 'directory' ? 'folder' : 'file'} size={13} />
                <Text numberOfLines={1} style={[styles.menuName, styles.menuPath, { color: theme.text }]}>{item.entry.path}</Text>
              </>
            ) : (
              <>
                <Text numberOfLines={1} style={[styles.menuName, { color: theme.text }]}>
                  /{item.type === 'native' ? item.name : item.command.name}
                  {item.type === 'command' && item.command.argumentHint ? <Text style={{ color: theme.textDim }}> {item.command.argumentHint}</Text> : null}
                </Text>
                <Text numberOfLines={1} style={[styles.menuDescription, { color: theme.muted }]}>
                  {item.type === 'native' ? item.description : item.command.description}
                </Text>
                {item.type === 'command' && item.command.kind === 'skill' ? (
                  <Text style={[styles.menuTag, { color: theme.accent, borderColor: withAlpha(theme.accent, 0.35) }]}>skill</Text>
                ) : null}
              </>
            )}
          </Pressable>
        ))}
        {status ? <Text style={[styles.menuStatus, { color: theme.muted }]}>{status}</Text> : null}
      </ScrollView>
    </View>
  )
}

/** Shows a native action sheet anchored to `anchor` (a popover on iPad); resolves the picked index. */
function showSheet(anchor: View | null, title: string, options: string[], selected: number): Promise<number | null> {
  const node = anchor ? findNodeHandle(anchor) : null
  return new Promise((resolve) => {
    ActionSheetIOS.showActionSheetWithOptions({
      title,
      options: [...options.map((option, index) => (index === selected ? `✓ ${option}` : option)), 'Cancel'],
      cancelButtonIndex: options.length,
      ...(node ? { anchor: node } : {}),
      userInterfaceStyle: 'dark',
    }, (index) => resolve(index < options.length ? index : null))
  })
}

/** The model, effort and permission pills (the web's pickers) as native menus; the context meter is read-only. */
export function SettingsPills({ session, disabled, onConfigure, modelSheet, onModelSheetShown }: {
  session: ChatSessionInfo
  disabled: boolean
  onConfigure: (change: ChatSettingsChange) => void
  /** Bumped by `/model` to open the model menu. */
  modelSheet: number
  onModelSheetShown: () => void
}): React.JSX.Element {
  const modelRef = useRef<View>(null)
  const effortRef = useRef<View>(null)
  const permissionRef = useRef<View>(null)
  const label = modelLabel(session)
  const selected = selectedModelOption(session)
  const efforts = selected?.efforts ?? []
  const settable = hostTakesSettings(session)
  const models = modelMenuAvailable(session) ? session.models ?? [] : []

  const pickModel = async () => {
    if (!models.length) return
    const index = await showSheet(modelRef.current, 'Model', models.map((model) => model.displayName), selected ? models.indexOf(selected) : -1)
    const model = index === null ? undefined : models[index]
    if (model && model !== selected) onConfigure({ model: model.value })
  }

  useEffect(() => {
    if (!modelSheet) return
    onModelSheetShown()
    void pickModel()
    // Only a new `/model` opens the menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelSheet])

  const pickEffort = async () => {
    const index = await showSheet(effortRef.current, 'Effort', efforts.map((effort) => EFFORT_LABELS[effort]), session.effort ? efforts.indexOf(session.effort) : -1)
    const effort = index === null ? undefined : efforts[index]
    if (effort && effort !== session.effort) onConfigure({ effort })
  }

  const modes = settable ? permissionModeOptions(session) : []
  const pickPermission = async () => {
    const current = session.permissionMode
    const index = await showSheet(permissionRef.current, 'Permissions', modes.map((mode) => permissionLabel(mode, session)), modes.findIndex((mode) => mode === current))
    const mode = index === null ? undefined : modes[index]
    if (mode && mode !== current) onConfigure({ permissionMode: mode })
  }

  return (
    <>
      {label ? <Pill disabled={disabled || !models.length} label={label} onPress={() => void pickModel()} ref={modelRef} a11y="Model" /> : null}
      {efforts.length || session.effort ? (
        <Pill
          a11y="Effort"
          disabled={disabled || !settable || !efforts.length}
          label={session.effort ? EFFORT_LABELS[session.effort] : 'Effort'}
          onPress={() => void pickEffort()}
          ref={effortRef}
        />
      ) : null}
      {session.permissionMode ? (
        <Pill
          a11y="Permissions"
          disabled={disabled || !modes.length}
          label={permissionLabel(session.permissionMode, session)}
          onPress={() => void pickPermission()}
          ref={permissionRef}
        />
      ) : null}
    </>
  )
}

function Pill({ label, a11y, disabled, onPress, ref }: { label: string; a11y: string; disabled: boolean; onPress: () => void; ref: React.Ref<View> }): React.JSX.Element {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityLabel={`${a11y}: ${label}`}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        void Haptics.selectionAsync()
        onPress()
      }}
      ref={ref}
      style={[styles.pill, { borderColor: theme.border, opacity: disabled ? 0.6 : 1 }]}
    >
      <Text numberOfLines={1} style={[styles.pillText, { color: theme.muted }]}>{label}</Text>
    </Pressable>
  )
}

/** How full the context window is; read-only on the phone (Compact stays on the desktop). */
export function ContextMeter({ usage }: { usage: ChatContextUsage }): React.JSX.Element {
  const theme = useTheme()
  const used = Math.max(0, Math.min(100, (usage.usedTokens / usage.maxTokens) * 100))
  const color = used > 90 ? theme.red : theme.accent
  return (
    <View
      accessibilityLabel={`Context window ${Math.round(used)}% used, ${formatTokens(usage.usedTokens)} of ${formatTokens(usage.maxTokens)}`}
      accessible
      style={styles.meter}
    >
      <View style={[styles.meterTrack, { backgroundColor: theme.surfaceHover }]}>
        <View style={[styles.meterFill, { width: `${used}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.meterText, { color: used > 90 ? theme.red : theme.textDim }]}>{Math.round(used)}%</Text>
    </View>
  )
}

export function IconButton({ icon, label, onPress, disabled }: { icon: React.ComponentProps<typeof Feather>['name']; label: string; onPress: () => void; disabled?: boolean }): React.JSX.Element {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={[styles.iconButton, { opacity: disabled ? 0.4 : 1 }]}
    >
      <Feather color={theme.muted} name={icon} size={15} />
    </Pressable>
  )
}

function SmallButton({ label, icon, onPress, disabled, primary }: { label: string; icon?: React.ComponentProps<typeof Feather>['name']; onPress: () => void; disabled?: boolean; primary?: boolean }): React.JSX.Element {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.smallButton, {
        backgroundColor: primary ? theme.accent : theme.surface,
        borderColor: primary ? 'transparent' : theme.borderMid,
        opacity: disabled ? 0.4 : 1,
      }]}
    >
      {icon ? <Feather color={primary ? theme.accentInk : theme.textSoft} name={icon} size={12} /> : null}
      <Text style={[styles.smallButtonText, { color: primary ? theme.accentInk : theme.textSoft }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  queue: { gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  queueNote: { fontSize: 11.5 },
  queueScroll: { maxHeight: 150, flexGrow: 0 },
  queueRows: { gap: 6 },
  queued: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, paddingLeft: 10, paddingRight: 4, paddingVertical: 4 },
  queuedText: { flex: 1, fontSize: 14, lineHeight: 19 },
  queuedEdit: { flex: 1, gap: 6, paddingVertical: 4, paddingRight: 6 },
  queuedInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, maxHeight: 120 },
  queuedActions: { flexDirection: 'row', gap: 6 },
  menu: { borderBottomWidth: StyleSheet.hairlineWidth, paddingTop: 4 },
  menuHead: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 6 },
  menuLabel: { flex: 1, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  menuList: { maxHeight: 220 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, minHeight: 38 },
  menuName: { fontSize: 14, fontWeight: '600', maxWidth: '55%' },
  menuPath: { maxWidth: '90%', fontWeight: '500' },
  menuDescription: { flex: 1, fontSize: 12.5 },
  menuTag: { fontSize: 10.5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },
  menuStatus: { fontSize: 12.5, paddingHorizontal: 14, paddingVertical: 8 },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, maxWidth: 170 },
  pillText: { fontSize: 12.5 },
  meter: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meterTrack: { width: 22, height: 4, borderRadius: 2, overflow: 'hidden' },
  meterFill: { height: 4 },
  meterText: { fontSize: 11, fontVariant: ['tabular-nums'] },
  iconButton: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  smallButton: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5 },
  smallButtonText: { fontSize: 12.5, fontWeight: '600' },
})

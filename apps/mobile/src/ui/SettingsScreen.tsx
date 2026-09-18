import { useEffect, useMemo, useState } from 'react'
import { useLocalSearchParams } from 'expo-router'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import { useDaemonConnection } from '../daemon/useDaemonConnection'
import { useHostsStore } from '../hosts/store'
import {
  TERMINAL_FONT_SIZES,
  useHydratedTerminalPrefs,
} from '../terminal/prefs'
import {
  DEFAULT_QUIET_HOURS,
  deviceTimeZone,
  isClockTime,
  registrationSummary,
  toggleMutedSession,
  usePushStore,
  withQuietHours,
  type PushRules,
} from '../notifications'
import { THEMES, THEME_NAMES, useTheme, useThemeContext } from '../theme'
import { Button, Card, Meta, ScreenTitle, SectionHeader, Segmented, withAlpha } from './primitives'

/**
 * Screen 09. The notification rows write through to the local preference and
 * are re-`PUT` to every connected daemon, which is where the rules are
 * actually evaluated. The theme picker and the host list are unchanged.
 */
export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme()
  const { themeName, setThemeName } = useThemeContext()
  const hosts = useHostsStore((state) => state.hosts)
  const terminal = useHydratedTerminalPrefs()
  const { hostId } = useLocalSearchParams<{ hostId?: string }>()

  const host = useMemo(
    () => hosts.find((candidate) => candidate.id === hostId) ?? hosts[0],
    [hosts, hostId],
  )
  const state = useDaemonConnection(host)

  const push = usePushStore()
  const [testResult, setTestResult] = useState<string | null>(null)
  const [busy, setBusy] = useState<'enable' | 'test' | null>(null)

  useEffect(() => {
    if (!push.hydrated) void usePushStore.getState().hydrate()
  }, [push.hydrated])

  const applyRules = (next: PushRules): void => {
    void Haptics.selectionAsync()
    void usePushStore.getState().setRules(next, hosts)
  }

  const sessionNames = useMemo(() => {
    const names = (state.snapshot?.sessions ?? []).map((session) => session.name)
    for (const muted of push.rules.mutedSessions) if (!names.includes(muted)) names.push(muted)
    return names
  }, [state.snapshot, push.rules.mutedSessions])

  const quietHours = push.rules.quietHours

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <ScreenTitle title="Settings" />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <SectionHeader label="Notify me when" note={host?.name} />
        <Card>
          <ToggleRow
            hint="Questions and permission prompts"
            label="An agent needs input"
            onChange={(value) => applyRules({ ...push.rules, needsInput: value })}
            value={push.rules.needsInput}
          />
          <ToggleRow
            hint="Uses the recap headline"
            label="An agent finishes"
            onChange={(value) => applyRules({ ...push.rules, done: value })}
            value={push.rules.done}
          />
          <ToggleRow
            label="An agent fails"
            onChange={(value) => applyRules({ ...push.rules, failed: value })}
            value={push.rules.failed}
          />
          <ToggleRow
            hint={quietHours
              ? `${quietHours.timeZone} · a window may cross midnight`
              : 'Silence pushes overnight'}
            label="Quiet hours"
            last={!quietHours}
            onChange={(value) => applyRules(withQuietHours(
              push.rules,
              value ? { ...DEFAULT_QUIET_HOURS, timeZone: deviceTimeZone() } : null,
            ))}
            value={Boolean(quietHours)}
          />
          {quietHours ? (
            <View style={styles.quietRow}>
              <ClockField
                label="From"
                onCommit={(value) => applyRules(withQuietHours(push.rules, { ...quietHours, start: value }))}
                value={quietHours.start}
              />
              <ClockField
                label="To"
                onCommit={(value) => applyRules(withQuietHours(push.rules, { ...quietHours, end: value }))}
                value={quietHours.end}
              />
            </View>
          ) : null}
        </Card>

        <SectionHeader label="Muted sessions" note={String(push.rules.mutedSessions.length)} />
        <Card>
          {sessionNames.length === 0 ? (
            <Meta>
              {host ? 'No tmux sessions in the last snapshot.' : 'Add a host to mute its sessions.'}
            </Meta>
          ) : (
            sessionNames.map((name, index) => (
              <ToggleRow
                key={name}
                label={name}
                last={index === sessionNames.length - 1}
                onChange={() => applyRules(toggleMutedSession(push.rules, name))}
                value={push.rules.mutedSessions.includes(name)}
              />
            ))
          )}
        </Card>

        <SectionHeader label="Registration" />
        <Card style={styles.registration}>
          <Text style={[styles.value, { color: theme.textSoft }]}>{registrationSummary(push)}</Text>
          {push.token.kind === 'token' ? (
            <Text numberOfLines={1} style={[styles.token, { color: theme.textDim }]}>
              {push.token.value}
            </Text>
          ) : (
            <Button
              busy={busy === 'enable'}
              label={push.permission === 'denied' ? 'Allow in iOS Settings, then retry' : 'Allow notifications'}
              onPress={() => {
                setBusy('enable')
                void usePushStore.getState().enable()
                  .then(() => usePushStore.getState().registerAll(hosts))
                  .finally(() => setBusy(null))
              }}
              variant="primary"
            />
          )}
          <Button
            busy={busy === 'test'}
            disabled={!host || push.token.kind !== 'token'}
            label="Send test notification"
            onPress={() => {
              if (!host) return
              setBusy('test')
              void usePushStore.getState().sendTest(host)
                .then((result) => setTestResult(result.message))
                .finally(() => setBusy(null))
            }}
          />
          {testResult ? <Meta>{testResult}</Meta> : null}
        </Card>

        <SectionHeader label="Appearance" />
        <View style={styles.themes}>
          {THEME_NAMES.map((name) => {
            const candidate = THEMES[name]
            const active = name === themeName
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={candidate.label}
                key={name}
                onPress={() => {
                  setThemeName(name)
                  void Haptics.selectionAsync()
                }}
                style={[
                  styles.themeCard,
                  {
                    backgroundColor: candidate.surface,
                    borderColor: active ? candidate.accent : theme.border,
                  },
                ]}
              >
                <View style={[styles.swatch, { backgroundColor: candidate.accent }]} />
                <Text style={[styles.themeLabel, { color: candidate.text }]}>{candidate.label}</Text>
                {active ? <Feather color={candidate.accent} name="check" size={16} /> : null}
              </Pressable>
            )
          })}
        </View>

        <SectionHeader label="Terminal" />
        <Card>
          <View style={[styles.row, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }]}>
            <View style={styles.rowText}>
              <Text style={[styles.label, { color: theme.text }]}>Fit pane to phone</Text>
              <Text style={[styles.hint, { color: theme.muted }]}>
                The default for a pane you open. Fitting takes the resize lease and
                shrinks the real tmux pane, so it stays opt-in.
              </Text>
            </View>
            <Switch
              accessibilityLabel="Fit pane to phone by default"
              ios_backgroundColor={theme.borderMid}
              onValueChange={(next) => {
                terminal.setFitToPhone(next)
                void Haptics.selectionAsync()
              }}
              thumbColor="#ffffff"
              trackColor={{ false: theme.borderMid, true: withAlpha(theme.green, 0.9) }}
              value={terminal.fitToPhone}
            />
          </View>
          <View style={styles.fontSize}>
            <Text style={[styles.label, { color: theme.text }]}>Font size</Text>
            <Segmented
              onChange={(value) => {
                terminal.setFontSize(Number.parseInt(value, 10))
                void Haptics.selectionAsync()
              }}
              options={TERMINAL_FONT_SIZES.map((size) => ({
                value: String(size),
                label: String(size),
              }))}
              value={String(terminal.fontSize)}
            />
          </View>
        </Card>

        <SectionHeader label="Hosts" note={String(hosts.length)} />
        <Card>
          {hosts.length === 0 ? (
            <Text style={[styles.value, { color: theme.muted }]}>No hosts added yet.</Text>
          ) : (
            hosts.map((candidate, index) => (
              <ValueRow
                key={candidate.id}
                label={candidate.name}
                last={index === hosts.length - 1}
                value={push.registrations[candidate.id]?.ok
                  ? 'Push registered'
                  : candidate.auth.kind === 'token' ? 'Token' : 'Session'}
              />
            ))
          )}
        </Card>
      </ScrollView>
    </SafeAreaView>
  )
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
  last,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (value: boolean) => void
  last?: boolean
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <View
      style={[
        styles.row,
        last ? null : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
      ]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
        {hint ? <Text style={[styles.hint, { color: theme.muted }]}>{hint}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        ios_backgroundColor={theme.surfaceSoft}
        onValueChange={onChange}
        thumbColor={theme.text}
        trackColor={{ false: theme.surfaceSoft, true: withAlpha(theme.accent, 0.7) }}
        value={value}
      />
    </View>
  )
}

/**
 * A plain `HH:MM` field rather than a picker module: that is exactly the shape
 * `rules.quietHours` takes, and the zone comes from the device.
 */
function ClockField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const theme = useTheme()
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const valid = isClockTime(draft)
  return (
    <View style={styles.clockField}>
      <Text style={[styles.hint, { color: theme.muted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={`Quiet hours ${label.toLowerCase()}`}
        keyboardType="numbers-and-punctuation"
        maxLength={5}
        onBlur={() => (valid ? onCommit(draft) : setDraft(value))}
        onChangeText={setDraft}
        placeholder="23:00"
        placeholderTextColor={theme.textDim}
        style={[
          styles.clockInput,
          {
            backgroundColor: theme.surfaceSoft,
            borderColor: valid ? theme.border : theme.red,
            color: theme.text,
          },
        ]}
        value={draft}
      />
    </View>
  )
}

function ValueRow({
  label,
  value,
  hint,
  last,
}: {
  label: string
  value: string
  hint?: string
  last?: boolean
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <View
      style={[
        styles.row,
        last ? null : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
      ]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
        {hint ? <Text style={[styles.hint, { color: theme.muted }]}>{hint}</Text> : null}
      </View>
      <Text style={[styles.value, { color: theme.muted }]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 40, gap: 10 },
  themes: { gap: 8 },
  themeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  swatch: { width: 18, height: 18, borderRadius: 9 },
  themeLabel: { flex: 1, fontSize: 15, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
  },
  rowText: { flex: 1, gap: 2 },
  fontSize: { gap: 8, paddingVertical: 11 },
  label: { fontSize: 15 },
  hint: { fontSize: 12, lineHeight: 17 },
  value: { fontSize: 14 },
  quietRow: { flexDirection: 'row', gap: 10, paddingTop: 10 },
  clockField: { flex: 1, gap: 4 },
  clockInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  registration: { gap: 10 },
  token: { fontSize: 11.5 },
})

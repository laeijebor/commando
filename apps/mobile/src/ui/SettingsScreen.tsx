import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import { useHostsStore } from '../hosts/store'
import {
  TERMINAL_FONT_SIZES,
  useHydratedTerminalPrefs,
} from '../terminal/prefs'
import { THEMES, THEME_NAMES, useTheme, useThemeContext } from '../theme'
import { Card, ScreenTitle, SectionHeader, Segmented, withAlpha } from './primitives'

/**
 * Screen 09. The theme picker is live — it writes through to SecureStore and
 * repaints immediately. The notification, mute and terminal rows are labelled
 * with what will drive them once the daemon's push registry is wired up.
 */
export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme()
  const { themeName, setThemeName } = useThemeContext()
  const hosts = useHostsStore((state) => state.hosts)
  const terminal = useHydratedTerminalPrefs()

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <ScreenTitle title="Settings" />
      <ScrollView contentContainerStyle={styles.body}>
        <SectionHeader label="Theme" />
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

        <SectionHeader label="Notifications" note="Phase 6" />
        <Card>
          <StubRow label="Notify on needs input" value="Daemon rules" />
          <StubRow label="Notify on done" value="Daemon rules" />
          <StubRow label="Quiet hours" value="Not set" />
          <StubRow label="Muted sessions" value="None" last />
        </Card>

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
            hosts.map((host, index) => (
              <StubRow
                key={host.id}
                label={host.name}
                last={index === hosts.length - 1}
                value={host.auth.kind === 'token' ? 'Token' : 'Session'}
              />
            ))
          )}
        </Card>
      </ScrollView>
    </SafeAreaView>
  )
}

function StubRow({
  label,
  value,
  last,
}: {
  label: string
  value: string
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
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
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
  hint: { fontSize: 12, lineHeight: 17 },
  fontSize: { gap: 8, paddingVertical: 11 },
  label: { fontSize: 15 },
  value: { fontSize: 14 },
})

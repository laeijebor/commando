import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import { useHostsStore } from '../hosts/store'
import { THEMES, THEME_NAMES, useTheme, useThemeContext } from '../theme'
import { Card, ScreenTitle, SectionHeader } from './primitives'

/**
 * Screen 09. The theme picker is live — it writes through to SecureStore and
 * repaints immediately. The notification, mute and terminal rows are labelled
 * with what will drive them once the daemon's push registry is wired up.
 */
export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme()
  const { themeName, setThemeName } = useThemeContext()
  const hosts = useHostsStore((state) => state.hosts)

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

        <SectionHeader label="Terminal" note="Phase 4" />
        <Card>
          <StubRow label="Fit to phone" value="Off" />
          <StubRow label="Font size" value="11pt" last />
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
  label: { fontSize: 15 },
  value: { fontSize: 14 },
})

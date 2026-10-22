import { useEffect } from 'react'
import { useIsFocused, useRouter } from 'expo-router'
import { useRouteParams } from '../layout/routeParams'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'
import { markTileSeen } from '../tiles/api'
import { useAppActive } from '../daemon/useAppActive'
import { useHostsStore } from '../hosts/store'
import { returnFromTile } from '../tiles/returnToPane'
import { useTheme } from '../theme'
import { withAlpha } from '../ui/primitives'

/** A local preview for fixture screenshots; the demo never connects a CDP socket. */
export function DemoTileScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId, fromPaneId, tileId } = useRouteParams<{ hostId: string; fromPaneId?: string; tileId: string }>()
  const host = useHostsStore((store) => store.hosts.find((entry) => entry.id === hostId))
  const foreground = useAppActive(useIsFocused())
  useEffect(() => { if (foreground && host && tileId) void markTileSeen(host, tileId).catch(() => undefined) }, [foreground, host, tileId])
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={[styles.nav, { borderBottomColor: theme.border }]}>
        <Pressable accessibilityLabel="Back to chat" onPress={() => returnFromTile(router, hostId, fromPaneId)} style={styles.back}>
          <Feather name="chevron-left" size={25} color={theme.accent} />
        </Pressable>
        <View style={styles.navText}>
          <Text style={[styles.name, { color: theme.text }]}>Companion preview</Text>
          <Text style={[styles.meta, { color: theme.muted }]}>Demo page · local fixture</Text>
        </View>
        <Feather name="globe" size={18} color={theme.muted} />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.brand}>
          <Feather name="command" size={23} color={theme.accent} />
          <Text style={[styles.wordmark, { color: theme.text }]}>commando</Text>
        </View>
        <Text style={[styles.eyebrow, { color: theme.accent }]}>YOUR WORK. WITHIN REACH.</Text>
        <Text style={[styles.hero, { color: theme.text }]}>Keep the{`\n`}conversation{`\n`}moving.</Text>
        <Text style={[styles.description, { color: theme.muted }]}>A quiet place to follow your agents, make a decision and get back to your day.</Text>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.cardHead}>
            <Text style={[styles.name, { color: theme.text }]}>Today’s progress</Text>
            <Text style={[styles.tag, { color: theme.green, backgroundColor: withAlpha(theme.green, 0.1) }]}>2 working</Text>
          </View>
          {['Remote chat is connected', 'Pane tabs are in place', 'Ready for your review'].map((label, i) => (
            <View key={label} style={[styles.task, { borderTopColor: theme.border }]}>
              <Feather name={i < 2 ? 'check-circle' : 'message-circle'} size={17} color={i < 2 ? theme.green : theme.amber} />
              <Text style={[styles.taskText, { color: theme.textSoft }]}>{label}</Text>
            </View>
          ))}
        </View>
        <Text style={[styles.meta, { color: theme.textDim }]}>This fixture is available in development builds. Live hosts open the full browser stream and review controls.</Text>
      </ScrollView>
    </SafeAreaView>
  )
}
const styles = StyleSheet.create({
  screen: { flex: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: 20, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  navText: { flex: 1, gap: 3 },
  name: { fontSize: 15, fontWeight: '600' },
  meta: { fontSize: 12, lineHeight: 18 },
  body: { padding: 28, paddingTop: 40, gap: 24, maxWidth: 650, width: '100%', alignSelf: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 26 },
  wordmark: { fontSize: 23, fontWeight: '600', letterSpacing: -0.7 },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  hero: { fontSize: 44, fontWeight: '600', lineHeight: 49, letterSpacing: -1.6 },
  description: { fontSize: 16, lineHeight: 25 },
  card: { marginTop: 16, borderWidth: 1, borderRadius: 16, paddingHorizontal: 18 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 20 },
  tag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5, fontSize: 10 },
  task: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: StyleSheet.hairlineWidth },
  taskText: { fontSize: 13 },
})

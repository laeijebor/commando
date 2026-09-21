import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useTheme } from '../theme'
import { Card, ScreenTitle } from './primitives'

/**
 * A screen that exists so navigation is real, with the phase of the plan that
 * will fill it spelled out instead of filler copy.
 */
export function PlaceholderScreen({
  title,
  summary,
  planned,
  children,
}: {
  title: string
  summary: string
  planned: readonly string[]
  children?: ReactNode
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <ScreenTitle title={title} />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.summary, { color: theme.textSoft }]}>{summary}</Text>
        {children}
        <Card raised style={styles.card}>
          <Text style={[styles.plannedTitle, { color: theme.muted }]}>STILL TO BUILD</Text>
          {planned.map((item) => (
            <View key={item} style={styles.plannedRow}>
              <View style={[styles.bullet, { backgroundColor: theme.borderStrong }]} />
              <Text style={[styles.plannedItem, { color: theme.textSoft }]}>{item}</Text>
            </View>
          ))}
        </Card>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 40, gap: 12 },
  summary: { fontSize: 14, lineHeight: 20 },
  card: { gap: 8 },
  plannedTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  plannedRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  bullet: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  plannedItem: { fontSize: 13.5, lineHeight: 19, flex: 1 },
})

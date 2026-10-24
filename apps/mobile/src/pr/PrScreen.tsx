import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'

import { useAppActive } from '../daemon/useAppActive'
import { useHostsStore } from '../hosts/store'
import { usePanePrs } from '../pane/usePanePrs'
import { useTheme } from '../theme'
import { EmptyState } from '../ui/primitives'
import { PrView, type PrViewSource } from './PrView'

export function PrScreen({ hostId, repo, number, paneId, active, onClose }: {
  hostId?: string | undefined
  repo?: string | undefined
  number: number
  paneId?: string | undefined
  active: boolean
  onClose: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const foreground = useAppActive(active)
  // The pane's linked-PR list is cached and shared with the pane's tabs, so this is usually free.
  const linked = usePanePrs(host, paneId ? [paneId] : [], foreground)[0]?.data?.pullRequests
    .find((pr) => pr.number === number && pr.repo.toLowerCase() === repo?.toLowerCase())
  const source: PrViewSource | null = linked ?? (repo && Number.isSafeInteger(number) && number > 0 ? { repo, number } : null)
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={[styles.nav, { borderBottomColor: theme.border }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onClose} hitSlop={8} style={styles.back}>
          <Feather color={theme.accent} name="chevron-left" size={20} />
        </Pressable>
        <View style={styles.titles}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>{linked?.title ?? `Pull request #${number}`}</Text>
          <Text numberOfLines={1} style={[styles.subtitle, { color: theme.muted }]}>{repo ?? ''} · #{number}</Text>
        </View>
      </View>
      {host && source ? <PrView key={`${source.repo}#${source.number}`} host={host} source={source} active={foreground} /> : (
        <EmptyState title="That pull request is not available" body="Open it again from the pane's Info sheet." />
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { padding: 4 },
  titles: { flex: 1, minWidth: 0 },
  title: { fontSize: 16, fontWeight: '700' },
  subtitle: { fontSize: 12 },
})

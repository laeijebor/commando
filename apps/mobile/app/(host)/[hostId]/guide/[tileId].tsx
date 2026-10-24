import { useIsFocused, useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'

import { useAppActive } from '../../../../src/daemon/useAppActive'
import { useDaemonConnection } from '../../../../src/daemon/useDaemonConnection'
import { GuideView } from '../../../../src/guide/GuideView'
import { isGuideTile } from '../../../../src/guide/model'
import { useHostsStore } from '../../../../src/hosts/store'
import { useRouteParams } from '../../../../src/layout/routeParams'
import { useTheme } from '../../../../src/theme'
import { returnFromTile } from '../../../../src/tiles/returnToPane'
import { tileTitle } from '../../../../src/tiles/list'
import { EmptyState } from '../../../../src/ui/primitives'

/** A guide tab opened from the Tiles list: the same native view the pane's tab strip shows. */
export default function GuideScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId, tileId, fromPaneId } = useRouteParams<{ hostId: string; tileId: string; fromPaneId?: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const daemon = useDaemonConnection(host)
  const tile = daemon.webPanes.find((candidate) => candidate.id === tileId)
  const active = useAppActive(useIsFocused())
  const anchor = tile && daemon.snapshot?.panes.find((pane) => pane.id === tile.anchorPaneId)
  return (
    <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={[styles.nav, { borderBottomColor: theme.border }]}>
        <Pressable accessibilityLabel="Back" accessibilityRole="button" onPress={() => returnFromTile(router, hostId, fromPaneId)} style={styles.back}>
          <Feather name="chevron-left" size={25} color={theme.accent} />
        </Pressable>
        <View style={styles.navText}>
          <Text numberOfLines={1} style={[styles.name, { color: theme.text }]}>{tile ? tileTitle(tile) : 'Guide'}</Text>
          <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>Guide{anchor ? ` · beside ${anchor.title || anchor.command}` : ''}</Text>
        </View>
        <Feather name="book-open" size={18} color={theme.muted} />
      </View>
      {host && isGuideTile(tile)
        ? <GuideView key={`${tile.id}:${tile.content.artifactId}/${tile.content.file}`} active={active} host={host} tile={tile} />
        : <View style={styles.missing}><EmptyState title="This guide is closed" body="The agent closed the tab, or it was opened on another host." /></View>}
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
  missing: { flex: 1, justifyContent: 'center', padding: 24 },
})

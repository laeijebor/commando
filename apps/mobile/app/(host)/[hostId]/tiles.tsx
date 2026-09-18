import { useLocalSearchParams } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'

import { useDaemonConnection } from '../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../src/hosts/store'
import { useTheme } from '../../../src/theme'
import { Card } from '../../../src/ui/primitives'
import { PlaceholderScreen } from '../../../src/ui/Placeholder'

export default function TilesScreen(): React.JSX.Element {
  const theme = useTheme()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)

  return (
    <PlaceholderScreen
      planned={[
        'Chromium screencast frames over /ws/web-tiles/:id with phone viewport and DPR',
        'Touch to CDP mouse mapping from src/chromiumTileInput.ts',
        'Review mode: tap to annotate, pending strip, Send all and Send + Build',
        'Reopen-as-chromium prompt for webkit tiles',
      ]}
      summary="Browser tiles the daemon is rendering. The list below is live; the frames are a later phase."
      title="Tiles"
    >
      {state.webPanes.length ? (
        <View style={styles.list}>
          {state.webPanes.map((tile) => (
            <Card key={tile.id}>
              <Text numberOfLines={1} style={[styles.url, { color: theme.text }]}>{tile.url}</Text>
              <Text style={[styles.meta, { color: theme.muted }]}>
                {tile.engine} · opened by {tile.openedBy} · {tile.status}
              </Text>
            </Card>
          ))}
        </View>
      ) : (
        <Text style={[styles.meta, { color: theme.muted }]}>No tiles are open on this host.</Text>
      )}
    </PlaceholderScreen>
  )
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  url: { fontSize: 14, fontWeight: '600' },
  meta: { fontSize: 12.5 },
})

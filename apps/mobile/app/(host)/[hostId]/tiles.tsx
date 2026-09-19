import { useCallback, useMemo, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'

import type { WebPane } from '@commando/protocol'

import { useDaemonConnection } from '../../../src/daemon/useDaemonConnection'
import { useHostsStore } from '../../../src/hosts/store'
import { useTheme } from '../../../src/theme'
import { closeTile, confirmTile, openTile } from '../../../src/tiles/api'
import { buildTileRows, groupTileRows } from '../../../src/tiles/list'
import { OpenTileSheet, type OpenTileRequest } from '../../../src/tiles/OpenTileSheet'
import { TileListRow } from '../../../src/tiles/TileListRow'
import { EmptyState, ScreenTitle, SectionHeader } from '../../../src/ui/primitives'

export default function TilesScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetBusy, setSheetBusy] = useState(false)
  const [sheetError, setSheetError] = useState<string | null>(null)

  const rows = useMemo(
    () => buildTileRows({ webPanes: state.webPanes, feedback: state.feedback, snapshot: state.snapshot }),
    [state.webPanes, state.feedback, state.snapshot],
  )
  const groups = useMemo(() => groupTileRows(rows, state.snapshot), [rows, state.snapshot])

  const report = useCallback((title: string, error: unknown): void => {
    Alert.alert(title, error instanceof Error ? error.message : 'The daemon refused the request.')
  }, [])

  const runFor = useCallback(
    async (tileId: string, action: () => Promise<void>, failure: string): Promise<void> => {
      setBusyId(tileId)
      try {
        await action()
      } catch (error) {
        report(failure, error)
      } finally {
        setBusyId(null)
      }
    },
    [report],
  )

  const onConfirm = useCallback(
    (tile: WebPane, allowOrigin: boolean): void => {
      if (!host) return
      void Haptics.selectionAsync()
      void runFor(tile.id, () => confirmTile(host, tile.id, allowOrigin), 'Could not open the tile')
    },
    [host, runFor],
  )

  const onClose = useCallback(
    (tile: WebPane): void => {
      if (!host) return
      Alert.alert('Close this tile?', `${tile.url}`, [
        { style: 'cancel', text: 'Keep it' },
        {
          style: 'destructive',
          text: 'Close',
          onPress: () => {
            void runFor(tile.id, () => closeTile(host, tile.id), 'Could not close the tile')
          },
        },
      ])
    },
    [host, runFor],
  )

  /**
   * Decision 3: a webkit tile only exists inside the host's own WebView, so
   * the phone cannot render it. Reopening is a close and an open with the same
   * url, anchor and placement — the daemon has no engine-switch route.
   */
  const onReopenAsChromium = useCallback(
    (tile: WebPane): void => {
      if (!host) return
      Alert.alert(
        'Reopen as chromium?',
        'The webkit tile closes and comes back beside the same pane, rendered by the daemon so it can stream here.',
        [
          { style: 'cancel', text: 'Cancel' },
          {
            text: 'Reopen',
            onPress: () => {
              void runFor(
                tile.id,
                async () => {
                  await closeTile(host, tile.id)
                  await openTile(host, {
                    url: tile.url,
                    anchor: tile.anchorPaneId,
                    placement: tile.placement,
                    engine: 'chromium',
                  })
                },
                'Could not reopen the tile',
              )
            },
          },
        ],
      )
    },
    [host, runFor],
  )

  const onOpenTile = useCallback(
    async (request: OpenTileRequest): Promise<void> => {
      if (!host) return
      setSheetBusy(true)
      setSheetError(null)
      try {
        const result = await openTile(host, request)
        setSheetOpen(false)
        if (result.status === 'open') {
          router.push({
            pathname: '/(host)/[hostId]/tile/[tileId]',
            params: { hostId: host.id, tileId: result.webPaneId },
          })
        }
      } catch (error) {
        setSheetError(error instanceof Error ? error.message : 'The daemon refused the URL.')
      } finally {
        setSheetBusy(false)
      }
    },
    [host, router],
  )

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <ScreenTitle
        title="Tiles"
        trailing={
          <Pressable
            accessibilityLabel="Open a URL as a tile"
            accessibilityRole="button"
            disabled={!host}
            onPress={() => {
              setSheetError(null)
              setSheetOpen(true)
            }}
            style={[styles.add, { backgroundColor: theme.surfaceSoft, borderColor: theme.borderMid }]}
          >
            <Feather color={theme.accent} name="plus" size={18} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={styles.body}>
        {groups.length === 0 ? (
          <EmptyState
            body="Agents open them with the show-in-commando skill, or tap + to open a URL beside a pane."
            title="No tiles are open on this host"
          />
        ) : (
          groups.map((group) => (
            <View key={group.sessionId} style={styles.group}>
              <SectionHeader
                label={group.sessionName}
                note={group.rows.length === 1 ? '1 tile' : `${group.rows.length} tiles`}
              />
              {group.rows.map((row) => (
                <TileListRow
                  busy={busyId === row.tile.id}
                  key={row.tile.id}
                  onClose={() => onClose(row.tile)}
                  onConfirm={(allowOrigin) => onConfirm(row.tile, allowOrigin)}
                  onOpen={() => {
                    if (!host) return
                    router.push({
                      pathname: '/(host)/[hostId]/tile/[tileId]',
                      params: { hostId: host.id, tileId: row.tile.id },
                    })
                  }}
                  onReopenAsChromium={() => onReopenAsChromium(row.tile)}
                  row={row}
                />
              ))}
            </View>
          ))
        )}

        <Text style={[styles.hint, { color: theme.textDim }]}>
          Swipe a tile left, or long-press it, to close it on the host.
        </Text>
      </ScrollView>

      <OpenTileSheet
        busy={sheetBusy}
        error={sheetError}
        onCancel={() => setSheetOpen(false)}
        onSubmit={(request) => void onOpenTile(request)}
        snapshot={state.snapshot}
        visible={sheetOpen}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 40, gap: 16 },
  group: { gap: 8 },
  add: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: { fontSize: 12, lineHeight: 17, paddingHorizontal: 2 },
})

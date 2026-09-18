import { Redirect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router'
import { StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useHostsStore } from '../../../../src/hosts/store'
import { isCockpitMode, useLayoutMode } from '../../../../src/layout/useLayoutMode'
import { useTheme } from '../../../../src/theme'
import { PaneView } from '../../../../src/terminal/PaneView'

/**
 * Screen 03 on the phone. Everything it draws lives in `PaneView`, which the
 * iPad cockpit's centre column renders too.
 *
 * On a screen wide enough for columns this route is only a deep-link entry
 * point: it hands the pane to the cockpit as its focused pane rather than
 * covering the sessions list and the HUD with a full-screen terminal, which is
 * what a notification tap should do on an iPad.
 */
export default function PaneScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const focused = useIsFocused()
  const mode = useLayoutMode()
  const { hostId, paneId } = useLocalSearchParams<{ hostId: string; paneId: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))

  if (isCockpitMode(mode)) {
    return (
      <Redirect
        href={{
          pathname: '/(host)/[hostId]/sessions',
          params: { hostId: hostId ?? '', focus: paneId ?? '' },
        }}
      />
    )
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <PaneView
        active={focused}
        host={host}
        onBack={() => router.back()}
        onInfo={() => router.push({
          pathname: '/(host)/[hostId]/pane/[paneId]/info',
          params: { hostId: hostId ?? '', paneId: paneId ?? '' },
        })}
        onOpenTiles={() => router.push({
          pathname: '/(host)/[hostId]/tiles',
          params: { hostId: hostId ?? '' },
        })}
        onSelectWindow={(chip) => {
          if (!chip.targetPaneId || chip.targetPaneId === paneId) return
          router.replace({
            pathname: '/(host)/[hostId]/pane/[paneId]',
            params: { hostId: hostId ?? '', paneId: chip.targetPaneId },
          })
        }}
        paneId={paneId}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
})

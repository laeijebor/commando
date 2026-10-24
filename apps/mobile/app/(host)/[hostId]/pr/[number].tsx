import { useIsFocused, useRouter } from 'expo-router'

import { routeParams, useRouteParams } from '../../../../src/layout/routeParams'
import { isCockpitMode, useLayoutMode } from '../../../../src/layout/useLayoutMode'
import { PrScreen } from '../../../../src/pr/PrScreen'

/**
 * A pull request, full screen: pushed from a PR row in the Info sheet (or the
 * iPad HUD). `repo` names the repository and `paneId`, when present, the pane
 * whose linked-PR list supplies the PR's summary.
 */
export default function PullRequestRoute(): React.JSX.Element {
  const router = useRouter()
  const focused = useIsFocused()
  const cockpit = isCockpitMode(useLayoutMode())
  const { hostId, number, repo, paneId } = useRouteParams<{ hostId: string; number: string; repo?: string; paneId?: string }>()
  const close = (): void => {
    // The host tabs navigator goes "back" to its first tab, so on a phone return to the pane's Info sheet explicitly.
    if (paneId && hostId && !cockpit) router.navigate({ pathname: '/(host)/[hostId]/pane/[paneId]/info', params: routeParams({ hostId, paneId }) })
    else if (router.canGoBack()) router.back()
    else router.replace({ pathname: '/(host)/[hostId]/sessions', params: { hostId: hostId ?? '' } })
  }
  return <PrScreen hostId={hostId} repo={repo} number={Number(number)} paneId={paneId} active={focused} onClose={close} />
}

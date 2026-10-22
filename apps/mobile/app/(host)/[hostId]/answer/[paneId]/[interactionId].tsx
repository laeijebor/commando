import { Redirect } from 'expo-router'
import { routeParams, useRouteParams } from '../../../../../src/layout/routeParams'

import { isCockpitMode, useLayoutMode } from '../../../../../src/layout/useLayoutMode'
import { AnswerScreen } from '../../../../../src/ui/AnswerScreen'

/**
 * Screen 04 on the phone. On an iPad the same request is answered in the
 * cockpit's HUD column, so the deep link focuses the pane there instead of
 * covering the terminal with a full-screen answer.
 */
export default function AnswerRoute(): React.JSX.Element {
  const mode = useLayoutMode()
  const { hostId, paneId } = useRouteParams<{ hostId: string; paneId: string }>()

  if (isCockpitMode(mode)) {
    return (
      <Redirect
        href={{
          pathname: '/(host)/[hostId]/sessions',
          params: routeParams({ hostId: hostId ?? '', focus: paneId ?? '' }),
        }}
      />
    )
  }

  return <AnswerScreen />
}

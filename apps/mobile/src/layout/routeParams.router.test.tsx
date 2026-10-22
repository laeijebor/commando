import { Text } from 'react-native'
import { act, renderRouter, screen } from 'expo-router/testing-library'
import { router, useLocalSearchParams } from 'expo-router'

import { routeParams, useRouteParams } from './routeParams'

function Pane(): React.JSX.Element {
  const raw = useLocalSearchParams<{ paneId: string }>().paneId
  const read = useRouteParams<{ paneId: string }>().paneId
  return <Text testID="pane">{JSON.stringify({ raw, read })}</Text>
}

const pane = (): { raw: string; read: string } => JSON.parse(screen.getByTestId('pane').props.children)

it('garbles a raw tmux pane id and keeps a routeParams one', () => {
  renderRouter({ index: () => null, '(host)/[hostId]/pane/[paneId]': Pane }, { initialUrl: '/' })
  act(() => router.push({ pathname: '/(host)/[hostId]/pane/[paneId]', params: { hostId: 'h', paneId: '%139' } }))
  expect(pane().raw).not.toBe('%139')
  act(() => router.push({ pathname: '/(host)/[hostId]/pane/[paneId]', params: routeParams({ hostId: 'h', paneId: '%122' }) }))
  expect(pane().read).toBe('%122')
})

import { Text } from 'react-native'
import { act, renderRouter, screen } from 'expo-router/testing-library'
import { router, useLocalSearchParams } from 'expo-router'

import { routeParams, useRouteParams } from './routeParams'

function Raw(): React.JSX.Element {
  const { paneId } = useLocalSearchParams<{ paneId: string }>()
  return <Text testID="raw">{JSON.stringify(paneId)}</Text>
}
function Fixed(): React.JSX.Element {
  const { paneId } = useRouteParams<{ paneId: string }>()
  return <Text testID="fixed">{JSON.stringify(paneId)}</Text>
}

it('garbles a raw tmux pane id and keeps a routeParams one', () => {
  renderRouter({ index: () => null, 'raw/[paneId]': Raw, 'fixed/[paneId]': Fixed }, { initialUrl: '/' })
  act(() => router.push({ pathname: '/raw/[paneId]', params: { paneId: '%139' } }))
  expect(screen.getByTestId('raw').props.children).not.toBe('"%139"')
  act(() => router.push({ pathname: '/fixed/[paneId]', params: routeParams({ paneId: '%139' }) }))
  expect(screen.getByTestId('fixed').props.children).toBe('"%139"')
})

import { act, render, screen } from '@testing-library/react-native'
import TilesScreen from '../../app/(host)/[hostId]/tiles'
import { disconnectHost } from '../daemon/client'
import { useDaemonStore } from '../daemon/store'
import { demoHost } from '../demo/flags'
import { useHostsStore } from '../hosts/store'
import { ThemeProvider } from '../theme'
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({}), useRouter: () => ({ push: mockPush }) }))
afterEach(() => disconnectHost(demoHost().id))
it('shows the same seeded browser/native tabs when the tab route omits the parent host param', async () => {
  const host = demoHost()
  useDaemonStore.setState({ byHost: {} })
  useHostsStore.setState({ hosts: [host], hydrated: true, selectedHostId: host.id })
  render(<ThemeProvider><TilesScreen /></ThemeProvider>)
  await act(async () => undefined)
  expect(screen.queryByText('No tiles are open on this host')).toBeNull()
  for (const title of ['Companion preview', 'iPhone preview', 'Layout study', 'Review checklist']) expect(screen.getByText(title)).toBeTruthy()
  expect(useDaemonStore.getState().byHost[host.id]!.webPanes).toHaveLength(4)
})

import * as SecureStore from 'expo-secure-store'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import HostsScreen from '../../app/index'
import { useHostsStore, SELECTED_HOST_KEY } from './store'
import { HOSTS_STORAGE_KEY, saveHosts } from './storage'
import { demoHost } from '../demo/flags'
import { ThemeProvider } from '../theme'
const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() }
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, Link: ({ children }: { children: React.ReactNode }) => children }))
const real = { id: 'real', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'session' as const } }
const originalFlag = process.env.EXPO_PUBLIC_COMMANDO_DEMO
beforeEach(async () => {
  process.env.EXPO_PUBLIC_COMMANDO_DEMO = '1'
  await SecureStore.deleteItemAsync(HOSTS_STORAGE_KEY)
  await SecureStore.deleteItemAsync(SELECTED_HOST_KEY)
  useHostsStore.setState({ hosts: [], hydrated: false, selectedHostId: null, initialHostId: null, reachability: {}, cookies: {} })
  jest.clearAllMocks()
})
afterEach(() => {
  if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_COMMANDO_DEMO
  else process.env.EXPO_PUBLIC_COMMANDO_DEMO = originalFlag
})
it('auto-selects demo once on an empty first launch, then keeps Hosts and Add host reachable', async () => {
  await useHostsStore.getState().hydrate()
  const view = render(<ThemeProvider><HostsScreen /></ThemeProvider>)
  await act(async () => undefined)
  expect(mockRouter.replace).toHaveBeenCalledTimes(1)
  expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/(host)/[hostId]/sessions', params: { hostId: demoHost().id } })
  view.unmount()
  await act(async () => useHostsStore.getState().rememberHost(null))
  render(<ThemeProvider><HostsScreen /></ThemeProvider>)
  await act(async () => undefined)
  expect(mockRouter.replace).toHaveBeenCalledTimes(1)
  fireEvent.press(screen.getByText('Add host'))
  expect(screen.getByLabelText('Host address')).toBeTruthy()
  // A later process launch preserves the decision to return to Hosts.
  await act(async () => {
    useHostsStore.setState({ hydrated: false })
    await useHostsStore.getState().hydrate()
  })
  expect(useHostsStore.getState().initialHostId).toBeNull()
})
it('never auto-selects demo over an existing real host or remembered selection', async () => {
  await saveHosts([real])
  await useHostsStore.getState().hydrate()
  expect(useHostsStore.getState().initialHostId).toBeNull()
  expect(useHostsStore.getState().hosts.some((host) => host.id === real.id)).toBe(true)
  await SecureStore.deleteItemAsync(HOSTS_STORAGE_KEY)
  await SecureStore.setItemAsync(SELECTED_HOST_KEY, 'hosts')
  useHostsStore.setState({ hydrated: false })
  await useHostsStore.getState().hydrate()
  expect(useHostsStore.getState().initialHostId).toBeNull()
})

it('offers a scanner action for a revoked token host', async () => {
  useHostsStore.setState({ hosts: [{ ...real, auth: { kind: 'token', token: 'revoked' } }], hydrated: true, reachability: { real: { state: 'unauthorized', message: 'Access revoked — scan a new code' } } })
  render(<ThemeProvider><HostsScreen /></ThemeProvider>)
  await act(async () => undefined)
  expect(screen.getByText('Access revoked — scan a new code')).toBeTruthy()
  fireEvent.press(screen.getByText('Re-pair'))
  expect(mockRouter.push).toHaveBeenCalledWith('/pair')
})

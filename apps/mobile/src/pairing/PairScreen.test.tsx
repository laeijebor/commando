import * as SecureStore from 'expo-secure-store'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import PairScreen from '../../app/pair'
import { useHostsStore } from '../hosts/store'
import { HOSTS_STORAGE_KEY } from '../hosts/storage'
import { ThemeProvider } from '../theme'
import { claimPairing } from './client'

const mockRouter = { replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) }
let mockParams: Record<string, string | string[]> = {}
let mockPermission = { granted: true, canAskAgain: true, status: 'granted' }
const mockRequestPermission = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams }))
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [mockPermission, mockRequestPermission],
  CameraView: (props: Record<string, unknown>) => { const { View } = require('react-native'); return <View testID="camera" {...props} /> },
}))
jest.mock('./client', () => ({ ...jest.requireActual('./client'), claimPairing: jest.fn() }))
const params = { v: '1', c: 'a'.repeat(32), u: ['http://studio.tail.ts.net:4310', 'http://100.64.0.1:4310'], n: 'Studio Mac' }
const result = { deviceId: 'device', token: 't'.repeat(43), name: 'Studio Mac', baseUrl: 'http://100.64.0.1:4310' }
beforeEach(async () => {
  jest.clearAllMocks()
  mockParams = {}
  mockPermission = { granted: true, canAskAgain: true, status: 'granted' }
  delete process.env.EXPO_PUBLIC_COMMANDO_DEMO
  await SecureStore.deleteItemAsync(HOSTS_STORAGE_KEY)
  useHostsStore.setState({ hosts: [], hydrated: true, selectedHostId: null, initialHostId: null, reachability: {}, cookies: {} })
  ;(claimPairing as jest.Mock).mockResolvedValue(result)
})
const open = () => render(<ThemeProvider><PairScreen /></ThemeProvider>)
it('opens deep links into confirmation, claims only after confirmation, persists token, selects host and opens Chats', async () => {
  mockParams = params
  open()
  expect(screen.getByText('Pair with Studio Mac?')).toBeTruthy()
  expect(claimPairing).not.toHaveBeenCalled()
  await act(async () => fireEvent.press(screen.getByText('Pair')))
  expect(claimPairing).toHaveBeenCalledTimes(1)
  const host = useHostsStore.getState().hosts[0]
  expect(host).toMatchObject({ name: result.name, baseUrl: result.baseUrl, auth: { kind: 'token', token: result.token } })
  expect(JSON.parse(await SecureStore.getItemAsync(HOSTS_STORAGE_KEY) ?? '[]')).toEqual([host])
  expect(useHostsStore.getState().selectedHostId).toBe(host?.id)
  expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/(host)/[hostId]/sessions', params: { hostId: host?.id } })
})
it('locks repeated scans and shows confirmation before claiming', async () => {
  open()
  const url = new URL('commando://pair')
  for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item)
  const camera = screen.getByTestId('camera')
  fireEvent(camera, 'barcodeScanned', { data: url.toString() })
  expect(screen.getByText('Pair with Studio Mac?')).toBeTruthy()
  expect(claimPairing).not.toHaveBeenCalled()
  await act(async () => fireEvent.press(screen.getByText('Pair')))
  expect(claimPairing).toHaveBeenCalledTimes(1)
})
it('offers Settings after camera permission was denied', () => {
  mockPermission = { granted: false, canAskAgain: false, status: 'denied' }
  open()
  expect(screen.getByText('Open Settings')).toBeTruthy()
  expect(screen.queryByTestId('camera')).toBeNull()
})
it('keeps errors visible without saving a host or navigating', async () => {
  mockParams = params
  ;(claimPairing as jest.Mock).mockRejectedValue(new Error('Ask your Mac for a new code'))
  open()
  await act(async () => fireEvent.press(screen.getByText('Pair')))
  expect(screen.getByText('Ask your Mac for a new code')).toBeTruthy()
  expect(useHostsStore.getState().hosts).toHaveLength(0)
  expect(mockRouter.replace).not.toHaveBeenCalled()
})
it('reports secure-storage failures instead of treating an ephemeral token as paired', async () => {
  mockParams = params
  ;(SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error('Keychain unavailable'))
  open()
  await act(async () => fireEvent.press(screen.getByText('Pair')))
  expect(screen.getByText(/Could not save this phone’s token securely/)).toBeTruthy()
  expect(useHostsStore.getState().hosts).toHaveLength(0)
  expect(mockRouter.replace).not.toHaveBeenCalled()
})

it('clears the previous attempted destination when another deep link arrives', async () => {
  mockParams = params
  ;(claimPairing as jest.Mock).mockImplementation(async (_link, _name, _platform, trying) => { trying('http://old-mac:4310'); throw new Error('unreachable') })
  const view = open()
  await act(async () => fireEvent.press(screen.getByText('Pair')))
  expect(screen.getByText('Connect using http://old-mac:4310')).toBeTruthy()
  mockParams = { ...params, c: 'b'.repeat(32), u: ['http://new-mac:4310'], n: 'New Mac' }
  view.rerender(<ThemeProvider><PairScreen /></ThemeProvider>)
  expect(screen.getByText('Pair with New Mac?')).toBeTruthy()
  expect(screen.getByText('Connect using http://new-mac:4310')).toBeTruthy()
  expect(screen.queryByText(/old-mac/)).toBeNull()
})
it('lets Cancel abort pairing while a response body is stalled', async () => {
  mockParams = params
  let signal: AbortSignal | undefined
  ;(claimPairing as jest.Mock).mockImplementation((_link, _name, _platform, _trying, requestSignal) => { signal = requestSignal; return new Promise(() => undefined) })
  open()
  await act(async () => fireEvent.press(screen.getByText('Pair')))
  expect(signal?.aborted).toBe(false)
  fireEvent.press(screen.getByText('Cancel'))
  expect(signal?.aborted).toBe(true)
  expect(mockRouter.back).toHaveBeenCalled()
})

it('re-pairs into the existing host id and opens its existing Chats route', async () => {
  mockParams = params
  const existing = { id: 'existing-mac', name: 'Work Mac', baseUrl: params.u[0]!, auth: { kind: 'token' as const, token: 'old-token' } }
  useHostsStore.setState({ hosts: [existing], selectedHostId: existing.id })
  open()
  await act(async () => fireEvent.press(screen.getByText('Pair')))
  expect(useHostsStore.getState().hosts).toHaveLength(1)
  expect(useHostsStore.getState().hosts[0]).toMatchObject({ id: existing.id, name: existing.name, baseUrl: result.baseUrl, auth: { kind: 'token', token: result.token } })
  expect(useHostsStore.getState().selectedHostId).toBe(existing.id)
  expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/(host)/[hostId]/sessions', params: { hostId: existing.id } })
})

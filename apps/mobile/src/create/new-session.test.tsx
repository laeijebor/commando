import type { CreateTmuxSessionRequest } from '@commando/tmux-create'
import { TmuxAgentLaunchCompatibilityError } from '@commando/tmux-create'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import NewSessionScreen from '../../app/(host)/[hostId]/new-session'
import { useHostsStore } from '../hosts/store'
import { ThemeProvider } from '../theme'
import { createTmuxSession, runInPane } from '../daemon/paneApi'
import { rememberDirectory } from './prefs'

const mockRouter = { replace: jest.fn(), back: jest.fn() }
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ hostId: 'host-1' }), useRouter: () => mockRouter }))
jest.mock('../daemon/useDaemonConnection', () => ({ useDaemonConnection: () => ({ snapshot: null }) }))
jest.mock('../daemon/paneApi', () => ({ createTmuxSession: jest.fn(), fetchRepoInfo: jest.fn(async () => ({ isRepo: false })), runInPane: jest.fn() }))
jest.mock('./prefs', () => ({ loadDirectoryHistory: async () => [], loadPrepareCommands: async () => ({}), rememberDirectory: jest.fn(async () => []), rememberPrepareCommand: jest.fn() }))
jest.mock('../notifications', () => ({ usePushStore: { getState: () => ({ rules: { mutedSessions: [] } }) }, toggleMutedSession: jest.fn() }))

const created = { kind: 'session', sessionId: '$1', sessionName: 'cursor', windowId: '@1', windowIndex: 0, windowName: 'agent', paneId: '%7', paneIndex: 0, panePath: '/tmp' }

beforeEach(() => {
  jest.clearAllMocks()
  ;(createTmuxSession as jest.Mock).mockImplementation(async (_host: unknown, input: CreateTmuxSessionRequest) => ({ created, ...(input.agent ? { agentLaunch: { version: 1, provider: input.agent.provider, paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } } : {}) }))
  ;(rememberDirectory as jest.Mock).mockResolvedValue([])
  useHostsStore.setState({ hosts: [{ id: 'host-1', name: 'studio', baseUrl: 'http://localhost:4310', auth: { kind: 'token', token: 'fixture' } }], hydrated: true })
})

async function openScreen() {
  render(<ThemeProvider><NewSessionScreen /></ThemeProvider>)
  await act(async () => undefined)
  fireEvent.changeText(screen.getByLabelText('Name'), 'cursor')
}

it('defaults to Claude and creates Cursor with one interactive request, navigating to its reported pane', async () => {
  await openScreen()
  expect(screen.getByRole('radio', { name: 'Claude' }).props.accessibilityState.checked).toBe(true)
  fireEvent.press(screen.getByRole('radio', { name: 'Cursor' }))
  const prompt = "Leo's spec\n$HOME `whoami`"
  fireEvent.changeText(screen.getByLabelText('Opening prompt'), prompt)
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Create' })) })
  expect(createTmuxSession).toHaveBeenCalledTimes(1)
  expect(createTmuxSession).toHaveBeenCalledWith(expect.any(Object), { name: 'cursor', agent: { provider: 'cursor', prompt } })
  expect(runInPane).not.toHaveBeenCalled()
  expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/(host)/[hostId]/pane/[paneId]', params: { hostId: 'host-1', paneId: '%7' } })
})

it('keeps the form and shows creation errors without detached launch or navigation', async () => {
  ;(createTmuxSession as jest.Mock).mockRejectedValue(new Error('Cannot start agent: executable not found'))
  await openScreen()
  fireEvent.press(screen.getByRole('radio', { name: 'Cursor' }))
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Create' })) })
  expect(screen.getByText('Cannot start agent: executable not found')).toBeTruthy()
  expect(runInPane).not.toHaveBeenCalled()
  expect(mockRouter.replace).not.toHaveBeenCalled()
})

it('offers the already created pane after a preferences error without creating twice', async () => {
  ;(rememberDirectory as jest.Mock).mockRejectedValue(new Error('Storage unavailable'))
  await openScreen()
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Create' })) })
  expect(screen.getByText(/Session cursor was created, but preferences could not be saved/)).toBeTruthy()
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Open session' })) })
  expect(createTmuxSession).toHaveBeenCalledTimes(1)
  expect(mockRouter.replace).toHaveBeenCalledWith(expect.objectContaining({ params: { hostId: 'host-1', paneId: '%7' } }))
})

it.each(['old-host', 'wrong-provider', 'api-error'])('preserves and opens the created target after %s without silently claiming launch or creating twice', async (scenario) => {
  if (scenario === 'old-host') (createTmuxSession as jest.Mock).mockResolvedValue({ created })
  else if (scenario === 'api-error') (createTmuxSession as jest.Mock).mockRejectedValue(new TmuxAgentLaunchCompatibilityError({ created: { ...created, kind: 'session' } }, 'cursor'))
  else (createTmuxSession as jest.Mock).mockResolvedValue({ created, agentLaunch: { version: 1, provider: 'claude', paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } })
  await openScreen()
  fireEvent.press(screen.getByRole('radio', { name: 'Cursor' }))
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Create' })) })
  expect(screen.getByText(/daemon did not confirm the requested Cursor interactive launch/)).toBeTruthy()
  expect(mockRouter.replace).not.toHaveBeenCalled()
  expect(rememberDirectory).not.toHaveBeenCalled()
  expect(runInPane).not.toHaveBeenCalled()
  fireEvent.changeText(screen.getByLabelText('Name'), '')
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Open session' })) })
  expect(createTmuxSession).toHaveBeenCalledTimes(1)
  expect(mockRouter.replace).toHaveBeenCalledWith(expect.objectContaining({ params: { hostId: 'host-1', paneId: '%7' } }))
})

import { ActionSheetIOS } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import type { CreateTmuxSessionRequest, ModelCatalogs } from '@commando/tmux-create'
import { TmuxAgentLaunchCompatibilityError } from '@commando/tmux-create'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import NewSessionScreen from '../../app/(host)/[hostId]/new-session'
import { useHostsStore } from '../hosts/store'
import { ThemeProvider } from '../theme'
import { createTmuxSession, fetchClaudeProfiles, fetchModelCatalogs, fetchRepoInfo, runInPane } from '../daemon/paneApi'
import { LAUNCH_KEY, rememberDirectory } from './prefs'

const mockRouter = { replace: jest.fn(), back: jest.fn() }
let mockParams: Record<string, string> = { hostId: 'host-1' }
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams, useRouter: () => mockRouter, useIsFocused: () => true }))
jest.mock('../daemon/useDaemonConnection', () => ({ useDaemonConnection: () => ({ snapshot: null }) }))
jest.mock('../daemon/paneApi', () => ({ createTmuxSession: jest.fn(), fetchClaudeProfiles: jest.fn(async () => []), fetchModelCatalogs: jest.fn(async () => ({})), fetchRepoInfo: jest.fn(async () => ({ isRepo: false })), runInPane: jest.fn() }))
jest.mock('./prefs', () => ({
  ...jest.requireActual('./prefs'),
  loadDirectoryHistory: async () => [],
  loadPrepareCommands: async () => ({}),
  rememberDirectory: jest.fn(async () => []),
  rememberPrepareCommand: jest.fn(),
}))
jest.mock('../notifications', () => ({ usePushStore: { getState: () => ({ rules: { mutedSessions: [] } }) }, toggleMutedSession: jest.fn() }))
jest.mock('../chat/clipboard', () => ({ ...jest.requireActual('../chat/clipboard'), useClipboardImage: () => ({ available: false, recheck: jest.fn(), dismiss: jest.fn() }) }))
const mockImageRef = { id: `${'e'.repeat(64)}.png`, name: 'shot.png' }
jest.mock('../chat/images', () => ({
  ...jest.requireActual('../chat/images'),
  pickImages: jest.fn(async () => [{ uri: 'file:///shot.png', name: 'shot.png', type: 'image/png', width: 800, height: 600, size: 1000 }]),
  prepareImage: jest.fn(async (image: { uri: string; name: string; type: string }) => ({ ok: true, image })),
  uploadChatImage: jest.fn(async () => mockImageRef),
}))

const created = { kind: 'session', sessionId: '$1', sessionName: 'cursor', windowId: '@1', windowIndex: 0, windowName: 'agent', paneId: '%7', paneIndex: 0, panePath: '/tmp' }
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store

beforeEach(() => {
  jest.clearAllMocks()
  jest.restoreAllMocks()
  store.clear()
  mockParams = { hostId: 'host-1' }
  ;(createTmuxSession as jest.Mock).mockImplementation(async (_host: unknown, input: CreateTmuxSessionRequest) => ({ created, ...(input.agent ? { agentLaunch: { version: 1, provider: input.agent.provider, paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } } : {}) }))
  ;(rememberDirectory as jest.Mock).mockResolvedValue([])
  ;(fetchClaudeProfiles as jest.Mock).mockResolvedValue([])
  ;(fetchModelCatalogs as jest.Mock).mockResolvedValue({})
  ;(fetchRepoInfo as jest.Mock).mockResolvedValue({ isRepo: false })
  useHostsStore.setState({ hosts: [{ id: 'host-1', name: 'studio', baseUrl: 'http://localhost:4310', auth: { kind: 'token', token: 'fixture' } }], hydrated: true })
})

/** Answers the next action sheets with the option labelled `label` (a ✓ marks the current one). */
function answerSheets(...labels: string[]): jest.SpyInstance {
  const queue = [...labels]
  return jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
    const label = queue.shift()
    const index = options.options.findIndex((option) => option.replace(/^✓ /u, '') === label)
    callback(index === -1 ? options.cancelButtonIndex ?? options.options.length - 1 : index)
  })
}

async function openScreen(name = 'cursor') {
  render(<ThemeProvider><NewSessionScreen /></ThemeProvider>)
  await act(async () => undefined)
  fireEvent.changeText(screen.getByLabelText('Name'), name)
}

async function create() {
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Create' })) })
}

function lastRequest(): CreateTmuxSessionRequest {
  return (createTmuxSession as jest.Mock).mock.calls.at(-1)[1] as CreateTmuxSessionRequest
}

it('defaults to Claude chat and creates Cursor with one interactive request, navigating to its reported pane', async () => {
  await openScreen()
  expect(screen.getByRole('radio', { name: 'Claude chat' }).props.accessibilityState.checked).toBe(true)
  fireEvent.press(screen.getByRole('radio', { name: 'Cursor' }))
  const prompt = "Leo's spec\n$HOME `whoami`"
  fireEvent.changeText(screen.getByLabelText('Opening prompt'), prompt)
  await create()
  expect(createTmuxSession).toHaveBeenCalledTimes(1)
  expect(createTmuxSession).toHaveBeenCalledWith(expect.any(Object), { name: 'cursor', agent: { provider: 'cursor', prompt } })
  expect(runInPane).not.toHaveBeenCalled()
  expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/(host)/[hostId]/pane/[paneId]', params: { hostId: 'host-1', paneId: '~7' } })
})

it('resets the form after a create, so the next visit is not stuck on a spinner', async () => {
  await openScreen()
  fireEvent.changeText(screen.getByLabelText('Opening prompt'), 'Do the thing')
  await create()
  expect(mockRouter.replace).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('Name').props.value).toBe('')
  expect(screen.getByLabelText('Opening prompt').props.value).toBe('')
  // Ready again once a name is typed: no spinner, no "Open session" left over.
  fireEvent.changeText(screen.getByLabelText('Name'), 'next')
  expect(screen.getByRole('button', { name: 'Create' }).props.accessibilityState.disabled).toBe(false)
})

it('keeps the form and shows creation errors without detached launch or navigation', async () => {
  ;(createTmuxSession as jest.Mock).mockRejectedValue(new Error('Cannot start agent: executable not found'))
  await openScreen()
  fireEvent.press(screen.getByRole('radio', { name: 'Cursor' }))
  await create()
  expect(screen.getByText('Cannot start agent: executable not found')).toBeTruthy()
  expect(runInPane).not.toHaveBeenCalled()
  expect(mockRouter.replace).not.toHaveBeenCalled()
})

it('offers the already created pane after a preferences error without creating twice', async () => {
  ;(rememberDirectory as jest.Mock).mockRejectedValue(new Error('Storage unavailable'))
  await openScreen()
  await create()
  expect(screen.getByText(/Session cursor was created, but preferences could not be saved/)).toBeTruthy()
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Open session' })) })
  expect(createTmuxSession).toHaveBeenCalledTimes(1)
  expect(mockRouter.replace).toHaveBeenCalledWith(expect.objectContaining({ params: { hostId: 'host-1', paneId: '~7' } }))
})

it.each(['old-host', 'wrong-provider', 'api-error'])('preserves and opens the created target after %s without silently claiming launch or creating twice', async (scenario) => {
  if (scenario === 'old-host') (createTmuxSession as jest.Mock).mockResolvedValue({ created })
  else if (scenario === 'api-error') (createTmuxSession as jest.Mock).mockRejectedValue(new TmuxAgentLaunchCompatibilityError({ created: { ...created, kind: 'session' } }, 'cursor'))
  else (createTmuxSession as jest.Mock).mockResolvedValue({ created, agentLaunch: { version: 1, provider: 'claude', paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' } })
  await openScreen()
  fireEvent.press(screen.getByRole('radio', { name: 'Cursor' }))
  await create()
  expect(screen.getByText(/daemon did not confirm the requested Cursor interactive launch/)).toBeTruthy()
  expect(mockRouter.replace).not.toHaveBeenCalled()
  expect(rememberDirectory).not.toHaveBeenCalled()
  expect(runInPane).not.toHaveBeenCalled()
  fireEvent.changeText(screen.getByLabelText('Name'), '')
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Open session' })) })
  expect(createTmuxSession).toHaveBeenCalledTimes(1)
  expect(mockRouter.replace).toHaveBeenCalledWith(expect.objectContaining({ params: { hostId: 'host-1', paneId: '~7' } }))
})

it.each([
  ['Claude chat', 'claude-chat', 'Accept edits', { permissionMode: 'acceptEdits' }],
  ['Codex chat', 'codex-chat', 'Read only', { permissionMode: 'plan' }],
  ['Muse chat', 'muse-chat', 'Full access (--yolo)', { permissionMode: 'bypassPermissions', fullAccess: true }],
])('creates %s with the permission picked from its pill', async (label, provider, modeLabel, permission) => {
  await openScreen()
  fireEvent.press(screen.getByRole('radio', { name: label }))
  answerSheets(modeLabel)
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: /^Permissions:/u })) })
  expect(screen.getByRole('button', { name: `Permissions: ${modeLabel}` })).toBeTruthy()
  fireEvent.changeText(screen.getByLabelText('Opening prompt'), 'Hello from the phone')
  await create()
  expect(createTmuxSession).toHaveBeenCalledWith(expect.any(Object), { name: 'cursor', agent: { provider, ...permission, prompt: 'Hello from the phone' } })
})

it('keeps each chat provider’s permission and hides the pill for CLI agents', async () => {
  await openScreen()
  answerSheets('Plan mode')
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: /^Permissions:/u })) })
  fireEvent.press(screen.getByRole('radio', { name: 'Muse chat' }))
  expect(screen.getByRole('button', { name: 'Permissions: Ask when needed' })).toBeTruthy()
  fireEvent.press(screen.getByRole('radio', { name: 'Cursor chat' }))
  expect(screen.getByRole('button', { name: 'Permissions: Full access' })).toBeTruthy()
  fireEvent.press(screen.getByRole('radio', { name: 'Claude chat' }))
  expect(screen.getByRole('button', { name: 'Permissions: Plan mode' })).toBeTruthy()
  fireEvent.press(screen.getByRole('radio', { name: 'Cursor' }))
  expect(screen.queryByRole('button', { name: /^Permissions:/u })).toBeNull()
})

const PROFILES = [
  { name: '', configDir: '/Users/me/.claude', lastUsedAt: 30 },
  { name: 'p', configDir: '/Users/me/.claudep', lastUsedAt: 10, label: 'Personal', isDefault: true },
  { name: 'w', configDir: '/Users/me/.claudew', lastUsedAt: 20 },
]

it('starts a Claude chat with the default profile, or the one picked', async () => {
  ;(fetchClaudeProfiles as jest.Mock).mockResolvedValue(PROFILES)
  await openScreen()
  expect(screen.getByRole('button', { name: 'Profile: Personal' })).toBeTruthy()
  await create()
  expect(lastRequest()).toEqual({ name: 'cursor', agent: { provider: 'claude-chat', permissionMode: 'default', configDir: '/Users/me/.claudep' } })
})

it('sends the profile picked instead of the default, for a Claude terminal too', async () => {
  ;(fetchClaudeProfiles as jest.Mock).mockResolvedValue(PROFILES)
  await openScreen()
  fireEvent.press(screen.getByRole('radio', { name: 'Claude (terminal)' }))
  answerSheets('w')
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Profile: Personal' })) })
  await create()
  expect(lastRequest().agent).toEqual({ provider: 'claude', configDir: '/Users/me/.claudew' })
})

it('offers no profile picker for other agents, or with a single profile', async () => {
  ;(fetchClaudeProfiles as jest.Mock).mockResolvedValue(PROFILES)
  await openScreen()
  fireEvent.press(screen.getByRole('radio', { name: 'Codex chat' }))
  expect(screen.queryByRole('button', { name: /^Profile:/u })).toBeNull()
  await create()
  expect(lastRequest().agent).not.toHaveProperty('configDir')
})

const CATALOGS: ModelCatalogs = {
  'claude:/Users/me/.claudep': {
    updatedAt: 5,
    models: [
      { value: 'default', displayName: 'Default (recommended)' },
      { value: 'opus', displayName: 'Opus', supportsFast: true },
      { value: 'haiku', displayName: 'Haiku' },
    ],
  },
}

it('starts on the picked model, in fast mode when the model offers it', async () => {
  ;(fetchClaudeProfiles as jest.Mock).mockResolvedValue(PROFILES)
  ;(fetchModelCatalogs as jest.Mock).mockResolvedValue(CATALOGS)
  await openScreen()
  expect(screen.getByRole('button', { name: 'Model: Default model' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Fast mode/u })).toBeNull()
  answerSheets('Opus')
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Model: Default model' })) })
  fireEvent.press(screen.getByRole('button', { name: 'Fast mode: Fast off' }))
  expect(screen.getByRole('button', { name: 'Fast mode: ⚡ Fast' }).props.accessibilityState.checked).toBe(true)
  await create()
  expect(lastRequest().agent).toEqual({ provider: 'claude-chat', permissionMode: 'default', configDir: '/Users/me/.claudep', model: 'opus', fast: true })
})

it('remembers how the last session started and uses it next time', async () => {
  ;(fetchClaudeProfiles as jest.Mock).mockResolvedValue(PROFILES)
  ;(fetchModelCatalogs as jest.Mock).mockResolvedValue(CATALOGS)
  await openScreen()
  answerSheets('Opus', 'Accept edits', 'w')
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Model: Default model' })) })
  fireEvent.press(screen.getByRole('button', { name: 'Fast mode: Fast off' }))
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: /^Permissions:/u })) })
  await create()
  const saved = JSON.parse(store.get(LAUNCH_KEY) ?? '{}') as Record<string, unknown>
  expect(saved['*']).toEqual({ startWith: 'claude-chat', permissions: { 'claude-chat': 'acceptEdits' }, configDir: '/Users/me/.claudep', models: { 'claude:/Users/me/.claudep': 'opus' }, fast: true })

  screen.unmount()
  await openScreen('again')
  expect(screen.getByRole('button', { name: 'Model: Opus' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Fast mode: ⚡ Fast' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Permissions: Accept edits' })).toBeTruthy()
})

it('starts with what the repository last used, ahead of the last session anywhere', async () => {
  store.set(LAUNCH_KEY, JSON.stringify({
    '*': { startWith: 'claude-chat' },
    '/code/app': { startWith: 'codex-chat', permissions: { 'codex-chat': 'plan' } },
  }))
  mockParams = { hostId: 'host-1', repo: '/code/app', at: '1' }
  await openScreen()
  expect(screen.getByLabelText('Directory').props.value).toBe('/code/app')
  expect(screen.getByRole('radio', { name: 'Codex chat' }).props.accessibilityState.checked).toBe(true)
  expect(screen.getByRole('button', { name: 'Permissions: Read only' })).toBeTruthy()
})

it('sends uploaded images with a chat’s opening prompt', async () => {
  await openScreen()
  answerSheets('Choose from Library')
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Attach images' })) })
  await act(async () => undefined)
  expect(screen.getByLabelText('Remove shot.png')).toBeTruthy()
  fireEvent.changeText(screen.getByLabelText('Opening prompt'), 'What is wrong here?')
  await create()
  expect(lastRequest().agent).toEqual({ provider: 'claude-chat', permissionMode: 'default', prompt: 'What is wrong here?', images: [mockImageRef] })
  expect(screen.queryByLabelText('Remove shot.png')).toBeNull()
})

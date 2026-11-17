import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { EMPTY_HOST_STATE } from '../daemon/state'
import { useHostsStore } from '../hosts/store'
import { ThemeProvider } from '../theme'
import { ChatList } from './ChatList'

const host = { id: 'h1', name: 'fixture', baseUrl: 'http://localhost:4310', auth: { kind: 'token' as const, token: 'fixture' } }

async function renderCreations(creations: typeof EMPTY_HOST_STATE.sessionCreations): Promise<void> {
  render(
    <ThemeProvider>
      <ChatList state={{ ...EMPTY_HOST_STATE, sessionCreations: creations }} hostId="h1" onSelectPane={() => undefined} />
    </ThemeProvider>,
  )
  await act(async () => undefined)
}

beforeEach(() => useHostsStore.setState({ hosts: [host] }))

it('shows a running creation with its stage, and a nameless one as New session', async () => {
  await renderCreations([
    { id: 'c1', name: 'big', cwd: '/repo', branch: 'big', stage: 'checking-out', percent: 42, startedAt: 1 },
    { id: 'c2', name: '', cwd: '/repo', stage: 'fetching', startedAt: 2 },
    { id: 'c3', name: 'ready', cwd: '/repo', stage: 'done', startedAt: 3 },
  ])
  expect(screen.getByText('New sessions')).toBeTruthy()
  expect(screen.getByText('big')).toBeTruthy()
  expect(screen.getByText('⎇ big · Checking out files… 42%')).toBeTruthy()
  expect(screen.getByText('New session')).toBeTruthy()
  expect(screen.queryByText('ready')).toBeNull()
  expect(screen.queryByText('Retry')).toBeNull()
})

it('offers Retry and Dismiss for a failed creation', async () => {
  const fetcher = jest.fn(async (_url: unknown, _init: unknown) => new Response(null, { status: 204 }))
  globalThis.fetch = fetcher as unknown as typeof fetch
  await renderCreations([{ id: 'c1', name: 'big', cwd: '/repo', stage: 'failed', error: 'git checkout failed', startedAt: 1 }])
  expect(screen.getByText('git checkout failed')).toBeTruthy()
  expect(screen.getByText('Could not start')).toBeTruthy()
  await act(async () => { fireEvent.press(screen.getByText('Dismiss')) })
  expect(fetcher).toHaveBeenCalledWith('http://localhost:4310/api/tmux/session-creations/c1', expect.objectContaining({ method: 'DELETE' }))
})

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native'

import { connectHost, disconnectHost } from '../daemon/client'
import { useDaemonStore } from '../daemon/store'
import { demoGuideSnapshot, resetDemoGuide } from '../demo/guide'
import { demoHost } from '../demo/flags'
import { ThemeProvider } from '../theme'
import { GuideView } from './GuideView'
import { isGuideTile } from './model'

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }))

const host = demoHost()

function guideTile() {
  const tile = useDaemonStore.getState().byHost[host.id]!.webPanes.find((pane) => pane.id === 'demo-guide')
  if (!isGuideTile(tile)) throw new Error('The demo seeds a guide tab')
  return tile
}

beforeEach(() => {
  resetDemoGuide()
  useDaemonStore.setState({ byHost: {} })
  connectHost(host)
})
afterEach(() => { cleanup(); disconnectHost(host.id) })

it('renders the guide with tappable steps, ticks them, saves a note and sends progress to the agent', async () => {
  render(<ThemeProvider><GuideView host={host} tile={guideTile()} /></ThemeProvider>)
  await screen.findByText('Review the companion on a phone')

  // The agent already ticked one step and one Markdown step id never shows.
  expect(screen.getByLabelText('1 of 8 steps done')).toBeTruthy()
  expect(screen.queryByText(/\{#/)).toBeNull()
  expect(screen.getByText('agent')).toBeTruthy()
  const update = screen.getByRole('button', { name: 'Update agent' })
  expect(update.props.accessibilityState.disabled).toBe(true)

  fireEvent.press(screen.getByRole('checkbox', { name: 'Open Remote chat from the Chats list' }))
  // Optimistic: the tick shows before the daemon answers.
  expect(screen.getByRole('checkbox', { name: 'Open Remote chat from the Chats list' }).props.accessibilityState.checked).toBe(true)
  await screen.findByText('1 unsent change')
  expect(screen.getByLabelText('2 of 8 steps done')).toBeTruthy()

  fireEvent.press(screen.getByRole('button', { name: 'Add a note to Send a short message and watch the reply stream in' }))
  fireEvent.changeText(screen.getByLabelText('Note for Send a short message and watch the reply stream in'), 'Reply streamed, but the first chunk flickered')
  fireEvent.press(screen.getByRole('button', { name: 'Save note' }))
  await screen.findByText('Reply streamed, but the first chunk flickered')
  await screen.findByText('2 unsent changes')
  expect(demoGuideSnapshot().marks).toMatchObject({ 'open-chat': { checked: true }, 'send-message': { note: 'Reply streamed, but the first chunk flickered' } })

  fireEvent.press(screen.getByRole('button', { name: 'Update agent with 2 changes' }))
  await screen.findByText('Progress sent to the agent.')
  await screen.findByText('Agent updated just now')
  expect(demoGuideSnapshot().changes).toEqual([])

  // The demo agent answers by editing the file; the canvas_changed event re-renders it live.
  await waitFor(() => expect(screen.getByText('Thanks — I read your update')).toBeTruthy(), { timeout: 3_000 })
  expect(screen.getByRole('checkbox', { name: 'Checkpoint: The chat reads like the desktop' }).props.accessibilityState.checked).toBe(true)
})

it('re-reads the state when another client ticks a step', async () => {
  render(<ThemeProvider><GuideView host={host} tile={guideTile()} /></ThemeProvider>)
  await screen.findByLabelText('1 of 8 steps done')
  const { demoGuideRoute } = jest.requireActual<typeof import('../demo/guide')>('../demo/guide')
  demoGuideRoute('/api/web-panes/demo-guide/guide/steps', 'POST', { id: 'tabs', checked: true })
  await act(async () => {
    const client = connectHost(host) as unknown as { emitDemo: (message: unknown) => void }
    client.emitDemo({ type: 'guide_state_changed', artifactId: guideTile().content.artifactId, file: guideTile().content.file })
  })
  await screen.findByLabelText('2 of 8 steps done')
})

it('explains a guide whose file is gone and offers a retry', async () => {
  const tile = { ...guideTile(), content: { kind: 'guide' as const, artifactId: 'ffffffffffffffff', file: 'gone.md' } }
  render(<ThemeProvider><GuideView host={host} tile={tile} /></ThemeProvider>)
  await screen.findByText('The guide could not be loaded')
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
})

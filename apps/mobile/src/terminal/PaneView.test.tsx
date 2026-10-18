import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { useChatStore } from '../chat/store'
import { chatState, fakeClient, session } from '../chat/testing'
import { EMPTY_HOST_STATE } from '../daemon/state'
import type { Host } from '../hosts/types'
import { SNAPSHOT } from '../testing/fixtures'
import { ThemeProvider } from '../theme'
import { PaneView } from './PaneView'

const HOST: Host = { id: 'host-1', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token', token: 'secret' } }
// The terminal's stream calls are stubbed; the chat only needs send and subscribe.
const mockClient = Object.assign(fakeClient(), {
  subscribePane: () => () => undefined,
  resizePane: () => null,
  releaseResize: () => null,
  holdsResizeLease: () => false,
  requestPaneReset: () => null,
})
const mockHostState = { ...EMPTY_HOST_STATE, phase: 'live' as const, snapshot: SNAPSHOT }

jest.mock('../daemon/useDaemonConnection', () => ({
  useDaemonConnection: () => mockHostState,
  useDaemonClient: () => mockClient,
}))

jest.mock('./TerminalSurface', () => {
  const { View } = jest.requireActual('react-native')
  return { TerminalSurface: () => <View testID="terminal-surface" /> }
})

function pane(paneId: string) {
  return (
    <ThemeProvider>
      <PaneView active host={HOST} onOpenTile={() => undefined} onSelectWindow={() => undefined} paneId={paneId} />
    </ThemeProvider>
  )
}

describe('the pane view', () => {
  beforeEach(() => {
    useChatStore.setState({
      byHost: {
        'host-1': {
          '%14': chatState({ paneId: '%14', session: session({ paneId: '%14', title: 'Chat A' }) }),
          '%20': chatState({ paneId: '%20', session: session({ paneId: '%20', title: 'Chat B' }) }),
        },
      },
    })
  })

  it('draws a chat pane natively and any other pane as the terminal', async () => {
    const view = render(pane('%14'))
    await act(async () => undefined)
    expect(screen.getByTestId('chat-view')).toBeTruthy()
    expect(screen.queryByTestId('terminal-surface')).toBeNull()
    view.rerender(pane('%40'))
    await act(async () => undefined)
    expect(screen.getByTestId('terminal-surface')).toBeTruthy()
  })

  it('keeps a draft when switching away to Worklog and back', async () => {
    render(pane('%14'))
    await act(async () => undefined)
    fireEvent.changeText(screen.getByTestId('chat-input'), 'keep this draft')
    fireEvent.press(screen.getByRole('tab', { name: 'Worklog' }))
    expect(screen.queryByTestId('chat-input')).toBeNull()
    fireEvent.press(screen.getByRole('tab', { name: 'Chat' }))
    expect(screen.getByTestId('chat-input').props.value).toBe('keep this draft')
  })

  it("keeps each chat's draft to itself when the cockpit switches panes", async () => {
    const view = render(pane('%14'))
    await act(async () => undefined)
    fireEvent.changeText(screen.getByTestId('chat-input'), 'meant for chat A')
    view.rerender(pane('%20'))
    await act(async () => undefined)
    expect(screen.getByText('lavish')).toBeTruthy()
    expect(screen.getByTestId('chat-input').props.value).toBe('')
    view.rerender(pane('%14'))
    await act(async () => undefined)
    expect(screen.getByTestId('chat-input').props.value).toBe('meant for chat A')
  })
})

import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { EMPTY_HOST_STATE } from '../daemon/state'
import { useHostsStore } from '../hosts/store'
import {
  DONE_STATUS,
  GIT_SUMMARY,
  NEEDS_INPUT_STATUS,
  PANE_PRS,
  SNAPSHOT,
  USAGE,
  WORKING_STATUS,
} from '../testing/fixtures'
import { ThemeProvider } from '../theme'
import { useFocusStore } from './focusStore'
import { WideCockpit } from './WideCockpit'

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useIsFocused: () => true,
  useLocalSearchParams: () => ({ hostId: 'host-1' }),
}))

// The terminal is a WebView; the cockpit only has to place it.
jest.mock('../terminal/TerminalSurface', () => {
  const { View } = jest.requireActual('react-native')
  return {
    TerminalSurface: ({ style }: { style?: unknown }) => (
      <View style={style} testID="terminal-surface" />
    ),
  }
})

const mockHostState = {
  ...EMPTY_HOST_STATE,
  phase: 'live' as const,
  snapshot: SNAPSHOT,
  usage: USAGE,
  agentStatuses: {
    '%14': NEEDS_INPUT_STATUS,
    '%20': WORKING_STATUS,
    '%40': DONE_STATUS,
  },
}

jest.mock('../daemon/useDaemonConnection', () => ({
  useDaemonConnection: () => mockHostState,
  useDaemonClient: () => undefined,
}))

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  mockRouter.push.mockClear()
  useFocusStore.setState({ byHost: {} })
  useHostsStore.setState({
    hosts: [{
      id: 'host-1',
      name: 'studio',
      baseUrl: 'http://studio.tail-1a2b.ts.net:4310',
      auth: { kind: 'token', token: 'secret' },
    }],
    hydrated: true,
  })
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/git/summary')) return jsonResponse(GIT_SUMMARY)
    if (url.includes('/api/prs/pane')) return jsonResponse({ list: PANE_PRS })
    return jsonResponse({})
  }) as unknown as typeof fetch
})

async function renderCockpit(mode: 'wide' | 'tablet' = 'wide'): Promise<void> {
  render(
    <ThemeProvider>
      <WideCockpit
        hostId="host-1"
        mode={mode}
        onSheetOpenChange={() => undefined}
        sheetOpen={false}
      />
    </ThemeProvider>,
  )
  await act(async () => undefined)
}

describe('the iPad cockpit', () => {
  it('draws the status row, the three columns and their content', async () => {
    await renderCockpit()

    // Status row: host, connection phase and snapshot revision.
    expect(screen.getByText('studio')).toBeTruthy()
    expect(screen.getByText('live')).toBeTruthy()
    expect(screen.getByText(`r${SNAPSHOT.revision}`, { exact: false })).toBeTruthy()

    // Left: usage tiles, the toggle and the attention inbox.
    expect(screen.getByText('Attention')).toBeTruthy()
    expect(screen.getByText('NEEDS YOU')).toBeTruthy()
    expect(screen.getByText('58% left')).toBeTruthy()
    expect(screen.getByText('+ New session')).toBeTruthy()

    // Centre: the pane that needs the owner, with its terminal.
    expect(screen.getByTestId('terminal-surface')).toBeTruthy()
    expect(screen.getAllByText('commando').length).toBeGreaterThan(0)

    // Right: the pending question, answerable in place, then the Info sections.
    // The question reads three times: the row's headline, the pane's HUD strip
    // and the answer card itself.
    expect(screen.getAllByText('Which auth flow should the companion use?')).toHaveLength(3)
    expect(screen.getByText('Owner email + password')).toBeTruthy()
    expect(screen.getByText('Reject')).toBeTruthy()
    // Section headers render in caps.
    expect(screen.getByText('CHANGES')).toBeTruthy()
    expect(screen.getByText('PULL REQUEST')).toBeTruthy()
    expect(screen.getByText('PORTS')).toBeTruthy()
    // Screenshots stay in the phone's Info sheet.
    expect(screen.queryByText('SCREENSHOTS')).toBeNull()
  })

  it('focuses the first Needs-you pane and highlights its row', async () => {
    await renderCockpit()
    const row = screen.getByLabelText(
      `commando: ${NEEDS_INPUT_STATUS.details?.requests?.[0]?.questions?.[0]?.question}`,
    )
    expect(row.props.accessibilityState.selected).toBe(true)
  })

  it('moves the focus to the tapped row rather than navigating', async () => {
    await renderCockpit()
    fireEvent.press(screen.getByLabelText('lavish: Add retry to the feedback poll'))
    await act(async () => undefined)

    expect(useFocusStore.getState().byHost['host-1']).toBe('%20')
    expect(mockRouter.push).not.toHaveBeenCalled()
    // The HUD follows: the question card goes with the pane that lost the
    // focus, leaving only the row headline that names it.
    expect(screen.getAllByText('Which auth flow should the companion use?')).toHaveLength(1)

    expect(screen.queryByText('Owner email + password')).toBeNull()
    expect(screen.getByText('Nothing pending')).toBeTruthy()
  })

  it('focuses the pane a deep link asked for', async () => {
    render(
      <ThemeProvider>
        <WideCockpit
          focusRequest="%40"
          hostId="host-1"
          mode="wide"
          onSheetOpenChange={() => undefined}
          sheetOpen={false}
        />
      </ThemeProvider>,
    )
    await act(async () => undefined)

    expect(useFocusStore.getState().byHost['host-1']).toBe('%40')
    const row = screen.getByLabelText(
      `island: ${DONE_STATUS.details?.recap?.summary}`,
    )
    expect(row.props.accessibilityState.selected).toBe(true)
  })

  it('hides the sessions column on a portrait iPad', async () => {
    await renderCockpit('tablet')
    expect(screen.queryByText('Attention')).toBeNull()
    expect(screen.getByLabelText('Show sessions')).toBeTruthy()
    // The terminal and the HUD stay side by side.
    expect(screen.getByTestId('terminal-surface')).toBeTruthy()
    // The pane's HUD strip and the answer card, with no sessions row now.
    expect(screen.getAllByText('Which auth flow should the companion use?')).toHaveLength(2)
    expect(screen.getByText('Owner email + password')).toBeTruthy()
  })
})

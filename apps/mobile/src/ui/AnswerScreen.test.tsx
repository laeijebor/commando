import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { EMPTY_HOST_STATE } from '../daemon/state'
import { useHostsStore } from '../hosts/store'
import { NEEDS_INPUT_STATUS, SNAPSHOT } from '../testing/fixtures'
import { ThemeProvider } from '../theme'
import { AnswerScreen } from './AnswerScreen'

const mockParams: Record<string, string> = {
  hostId: 'host-1',
  paneId: '%14',
  interactionId: 'req-1',
}

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}))

const mockHostState = {
  ...EMPTY_HOST_STATE,
  phase: 'live' as const,
  snapshot: SNAPSHOT,
  agentStatuses: { '%14': NEEDS_INPUT_STATUS },
}

jest.mock('../daemon/useDaemonConnection', () => ({
  useDaemonConnection: () => mockHostState,
}))

async function renderScreen(): Promise<void> {
  render(
    <ThemeProvider>
      <AnswerScreen />
    </ThemeProvider>,
  )
  await act(async () => undefined)
}

describe('the answer screen', () => {
  beforeEach(() => {
    mockParams.interactionId = 'req-1'
    mockRouter.push.mockClear()
    mockRouter.back.mockClear()
    ;(globalThis.fetch as jest.Mock).mockClear()
    useHostsStore.setState({
      hosts: [{
        id: 'host-1',
        name: 'studio',
        baseUrl: 'http://studio.tail-1a2b.ts.net:4310',
        auth: { kind: 'token', token: 'secret' },
      }],
      hydrated: true,
    })
  })

  it('renders the question, its options and their descriptions', async () => {
    await renderScreen()
    expect(screen.getByText('Which auth flow should the companion use?')).toBeTruthy()
    expect(screen.getByText('Owner email + password')).toBeTruthy()
    expect(screen.getByText('Reuse the Better Auth cookie')).toBeTruthy()
    expect(screen.getByText('Automation token only')).toBeTruthy()
    expect(screen.getByPlaceholderText('Or type your own answer…')).toBeTruthy()
  })

  it('says where a note ends up, since the protocol has no note field', async () => {
    await renderScreen()
    expect(
      screen.getByText('The protocol has no note field, so a note is appended to the answer you picked.'),
    ).toBeTruthy()
  })

  it('answers over the HTTP route when no socket is up, then leaves the screen', async () => {
    ;(globalThis.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, changed: true }), { status: 200 }),
    )
    await renderScreen()

    fireEvent.press(screen.getByText('Pairing QR'))
    await act(async () => {
      fireEvent.press(screen.getByText('Answer'))
    })

    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/agent-requests/%2514/req-1/answer')
    expect(JSON.parse(String(init.body)).answer).toEqual({
      action: 'answer',
      answers: [['Pairing QR']],
    })
    expect(mockRouter.back).toHaveBeenCalled()
  })

  it('shows the daemon error text instead of navigating away', async () => {
    ;(globalThis.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'The agent request is no longer pending' }), { status: 409 }),
    )
    await renderScreen()

    fireEvent.press(screen.getByText('Pairing QR'))
    await act(async () => {
      fireEvent.press(screen.getByText('Answer'))
    })

    expect(screen.getByText(/no longer pending/)).toBeTruthy()
    expect(mockRouter.back).not.toHaveBeenCalled()
  })

  it('explains itself when the request has already gone', async () => {
    mockParams.interactionId = 'req-gone'
    await renderScreen()
    expect(screen.getByText(/already answered/)).toBeTruthy()
    expect(screen.getByText('Show commando')).toBeTruthy()
  })
})

import { act, fireEvent, render, screen } from '@testing-library/react-native'

import type { ChatState } from '@commando/agent-chat'

import type { Host } from '../hosts/types'
import { ThemeProvider } from '../theme'
import { ChatView } from './ChatView'
import { DICTATION_DENIED, DICTATION_HINT_HOLD, dictationError, spliceDictation } from './dictation'
import type { SpeechEvents } from './speech'
import { chatState, fakeClient } from './testing'

type MockPermission = { granted: boolean; canAskAgain: boolean; status: string; expires: string }

// The recogniser is native: tests drive this double and assert on what the composer asked of it.
jest.mock('./speech', () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const state: { permission: MockPermission } = { permission: { granted: true, canAskAgain: true, status: 'granted', expires: 'never' } }
  const fake = {
    get permission(): MockPermission { return state.permission },
    set permission(next: MockPermission) { state.permission = next },
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
    getPermissionsAsync: jest.fn(async (): Promise<MockPermission> => state.permission),
    requestPermissionsAsync: jest.fn(async (): Promise<MockPermission> => state.permission),
    addListener: jest.fn((event: string, listener: (event: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
      return { remove: () => listeners.get(event)!.delete(listener) }
    }),
    emit: (event: string, payload?: unknown) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
    },
  }
  return { speech: fake }
})

type FakeSpeech = {
  permission: MockPermission
  start: jest.Mock
  stop: jest.Mock
  abort: jest.Mock
  getPermissionsAsync: jest.Mock
  requestPermissionsAsync: jest.Mock
  emit: <K extends keyof SpeechEvents>(event: K, ...payload: Parameters<SpeechEvents[K]>) => void
}
const fake = (jest.requireMock('./speech') as { speech: FakeSpeech }).speech

const HOST: Host = { id: 'host-1', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token', token: 'secret' } }

function renderChat(chat: ChatState = chatState()) {
  return render(
    <ThemeProvider>
      <ChatView chat={chat} client={fakeClient()} host={HOST} phase="live" />
    </ThemeProvider>,
  )
}

async function settle(): Promise<void> {
  await act(async () => undefined)
}

function said(transcript: string, isFinal = false) {
  act(() => fake.emit('result', { isFinal, results: [{ transcript, confidence: 1, segments: [] }] }))
}

const input = () => screen.getByTestId('chat-input')

beforeEach(() => {
  jest.clearAllMocks()
  fake.permission = { granted: true, canAskAgain: true, status: 'granted', expires: 'never' }
})

describe('spliceDictation', () => {
  it('replaces the selection, spacing the words from their neighbours', () => {
    expect(spliceDictation('', { start: 0, end: 0 }, ' Hello there ')).toEqual({ text: 'Hello there', cursor: 11 })
    expect(spliceDictation('Fix the', { start: 7, end: 7 }, 'login bug')).toEqual({ text: 'Fix the login bug', cursor: 17 })
    expect(spliceDictation('Fix  please', { start: 4, end: 4 }, 'it')).toEqual({ text: 'Fix it please', cursor: 6 })
    expect(spliceDictation('Fix this now', { start: 4, end: 8 }, 'that')).toEqual({ text: 'Fix that now', cursor: 8 })
  })

  it('leaves the draft alone when nothing was said', () => {
    expect(spliceDictation('draft', { start: 2, end: 2 }, '  ')).toEqual({ text: 'draft', cursor: 2 })
  })
})

describe('dictationError', () => {
  it('stays quiet for silence and cancels, and points to Settings when refused', () => {
    expect(dictationError({ error: 'no-speech', message: '' })).toBeNull()
    expect(dictationError({ error: 'aborted', message: '' })).toBeNull()
    expect(dictationError({ error: 'not-allowed', message: '' })).toBe(DICTATION_DENIED)
    expect(dictationError({ error: 'busy', message: 'Recognizer busy' })).toBe('Dictation stopped: Recognizer busy')
  })
})

describe('hold to dictate in the composer', () => {
  it('streams what is said into the draft at the caret and stops on release', async () => {
    renderChat()
    await settle()
    fireEvent.changeText(input(), 'Please')
    fireEvent(input(), 'selectionChange', { nativeEvent: { selection: { start: 6, end: 6 } } })

    fireEvent(screen.getByLabelText('Dictate'), 'pressIn')
    await settle()
    expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ interimResults: true, continuous: true, addsPunctuation: true }))
    expect(screen.getByLabelText('Listening')).toBeTruthy()

    said('add a')
    expect(input().props.value).toBe('Please add a')
    said('add a mic button.', true)
    said(' Then test it')
    expect(input().props.value).toBe('Please add a mic button. Then test it')

    fireEvent(screen.getByLabelText('Listening'), 'pressOut')
    expect(fake.stop).toHaveBeenCalled()
    said(' Then test it.', true)
    act(() => fake.emit('end'))
    expect(input().props.value).toBe('Please add a mic button. Then test it.')
    expect(screen.getByLabelText('Dictate')).toBeTruthy()
  })

  it('asks for permission first and says to hold again, since the prompt ends the press', async () => {
    fake.permission = { granted: false, canAskAgain: true, status: 'undetermined', expires: 'never' }
    fake.requestPermissionsAsync.mockImplementationOnce(async () => {
      fake.permission = { granted: true, canAskAgain: true, status: 'granted', expires: 'never' }
      return fake.permission
    })
    renderChat()
    await settle()
    const mic = screen.getByLabelText('Dictate')
    fireEvent(mic, 'pressIn')
    fireEvent(mic, 'pressOut')
    await settle()
    expect(fake.requestPermissionsAsync).toHaveBeenCalled()
    expect(fake.start).not.toHaveBeenCalled()
    expect(screen.getByText(DICTATION_HINT_HOLD)).toBeTruthy()
  })

  it('points to Settings when the microphone or speech recognition is refused', async () => {
    fake.permission = { granted: false, canAskAgain: false, status: 'denied', expires: 'never' }
    renderChat()
    await settle()
    fireEvent(screen.getByLabelText('Dictate'), 'pressIn')
    await settle()
    expect(fake.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(fake.start).not.toHaveBeenCalled()
    expect(screen.getByText(DICTATION_DENIED)).toBeTruthy()
  })

  it('says to hold the mic after a quick tap that heard nothing', async () => {
    renderChat()
    await settle()
    fireEvent(screen.getByLabelText('Dictate'), 'pressIn')
    await settle()
    fireEvent(screen.getByLabelText('Listening'), 'pressOut')
    act(() => fake.emit('error', { error: 'no-speech', message: 'No speech' }))
    act(() => fake.emit('end'))
    expect(screen.getByText(DICTATION_HINT_HOLD)).toBeTruthy()
  })

  it('shows a recogniser failure as the composer error', async () => {
    renderChat()
    await settle()
    fireEvent(screen.getByLabelText('Dictate'), 'pressIn')
    await settle()
    act(() => fake.emit('error', { error: 'network', message: 'offline' }))
    act(() => fake.emit('end'))
    expect(screen.getByText('Dictation needs a connection to Apple and lost it')).toBeTruthy()
  })

  it('has no mic once the session has ended', async () => {
    renderChat(chatState({ session: { ...chatState().session, status: 'closed' } }))
    await settle()
    expect(screen.queryByLabelText('Dictate')).toBeNull()
  })
})

import { act, fireEvent, render, screen } from '@testing-library/react-native'

import type { ChatState } from '@commando/agent-chat'

import type { Host } from '../hosts/types'
import { ThemeProvider } from '../theme'
import { ChatView } from './ChatView'
import { DICTATION_DENIED, DICTATION_HINT_HOLD, dictationError, pickSpeechLocale, spliceDictation } from './dictation'
import type { SpeechEvents } from './speech'
import { chatState, fakeClient, session } from './testing'

type MockPermission = { granted: boolean; canAskAgain: boolean; status: string; expires: string }

// The recogniser is native: tests drive this double, emitting its events in
// the order the real one does, and assert on what the composer asked of it.
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
    getSupportedLocales: jest.fn(async () => ({ locales: ['en-GB', 'en-US', 'fr-FR'], installedLocales: [] })),
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

let pane = 0
function renderChat(chat: ChatState = chatState()) {
  // A fresh pane each time, so no test inherits another's kept draft.
  pane += 1
  const id = `%d${pane}`
  const paneChat = (next: ChatState): ChatState => ({ ...next, paneId: id, session: { ...next.session, paneId: id } })
  const client = fakeClient()
  const view = render(<ThemeProvider><ChatView chat={paneChat(chat)} client={client} host={HOST} phase="live" /></ThemeProvider>)
  return { rerender: (next: ChatState) => view.rerender(<ThemeProvider><ChatView chat={paneChat(next)} client={client} host={HOST} phase="live" /></ThemeProvider>) }
}

async function settle(): Promise<void> {
  await act(async () => undefined)
}

const said = (transcript: string, isFinal = false) => act(() => fake.emit('result', { isFinal, results: [{ transcript, confidence: 1, segments: [] }] }))
const native = (event: 'start' | 'end') => act(() => fake.emit(event))
const input = () => screen.getByTestId('chat-input')
const press = async () => {
  fireEvent(screen.getByTestId('chat-dictate'), 'pressIn')
  await settle()
}
const release = () => fireEvent(screen.getByTestId('chat-dictate'), 'pressOut')

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

describe('pickSpeechLocale', () => {
  const supported = ['de-DE', 'de-AT', 'en-AU', 'en-GB', 'en-US', 'fr-CA', 'fr-FR', 'pt-BR']
  it('takes the phone locale when Apple has a recogniser for it', () => {
    expect(pickSpeechLocale('en-GB', supported)).toBe('en-GB')
    expect(pickSpeechLocale('de_AT', supported)).toBe('de-AT')
  })

  it("falls back to the language's home region, then any region of it", () => {
    expect(pickSpeechLocale('en-DE', supported)).toBe('en-US')
    expect(pickSpeechLocale('fr-GB', supported)).toBe('fr-FR')
    expect(pickSpeechLocale('pt-PT', supported)).toBe('pt-BR')
  })

  it('leaves the recogniser on its default when the language has none', () => {
    expect(pickSpeechLocale('ja-JP', supported)).toBeUndefined()
    expect(pickSpeechLocale(undefined, supported)).toBeUndefined()
  })
})

describe('hold to dictate in the composer', () => {
  it('streams what is said into the draft at the caret and stops on release', async () => {
    renderChat()
    await settle()
    fireEvent.changeText(input(), 'Please')
    fireEvent(input(), 'selectionChange', { nativeEvent: { selection: { start: 6, end: 6 } } })

    await press()
    expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ interimResults: true, continuous: true, addsPunctuation: true }))
    expect(screen.getByLabelText('Listening')).toBeTruthy()
    native('start')

    said('add a')
    expect(input().props.value).toBe('Please add a')
    said('add a mic button.', true)
    said(' Then test it')
    expect(input().props.value).toBe('Please add a mic button. Then test it')

    release()
    expect(fake.stop).toHaveBeenCalledTimes(1)
    said(' Then test it.', true)
    native('end')
    expect(input().props.value).toBe('Please add a mic button. Then test it.')
    expect(screen.getByLabelText('Dictate')).toBeTruthy()
  })

  it('holds a release back until the recogniser has started, so the stop reaches it', async () => {
    renderChat()
    await settle()
    await press()
    expect(fake.start).toHaveBeenCalled()
    release()
    expect(fake.stop).not.toHaveBeenCalled()
    native('start')
    expect(fake.stop).toHaveBeenCalledTimes(1)
  })

  it('starts a press made while the last take finishes once it ends, without repeating its words', async () => {
    renderChat()
    await settle()
    await press()
    native('start')
    said('First thought')
    release()

    await press()
    expect(fake.start).toHaveBeenCalledTimes(1)
    said('First thought.', true)
    native('end')
    await settle()
    expect(input().props.value).toBe('First thought.')
    expect(fake.start).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText('Listening')).toBeTruthy()

    native('start')
    said('Second one')
    expect(input().props.value).toBe('First thought. Second one')
  })

  it('aborts when the session ends mid-hold and ignores what arrives after', async () => {
    const { rerender } = renderChat()
    await settle()
    await press()
    native('start')
    said('half a')
    rerender(chatState({ session: session({ status: 'closed' }) }))
    expect(fake.abort).toHaveBeenCalledTimes(1)
    said('half a sentence')
    native('end')
    expect(input().props.value).toBe('half a')
    expect(screen.queryByTestId('chat-dictate')).toBeNull()
  })

  it('asks for permission first and says to hold again, since the prompt ends the press', async () => {
    fake.permission = { granted: false, canAskAgain: true, status: 'undetermined', expires: 'never' }
    fake.requestPermissionsAsync.mockImplementationOnce(async () => {
      fake.permission = { granted: true, canAskAgain: true, status: 'granted', expires: 'never' }
      return fake.permission
    })
    renderChat()
    await settle()
    fireEvent(screen.getByTestId('chat-dictate'), 'pressIn')
    release()
    await settle()
    expect(fake.requestPermissionsAsync).toHaveBeenCalled()
    expect(fake.start).not.toHaveBeenCalled()
    expect(screen.getByText(DICTATION_HINT_HOLD)).toBeTruthy()
  })

  it('points to Settings when the microphone or speech recognition is refused', async () => {
    fake.permission = { granted: false, canAskAgain: false, status: 'denied', expires: 'never' }
    renderChat()
    await settle()
    await press()
    expect(fake.requestPermissionsAsync).not.toHaveBeenCalled()
    expect(fake.start).not.toHaveBeenCalled()
    expect(screen.getByText(DICTATION_DENIED)).toBeTruthy()
  })

  it('says to hold the mic after a quick tap that heard nothing', async () => {
    renderChat()
    await settle()
    await press()
    native('start')
    release()
    act(() => fake.emit('error', { error: 'no-speech', message: 'No speech' }))
    native('end')
    expect(screen.getByText(DICTATION_HINT_HOLD)).toBeTruthy()
  })

  it('shows a recogniser failure as the composer error', async () => {
    renderChat()
    await settle()
    await press()
    act(() => fake.emit('error', { error: 'network', message: 'offline' }))
    native('end')
    expect(screen.getByText('Dictation needs a connection to Apple and lost it')).toBeTruthy()
  })
})

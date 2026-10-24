import { AppState, type AppStateStatus } from 'react-native'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

import type { Host } from '../hosts/types'
import { ThemeProvider } from '../theme'
import { ChatView } from './ChatView'
import { dataUriBytes, pastedImage } from './clipboard'
import { chatState, fakeClient } from './testing'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

type MockPayload = { type: 'image'; data: string; size: { width: number; height: number } } | { type: 'text'; text: string }

const mockClipboard = {
  hasImageAsync: jest.fn(async () => true),
  getImageAsync: jest.fn(async (): Promise<{ data: string; size: { width: number; height: number } } | null> => ({ data: PNG, size: { width: 40, height: 30 } })),
  listener: null as null | (() => void),
  pasteButton: false,
  pastePayload: { type: 'image', data: PNG, size: { width: 40, height: 30 } } as MockPayload,
}

jest.mock('expo-clipboard', () => {
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native')
  const mocked = {
    ...jest.requireActual('expo-clipboard'),
    hasImageAsync: () => mockClipboard.hasImageAsync(),
    getImageAsync: () => mockClipboard.getImageAsync(),
    addClipboardListener: (listener: () => void) => {
      mockClipboard.listener = listener
      return { remove: () => { mockClipboard.listener = null } }
    },
    setStringAsync: jest.fn(async () => true),
    // UIPasteControl stands in as a button that hands over whatever the test put on the clipboard.
    ClipboardPasteButton: ({ onPress, accessibilityLabel }: { onPress: (data: MockPayload) => void; accessibilityLabel?: string }) => (
      <Pressable accessibilityLabel={accessibilityLabel} onPress={() => onPress(mockClipboard.pastePayload)}><Text>Paste</Text></Pressable>
    ),
  }
  Object.defineProperty(mocked, 'isPasteButtonAvailable', { get: () => mockClipboard.pasteButton })
  return mocked
})

const HOST: Host = { id: 'host-1', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token', token: 'secret' } }
const IMAGE_ID = `${'c'.repeat(64)}.png`

/** Drives every AppState listener the composer registered, as iOS would. */
function emitAppState(state: AppStateStatus): void {
  for (const [type, listener] of appStateSpy.mock.calls) if (type === 'change') (listener as (state: AppStateStatus) => void)(state)
}
let appStateSpy: jest.SpyInstance

async function settle(): Promise<void> {
  await act(async () => undefined)
}

describe('clipboard images', () => {
  it('counts the bytes behind a base64 data URI', () => {
    expect(dataUriBytes('data:image/png;base64,AAAA')).toBe(3)
    expect(dataUriBytes('data:image/png;base64,AAA=')).toBe(2)
    expect(dataUriBytes('data:image/png;base64,AA==')).toBe(1)
  })

  it('turns a clipboard image into a picked image named for when it was pasted', () => {
    expect(pastedImage({ data: PNG, size: { width: 40, height: 30 } }, new Date(2026, 9, 24, 9, 5, 7))).toEqual({
      uri: PNG,
      name: 'pasted-20261024-090507.png',
      type: 'image/png',
      width: 40,
      height: 30,
      size: dataUriBytes(PNG),
    })
    expect(pastedImage({ data: 'data:image/jpeg;base64,AAAA', size: { width: 1, height: 1 } })?.name).toMatch(/\.jpg$/)
    expect(pastedImage({ data: 'not a data uri', size: { width: 1, height: 1 } })).toBeNull()
  })
})

describe('pasting an image into the phone composer', () => {
  beforeEach(() => {
    mockClipboard.getImageAsync.mockClear()
    appStateSpy = jest.spyOn(AppState, 'addEventListener')
    mockClipboard.hasImageAsync.mockResolvedValue(true)
    mockClipboard.pasteButton = false
    mockClipboard.pastePayload = { type: 'image', data: PNG, size: { width: 40, height: 30 } }
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => (
      String(input).startsWith('data:')
        ? new Response('png-bytes')
        : new Response(JSON.stringify({ image: { id: IMAGE_ID } }), { status: 201 })
    )) as unknown as typeof fetch
  })

  function renderChat() {
    const client = fakeClient()
    render(<ThemeProvider><ChatView chat={chatState()} client={client} host={HOST} phase="live" /></ThemeProvider>)
    return client
  }

  it('offers the clipboard image, attaches it like a picked one and sends it', async () => {
    const client = renderChat()
    await settle()
    expect(screen.getByText('Copied image')).toBeTruthy()

    fireEvent.press(screen.getByLabelText('Paste image'))
    await settle()
    await settle()
    // The offer is used up; the image waits in the draft, removable.
    expect(screen.queryByText('Copied image')).toBeNull()
    expect(screen.getByLabelText(/^Remove pasted-\d{8}-\d{6}\.png$/)).toBeTruthy()
    expect(globalThis.fetch).toHaveBeenCalledWith('http://studio:4310/api/chat/images', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Content-Type': 'image/png' }) }))

    fireEvent.changeText(screen.getByTestId('chat-input'), 'This is what I see')
    fireEvent.press(screen.getByLabelText('Send'))
    expect(client.last('chat_send')).toMatchObject({ text: 'This is what I see', images: [{ id: IMAGE_ID, name: expect.stringMatching(/^pasted-/) }] })
  })

  it('can be waved away, and stays away until the clipboard changes', async () => {
    renderChat()
    await settle()
    fireEvent.press(screen.getByLabelText('Hide paste image'))
    expect(screen.queryByText('Copied image')).toBeNull()

    // Control Center or a banner only makes the app inactive: nothing new to offer.
    act(() => { emitAppState('inactive') })
    act(() => { emitAppState('active') })
    await settle()
    expect(screen.queryByText('Copied image')).toBeNull()

    // A copy in this app, or back from another one, offers it again.
    act(() => { mockClipboard.listener?.() })
    await settle()
    expect(screen.getByText('Copied image')).toBeTruthy()
    fireEvent.press(screen.getByLabelText('Hide paste image'))
    act(() => { emitAppState('background') })
    act(() => { emitAppState('active') })
    await settle()
    expect(screen.getByText('Copied image')).toBeTruthy()
  })

  it("pastes through iOS's paste control, and ignores a text item from a mixed copy", async () => {
    mockClipboard.pasteButton = true
    mockClipboard.pastePayload = { type: 'text', text: 'caption' }
    renderChat()
    await settle()
    fireEvent.press(screen.getByLabelText('Paste image'))
    await settle()
    expect(screen.getByText('Copied image')).toBeTruthy()
    expect(screen.queryByText(/no longer holds/)).toBeNull()

    mockClipboard.pastePayload = { type: 'image', data: PNG, size: { width: 40, height: 30 } }
    fireEvent.press(screen.getByLabelText('Paste image'))
    await settle()
    await settle()
    expect(screen.queryByText('Copied image')).toBeNull()
    expect(screen.getByLabelText(/^Remove pasted-/)).toBeTruthy()
    expect(mockClipboard.getImageAsync).not.toHaveBeenCalled()
  })

  it('says so when the image is gone by the time it is pasted', async () => {
    mockClipboard.getImageAsync.mockResolvedValueOnce(null)
    renderChat()
    await settle()
    fireEvent.press(screen.getByLabelText('Paste image'))
    await settle()
    expect(screen.getByText('The clipboard no longer holds an image')).toBeTruthy()
  })

  it('shows nothing when the clipboard has no image', async () => {
    mockClipboard.hasImageAsync.mockResolvedValue(false)
    renderChat()
    await settle()
    expect(screen.queryByText('Copied image')).toBeNull()
  })
})

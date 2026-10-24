import { act, fireEvent, render, screen } from '@testing-library/react-native'

import type { Host } from '../hosts/types'
import { ThemeProvider } from '../theme'
import { ChatView } from './ChatView'
import { dataUriBytes, pastedImage } from './clipboard'
import { chatState, fakeClient } from './testing'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

const mockClipboard = {
  hasImageAsync: jest.fn(async () => true),
  getImageAsync: jest.fn(async (): Promise<{ data: string; size: { width: number; height: number } } | null> => ({ data: PNG, size: { width: 40, height: 30 } })),
  addClipboardListener: jest.fn(() => ({ remove: jest.fn() })),
}

jest.mock('expo-clipboard', () => ({
  ...jest.requireActual('expo-clipboard'),
  hasImageAsync: () => mockClipboard.hasImageAsync(),
  getImageAsync: () => mockClipboard.getImageAsync(),
  addClipboardListener: () => mockClipboard.addClipboardListener(),
  setStringAsync: jest.fn(async () => true),
  // The unit suite has no UIPasteControl; the fallback button reads the clipboard instead.
  isPasteButtonAvailable: false,
}))

const HOST: Host = { id: 'host-1', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token', token: 'secret' } }
const IMAGE_ID = `${'c'.repeat(64)}.png`

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
    mockClipboard.hasImageAsync.mockResolvedValue(true)
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

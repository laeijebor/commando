import { ActionSheetIOS } from 'react-native'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { MAX_CHAT_IMAGES } from '@commando/agent-chat'

import type { Host } from '../hosts/types'
import { ThemeProvider } from '../theme'
import { ChatView } from './ChatView'
import type { PickedImage } from './images'
import { chatState, fakeClient } from './testing'

const mockPicker = {
  takePhoto: jest.fn(async (): Promise<PickedImage[] | null> => null),
  pickImages: jest.fn(async (_limit: number): Promise<PickedImage[] | null> => null),
}

jest.mock('./images', () => ({
  ...jest.requireActual('./images'),
  takePhoto: () => mockPicker.takePhoto(),
  pickImages: (limit: number) => mockPicker.pickImages(limit),
}))

const HOST: Host = { id: 'host-1', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token', token: 'secret' } }
const IMAGE_ID = `${'d'.repeat(64)}.jpg`
const PHOTO: PickedImage = { uri: 'file:///camera.jpg', name: 'photo-1.jpg', type: 'image/jpeg', width: 1200, height: 900, size: 300_000 }

/** Answers the paperclip's sheet with the option at `index` (null cancels). */
function answerSheet(index: number | null): jest.SpyInstance {
  return jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
    callback(index ?? options.cancelButtonIndex ?? options.options.length - 1)
  })
}

async function settle(): Promise<void> {
  await act(async () => undefined)
}

describe('attaching from the phone composer', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    mockPicker.takePhoto.mockReset().mockResolvedValue(null)
    mockPicker.pickImages.mockReset().mockResolvedValue(null)
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => (
      String(input).startsWith('file:')
        ? new Response('jpeg-bytes')
        : new Response(JSON.stringify({ image: { id: IMAGE_ID } }), { status: 201 })
    )) as unknown as typeof fetch
  })

  function renderChat() {
    const client = fakeClient()
    render(<ThemeProvider><ChatView chat={chatState()} client={client} host={HOST} phase="live" /></ThemeProvider>)
    return client
  }

  it('offers the camera and the library behind the paperclip', async () => {
    const sheet = answerSheet(null)
    renderChat()
    fireEvent.press(screen.getByLabelText('Attach images'))
    await settle()
    expect(sheet.mock.calls[0]![0]).toMatchObject({ options: ['Take Photo', 'Choose from Library', 'Cancel'], cancelButtonIndex: 2 })
    // Cancelling opens neither.
    expect(mockPicker.takePhoto).not.toHaveBeenCalled()
    expect(mockPicker.pickImages).not.toHaveBeenCalled()
  })

  it('attaches a photo from the camera and sends it', async () => {
    answerSheet(0)
    mockPicker.takePhoto.mockResolvedValue([PHOTO])
    const client = renderChat()
    fireEvent.press(screen.getByLabelText('Attach images'))
    await settle()
    await settle()
    expect(screen.getByLabelText('Remove photo-1.jpg')).toBeTruthy()
    expect(globalThis.fetch).toHaveBeenCalledWith('http://studio:4310/api/chat/images', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Content-Type': 'image/jpeg' }) }))

    fireEvent.press(screen.getByLabelText('Send'))
    expect(client.last('chat_send')).toMatchObject({ images: [{ id: IMAGE_ID, name: 'photo-1.jpg' }] })
  })

  it('opens the library for as many images as still fit', async () => {
    answerSheet(1)
    renderChat()
    fireEvent.press(screen.getByLabelText('Attach images'))
    await settle()
    expect(mockPicker.pickImages).toHaveBeenCalledWith(MAX_CHAT_IMAGES)
    expect(mockPicker.takePhoto).not.toHaveBeenCalled()
  })

  it("says why the camera didn't open", async () => {
    answerSheet(0)
    mockPicker.takePhoto.mockRejectedValue(new Error('Camera access is off for Commando; turn it on in Settings to take photos'))
    renderChat()
    fireEvent.press(screen.getByLabelText('Attach images'))
    await settle()
    expect(screen.getByText('Camera access is off for Commando; turn it on in Settings to take photos')).toBeTruthy()
  })
})

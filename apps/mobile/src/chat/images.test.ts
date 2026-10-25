import { isChatImageId } from '@commando/agent-chat'

import { DEMO_ORIGIN, demoHost } from '../demo/flags'
import { chatImageUri, pickImages, prepareImage, REBUILD_FOR_IMAGES, takePhoto, uploadChatImage } from './images'

const mockOptionalNative = jest.fn((_name: string): unknown => null)

jest.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) => mockOptionalNative(name),
}))

const mockCamera = {
  permission: { granted: true, canAskAgain: true },
  result: { canceled: false, assets: [{ uri: 'file:///camera.jpg', fileName: null, mimeType: 'image/jpeg', width: 3024, height: 4032, fileSize: 2_000_000 }] } as unknown,
  launch: jest.fn(),
}

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: async () => mockCamera.permission,
  launchCameraAsync: async (options: unknown) => {
    mockCamera.launch(options)
    return mockCamera.result
  },
}))

const HOST = { id: 'h', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token' as const, token: 'secret' } }

describe('chat images', () => {
  it('asks for a rebuild instead of crashing when the native picker is missing', async () => {
    await expect(pickImages(3)).rejects.toThrow(REBUILD_FOR_IMAGES)
    expect(mockOptionalNative).toHaveBeenCalledWith('ExponentImagePicker')
  })

  it('asks for a rebuild before opening the camera when the native picker is missing', async () => {
    await expect(takePhoto()).rejects.toThrow(REBUILD_FOR_IMAGES)
  })

  describe('with the native picker', () => {
    beforeEach(() => {
      mockOptionalNative.mockImplementation((name) => (name === 'ExponentImagePicker' ? {} : null))
      mockCamera.permission = { granted: true, canAskAgain: true }
      mockCamera.launch.mockClear()
    })
    afterEach(() => mockOptionalNative.mockImplementation(() => null))

    it('takes one photo and names it, as the camera gives no file name', async () => {
      await expect(takePhoto()).resolves.toEqual([{ uri: 'file:///camera.jpg', name: 'photo-1.jpg', type: 'image/jpeg', width: 3024, height: 4032, size: 2_000_000 }])
      expect(mockCamera.launch).toHaveBeenCalledWith({ mediaTypes: ['images'], quality: 1 })
    })

    it('returns null when the camera is cancelled', async () => {
      const taken = mockCamera.result
      mockCamera.result = { canceled: true, assets: null }
      await expect(takePhoto()).resolves.toBeNull()
      mockCamera.result = taken
    })

    it("doesn't open the camera without permission, and points to Settings once iOS won't ask again", async () => {
      mockCamera.permission = { granted: false, canAskAgain: true }
      await expect(takePhoto()).rejects.toThrow('Commando needs the camera to take a photo')
      mockCamera.permission = { granted: false, canAskAgain: false }
      await expect(takePhoto()).rejects.toThrow(/turn it on in Settings/)
      expect(mockCamera.launch).not.toHaveBeenCalled()
    })
  })

  it('keeps an image within both limits as it is, and refuses other types', async () => {
    const small = { uri: 'file:///a.png', name: 'a.png', type: 'image/png', width: 800, height: 600, size: 1_000 }
    await expect(prepareImage(small)).resolves.toEqual({ ok: true, image: { uri: 'file:///a.png', name: 'a.png', type: 'image/png' } })
    await expect(prepareImage({ ...small, type: 'image/heic' })).resolves.toMatchObject({ ok: false })
    // Too big to keep, and no resizer in this build.
    await expect(prepareImage({ ...small, width: 4000 })).resolves.toEqual({ ok: false, error: REBUILD_FOR_IMAGES })
  })

  it('uploads with the host token and returns the stored id', async () => {
    const id = `${'b'.repeat(64)}.png`
    const fetcher = jest.fn(async (input: RequestInfo | URL, _init?: RequestInit) => (
      String(input).startsWith('file:')
        ? new Response('png-bytes')
        : new Response(JSON.stringify({ image: { id } }), { status: 201 })
    )) as unknown as jest.Mock & typeof fetch
    await expect(uploadChatImage(HOST, { uri: 'file:///a.png', name: 'a.png', type: 'image/png' }, fetcher)).resolves.toEqual({ id, name: 'a.png' })
    const [url, init] = fetcher.mock.calls[1]!
    expect(url).toBe('http://studio:4310/api/chat/images')
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: 'Bearer secret' } })
  })

  it("says the daemon's reason when it refuses an upload", async () => {
    const fetcher = jest.fn(async (input: RequestInfo | URL) => (
      String(input).startsWith('file:')
        ? new Response('x')
        : new Response(JSON.stringify({ error: 'Only PNG, JPEG, GIF and WebP images can be attached' }), { status: 415 })
    )) as unknown as typeof fetch
    await expect(uploadChatImage(HOST, { uri: 'file:///a.png', name: 'a.png', type: 'image/png' }, fetcher)).rejects.toThrow('Only PNG')
  })

  it('keeps demo uploads on the phone, and loads them from there', async () => {
    const fetcher = jest.fn() as unknown as typeof fetch
    const ref = await uploadChatImage(demoHost(), { uri: 'data:image/png;base64,AAAA', name: 'pasted.png', type: 'image/png' }, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    expect(isChatImageId(ref.id)).toBe(true)
    expect(chatImageUri(DEMO_ORIGIN, ref.id)).toBe('data:image/png;base64,AAAA')
    expect(chatImageUri('http://studio:4310', ref.id)).toBe(`http://studio:4310/chat-images/${ref.id}`)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { fitAttachments } from '../../shared/chat-composer'
import { prepareImage, type ImageCodec } from './attachImages'

const MB = 1024 * 1024

function file(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

function codec(width: number, height: number, encodedBytes: (type: string, quality: number) => number = () => 1000): ImageCodec & { encode: ReturnType<typeof vi.fn> } {
  return {
    size: async () => ({ width, height }),
    encode: vi.fn(async (_file: Blob, _width: number, _height: number, type: string, quality: number) => new Blob([new Uint8Array(encodedBytes(type, quality))], { type })),
  }
}

describe('prepareImage', () => {
  it('keeps small images untouched', async () => {
    const original = file('shot.png', 'image/png', 2000)
    const fake = codec(1200, 800)
    const result = await prepareImage(original, fake)
    expect(result).toEqual({ ok: true, image: { blob: original, name: 'shot.png', type: 'image/png' } })
    expect(fake.encode).not.toHaveBeenCalled()
  })

  it('resizes the longest edge to 2000px in the same format', async () => {
    const fake = codec(4096, 1024)
    const result = await prepareImage(file('wide.webp', 'image/webp', 3000), fake)
    expect(result.ok && result.image.type).toBe('image/webp')
    expect(fake.encode).toHaveBeenCalledWith(expect.anything(), 2000, 500, 'image/webp', 0.92)
  })

  it('falls back to JPEG when a resized PNG is still too big, and says when nothing fits', async () => {
    const fallback = codec(3000, 3000, (type) => (type === 'image/png' ? 12 * MB : 2 * MB))
    const result = await prepareImage(file('noise.png', 'image/png', 30 * MB), fallback)
    expect(result).toMatchObject({ ok: true, image: { name: 'noise.jpg', type: 'image/jpeg' } })
    const hopeless = await prepareImage(file('huge.png', 'image/png', 30 * MB), codec(3000, 3000, () => 11 * MB))
    expect(hopeless).toEqual({ ok: false, error: 'huge.png is 11 MB; images must be 10 MB or smaller' })
  })

  it('refuses other types, unreadable files and oversized GIFs, but keeps GIFs animated', async () => {
    expect(await prepareImage(file('vector.svg', 'image/svg+xml', 10), codec(1, 1))).toEqual({ ok: false, error: 'vector.svg: only PNG, JPEG, GIF and WebP images can be attached' })
    expect(await prepareImage(file('x.png', 'image/png', 10), { size: async () => { throw new Error('bad') }, encode: async () => null })).toEqual({ ok: false, error: "x.png couldn't be read as an image" })
    expect(await prepareImage(file('big.gif', 'image/gif', 11 * MB), codec(1, 1))).toMatchObject({ ok: false, error: expect.stringMatching(/big\.gif is 11 MB/) })
    const fake = codec(5000, 5000)
    expect(await prepareImage(file('anim.gif', 'image/gif', 5 * MB), fake)).toMatchObject({ ok: true, image: { type: 'image/gif' } })
    expect(fake.encode).not.toHaveBeenCalled()
  })

  it('limits a message to ten images', () => {
    expect(fitAttachments(0, 3)).toEqual({ accepted: 3 })
    expect(fitAttachments(8, 4)).toEqual({ accepted: 2, error: 'A message can carry at most 10 images' })
    expect(fitAttachments(10, 1)).toEqual({ accepted: 0, error: 'A message can carry at most 10 images' })
  })
})

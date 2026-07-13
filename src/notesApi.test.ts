import { describe, expect, it, vi } from 'vitest'
import { createNotesApi } from './notesApi'

describe('notes image API', () => {
  it('uploads image bytes and resolves only managed image paths with the runtime token', async () => {
    const noteId = '71cf1432-e39e-4ac1-a1d8-51185f94dbce'
    const imageName = 'a30fa1a4-6f1c-41d9-890f-c93cb9c218ba.png'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      path: `images/${noteId}/${imageName}`,
    }, { status: 201 }))
    const api = createNotesApi('test token', fetcher)
    const file = new File(['png bytes'], 'clipboard.png', { type: 'image/png' })

    await expect(api.uploadImage(noteId, file)).resolves.toBe(`images/${noteId}/${imageName}`)
    expect(fetcher).toHaveBeenCalledWith(
      `/api/notes/${noteId}/images`,
      expect.objectContaining({
        method: 'POST',
        body: file,
        headers: expect.objectContaining({
          Authorization: 'Bearer test token',
          'Content-Type': 'image/png',
        }),
      }),
    )
    expect(api.resolveImageUrl(`images/${noteId}/${imageName}`)).toBe(
      `/api/notes/${noteId}/images/${imageName}?token=test%20token`,
    )
    expect(api.resolveImageUrl('https://example.com/image.png')).toBe('https://example.com/image.png')
  })
})

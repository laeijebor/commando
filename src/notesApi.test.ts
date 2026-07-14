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

    await expect(api.uploadImage('vault-1', noteId, file)).resolves.toBe(`images/${noteId}/${imageName}`)
    expect(fetcher).toHaveBeenCalledWith(
      `/api/notes/${noteId}/images?vault=vault-1`,
      expect.objectContaining({
        method: 'POST',
        body: file,
        headers: expect.objectContaining({
          Authorization: 'Bearer test token',
          'Content-Type': 'image/png',
        }),
      }),
    )
    expect(api.resolveImageUrl(`images/${noteId}/${imageName}`, 'vault-1')).toBe(
      `/api/notes/${noteId}/images/${imageName}?vault=vault-1&token=test+token`,
    )
    expect(api.resolveImageUrl('https://example.com/image.png', 'vault-1')).toBe('https://example.com/image.png')
  })

  it('browses daemon directories and creates a vault within the selected parent', async () => {
    const browseResult = { path: '/tmp/notes', parent: '/tmp', home: '/Users/test', directories: [] }
    const vaultResult = { activeVaultId: 'vault-2', vaults: [] }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => (
      String(input).includes('/browse') ? Response.json(browseResult) : Response.json(vaultResult)
    ))
    const api = createNotesApi('test-token', fetcher)

    await expect(api.browseVault('/tmp/notes')).resolves.toEqual(browseResult)
    await expect(api.createVaultIn('/tmp/notes', 'work')).resolves.toEqual(vaultResult)
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/note-vaults/browse?path=%2Ftmp%2Fnotes', expect.any(Object))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/note-vaults/create', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ parent: '/tmp/notes', name: 'work' }),
    }))
  })

  it('uses the session cookie and clean image URLs when no automation token is present', async () => {
    const noteId = '71cf1432-e39e-4ac1-a1d8-51185f94dbce'
    const imageName = 'a30fa1a4-6f1c-41d9-890f-c93cb9c218ba.png'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ notes: [], folders: [] }))
    const api = createNotesApi('', fetcher)

    await expect(api.list('vault-1')).resolves.toEqual({ notes: [], folders: [] })
    const init = fetcher.mock.calls[0]?.[1]
    expect(init?.credentials).toBe('same-origin')
    expect(init?.headers).not.toHaveProperty('Authorization')
    expect(api.resolveImageUrl(`images/${noteId}/${imageName}`, 'vault-1')).toBe(
      `/api/notes/${noteId}/images/${imageName}?vault=vault-1`,
    )
  })
})

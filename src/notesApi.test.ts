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

  it('renames and deletes folders through the vault-scoped endpoint', async () => {
    const snapshot = { notes: [], folders: ['Archive'] }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(snapshot))
    const api = createNotesApi('test-token', fetcher)

    await expect(api.renameFolder('vault-1', 'Inbox', 'Archive')).resolves.toEqual(snapshot)
    await expect(api.deleteFolder('vault-1', 'Archive')).resolves.toEqual(snapshot)
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/notes/folders?vault=vault-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ folder: 'Inbox', name: 'Archive' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/notes/folders?vault=vault-1', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ folder: 'Archive' }),
    }))
  })

  it('moves and deletes note batches with concurrency timestamps', async () => {
    const snapshot = { notes: [], folders: ['Archive'], failures: [] }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(snapshot))
    const api = createNotesApi('test-token', fetcher)
    const targets = [{ id: 'note-1', updatedAt: 123 }, { id: 'note-2', updatedAt: 456 }]

    await expect(api.moveMany('vault-1', targets, 'Archive')).resolves.toEqual(snapshot)
    await expect(api.deleteMany('vault-1', targets)).resolves.toEqual(snapshot)
    const notes = targets.map(({ id, updatedAt }) => ({ id, expectedUpdatedAt: updatedAt }))
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/notes/batch?vault=vault-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ notes, folder: 'Archive' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/notes/batch?vault=vault-1', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ notes }),
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

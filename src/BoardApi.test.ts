import { describe, expect, it, vi } from 'vitest'
import { boardThumbPath, createBoardsApi } from './boardsApi'
import { createHostFetch } from './hostPaths'

describe('Board API', () => {
  it('encodes identities, authenticates and routes requests through the owning host', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ targetId: 'target', rev: 1, items: [], groups: [], links: [], placements: {} }), { status: 200 }))
    const api = createBoardsApi('owner', createHostFetch('work laptop', undefined, fetcher))
    await api.get('target')
    await api.place('target', 'file:/a b#c', { x: 20, y: 30, fixed: true })
    await api.patch('target', 'file:/a b#c', { pinned: true })
    await api.revive('target', 'file:/a b#c', '%12')
    await api.remove('target', 'file:/a b#c')
    expect(fetcher.mock.calls[0]).toEqual(['/h/work%20laptop/api/boards/target', expect.objectContaining({ credentials: 'same-origin', headers: expect.objectContaining({ Authorization: 'Bearer owner' }) })])
    expect(fetcher.mock.calls[1]).toEqual(['/h/work%20laptop/api/boards/target/place', expect.objectContaining({ method: 'POST', body: JSON.stringify({ key: 'file:/a b#c', x: 20, y: 30, fixed: true }) })])
    expect(fetcher.mock.calls[2][0]).toBe('/h/work%20laptop/api/boards/target/items/file%3A%2Fa%20b%23c')
    expect(fetcher.mock.calls[3][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ anchorPaneId: '%12' }) })
    expect(fetcher.mock.calls[4][1]).toMatchObject({ method: 'DELETE' })
    expect(boardThumbPath('a'.repeat(64), 960)).toBe(`/api/boards/thumbs/${'a'.repeat(64)}/960`)
  })
  it('reveals without a body and accepts an empty 204 response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    await createBoardsApi('', fetcher).reveal('target', 'file:/tmp/a')
    expect(fetcher).toHaveBeenCalledWith('/api/boards/target/items/file%3A%2Ftmp%2Fa/reveal', expect.objectContaining({ method: 'POST' }))
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body')
  })
  it.each([404, 501])('shows the reveal error for status %s', async (status) => {
    const api = createBoardsApi('', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'Reveal unavailable' }), { status })))
    await expect(api.reveal('target', 'file:/tmp/a')).rejects.toThrow('Reveal unavailable')
  })
})

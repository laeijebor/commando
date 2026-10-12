import { describe, expect, it, vi } from 'vitest'
import { createChatStashApi } from './chatStash'

const entry = { id: 'a'.repeat(32), createdAt: 1, text: 'hi', images: [], source: { paneId: '%1' } }
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('chat stash API client', () => {
  it('stashes with the token and returns the new entry', async () => {
    const fetcher = vi.fn(async () => reply(201, { entry }))
    const api = createChatStashApi('secret', fetcher as unknown as typeof fetch)
    await expect(api.push({ text: 'hi', images: [], source: { paneId: '%1' } })).resolves.toEqual(entry)
    expect(fetcher).toHaveBeenCalledWith('/api/chat/stash', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
    }))
  })

  it('takes an entry, and answers null when another window took it first', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { entry, missingImages: 1 }))
      .mockResolvedValueOnce(reply(404, { error: 'gone' }))
    const api = createChatStashApi('', fetcher as unknown as typeof fetch)
    await expect(api.take(entry.id)).resolves.toEqual({ entry, missingImages: 1 })
    await expect(api.take(entry.id)).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledWith(`/api/chat/stash/${entry.id}`, expect.objectContaining({ method: 'DELETE', headers: {} }))
  })

  it('reports the daemon’s error', async () => {
    const api = createChatStashApi('', (async () => reply(507, { error: "Commando couldn't save the stash: ENOSPC" })) as unknown as typeof fetch)
    await expect(api.push({ text: 'hi', images: [], source: { paneId: '%1' } })).rejects.toThrow('ENOSPC')
  })
})

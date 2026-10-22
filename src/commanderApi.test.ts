import { describe, expect, it, vi } from 'vitest'
import { createCommanderApi } from './commanderApi'

describe('Commander owner API', () => {
  it('creates Commander with owner authentication', async () => {
    const state = { targetId: 'commander', paneId: '%1', sessionId: '$1' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, state }))
    expect(await createCommanderApi('secret', fetcher).ensure()).toEqual(state)
    expect(fetcher).toHaveBeenCalledWith('/api/commander', expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: expect.objectContaining({ Authorization: 'Bearer secret' }) }))
  })
  it('switches the Commander profile, with null for the default login', async () => {
    const state = { targetId: 'fresh', paneId: '%3', sessionId: '$3', configDir: '/h/.claudew' }
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, state }))
    const api = createCommanderApi('secret', fetcher)
    expect(await api.setProfile('/h/.claudew')).toEqual(state)
    await api.setProfile(null)
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['/api/commander/profile', 'PUT', JSON.stringify({ configDir: '/h/.claudew' })],
      ['/api/commander/profile', 'PUT', JSON.stringify({ configDir: null })],
    ])
  })
  it('always queues replies and supports cookie authentication', async () => {
    const relay = { id: 'relay', status: 'queued' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, relay }))
    expect(await createCommanderApi('', fetcher).relay('%2', 'Hello')).toEqual(relay)
    expect(fetcher).toHaveBeenCalledWith('/api/commander/relays', expect.objectContaining({ body: JSON.stringify({ paneId: '%2', text: 'Hello', delivery: 'queue' }), credentials: 'same-origin' }))
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization')
  })
  it('surfaces daemon errors and refused requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: 'Pane has gone' }, { status: 404 })).mockResolvedValueOnce(Response.json({ ok: false, error: 'Unavailable' })).mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
    const api = createCommanderApi('', fetcher)
    await expect(api.relay('%2', 'Hi')).rejects.toThrow('Pane has gone')
    await expect(api.ensure()).rejects.toThrow('Unavailable')
    await expect(api.ensure()).rejects.toThrow('502')
  })
})

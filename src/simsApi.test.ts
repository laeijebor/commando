// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createSimsApi } from './simsApi'

describe('simulator claim actions', () => {
  it('uses the existing authenticated open endpoint and propagates errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('{"error":"Simulator is not booted"}', { status: 404 }))
    const api = createSimsApi('owner-token', fetcher)
    await api.open('sim/udid')
    expect(fetcher).toHaveBeenCalledWith('/api/sims/sim%2Fudid/open', expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: { Authorization: 'Bearer owner-token' } }))
    await expect(api.open('sim/udid')).rejects.toThrow('Simulator is not booted')
  })

  it('builds an absolute tile URL through the API proxy, carrying query auth or browser cookies', () => {
    const url = new URL(createSimsApi('token/value &').viewUrl('sim/udid'))
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/api/sims/sim%2Fudid/view')
    expect(url.searchParams.get('token')).toBe('token/value &')
    expect(new URL(createSimsApi('').viewUrl('sim')).search).toBe('')
  })
})

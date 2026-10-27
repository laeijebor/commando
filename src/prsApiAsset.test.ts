// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createPrsApi } from './prsApi'

describe('prs api asset', () => {
  it('returns a cached data: URL fetched with the bearer token', async () => {
    const fetcher = vi.fn(async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }))
    const api = createPrsApi('tok', fetcher as unknown as typeof fetch)
    const src = 'https://github.com/user-attachments/assets/ae328c6b-f0ea-4b47-8b77-ad5ae9424e6f'
    expect(await api.asset(src)).toBe(`data:image/svg+xml;base64,${btoa('<svg/>')}`)
    await api.asset(src)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(`/api/prs/asset?url=${encodeURIComponent(src)}`, expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }))
  })

  it('forgets a failed download so the next render retries', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('x', { headers: { 'Content-Type': 'image/png' } }))
    const api = createPrsApi('tok', fetcher as unknown as typeof fetch)
    const src = 'https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001'
    await expect(api.asset(src)).rejects.toThrow('502')
    await expect(api.asset(src)).resolves.toMatch(/^data:image\/png;base64,/)
  })
})

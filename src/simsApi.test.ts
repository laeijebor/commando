// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { cacheSims, createSimsApi, readCachedSims, simsCache } from './simsApi'

describe('simulator claim actions', () => {
  it('hydrates ended history and legacy listings while ignoring malformed ended metadata', () => {
    const sim = { udid: 'sim', name: 'Phone', deviceModel: 'iPhone', runtime: 'iOS 26', slim: 'slim', lease: null }
    const endedLease = { sessionName: 'Previous', task: '', label: 'Previous', endedAt: 123, reason: 'released' }
    for (const listing of [[sim], [{ ...sim, endedLease }]]) {
      simsCache.listing = undefined
      window.localStorage.setItem('commando.sims-listing', JSON.stringify(listing))
      expect(readCachedSims()).toEqual(listing)
    }
    for (const invalid of ['bad', { ...endedLease, endedAt: '123' }, { ...endedLease, reason: 'bad' }, { ...endedLease, task: null }]) {
      simsCache.listing = undefined
      window.localStorage.setItem('commando.sims-listing', JSON.stringify([{ ...sim, endedLease: invalid }]))
      expect(readCachedSims()).toBeUndefined()
    }
    simsCache.listing = undefined
    window.localStorage.clear()
  })

  it('persists pool summaries and chip flags, while reading older cached arrays without pool metadata', async () => {
    const sim = { udid: 'sim', name: 'Phone', deviceModel: 'iPhone', runtime: 'iOS 26', slim: 'slim' as const, lease: null, pool: true }
    const pool = { size: 6, free: 4 }
    cacheSims([sim], pool)
    simsCache.listing = undefined; simsCache.pool = undefined
    expect(readCachedSims()).toEqual([sim])
    expect(simsCache.pool).toEqual(pool)
    simsCache.listing = undefined
    window.localStorage.setItem('commando.sims-listing', JSON.stringify([sim]))
    expect(readCachedSims()).toEqual([sim])
    expect(simsCache.pool).toBeUndefined()
    const api = createSimsApi('', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ sims: [sim], pool, stale: true }))))
    expect(await api.listing()).toEqual({ sims: [sim], pool, stale: true })
    simsCache.listing = undefined; simsCache.pool = undefined
    window.localStorage.clear()
  })

  it('carries the server capture timestamp with the JPEG and preserves the live view Blob method', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('jpeg', { headers: { 'X-Commando-Snapshot-At': '12345' } }))
    const api = createSimsApi('token', fetcher)
    const signal = new AbortController().signal
    const frame = await api.snapshotFrame('sim/udid', signal)
    expect(frame.at).toBe(12345)
    expect(frame.blob.size).toBe(4)
    expect(fetcher).toHaveBeenCalledWith('/api/sims/sim%2Fudid/snapshot.jpg', expect.objectContaining({ signal, headers: { Authorization: 'Bearer token' } }))
    expect((await api.snapshot('sim/udid', signal)).size).toBe(4)
  })

  it('uses the existing authenticated open endpoint and propagates errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"ok":true,"raised":false,"reason":"No window matched"}'))
      .mockResolvedValueOnce(new Response('{"error":"Simulator is not booted"}', { status: 404 }))
    const api = createSimsApi('owner-token', fetcher)
    await expect(api.open('sim/udid')).resolves.toEqual({ ok: true, raised: false, reason: 'No window matched' })
    expect(fetcher).toHaveBeenCalledWith('/api/sims/sim%2Fudid/open', expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: { Authorization: 'Bearer owner-token' } }))
    await expect(api.open('sim/udid')).rejects.toThrow('Simulator is not booted')
  })

  it('opens built-in content with session auth and no token or URL in the persisted body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"webPaneId":"w-12345678"}'))
      .mockResolvedValueOnce(new Response('{"error":"Invalid simulator content"}', { status: 400 }))
    const api = createSimsApi('token/value &', fetcher)
    await expect(api.show('sim-udid', '%1')).resolves.toEqual({ webPaneId: 'w-12345678' })
    expect(fetcher).toHaveBeenCalledWith('/api/web-panes', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token/value &' },
      body: JSON.stringify({ content: { kind: 'simulator', udid: 'sim-udid' }, anchor: '%1' }),
    }))
    await expect(api.show('bad', '%1')).rejects.toThrow('Invalid simulator content')
  })
})

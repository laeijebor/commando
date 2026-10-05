// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { cacheSims, createSimsApi, readCachedSims, simsCache } from './simsApi'

describe('simulator claim actions', () => {
  it('fetches both inspector layers with device points, auth, encoding and cancellation', async () => {
    const element = { role: 'AXButton', label: 'General', identifier: 'general', value: null, title: null, frame: { x: 1, y: 2, width: 3, height: 4 } }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, element })))
      .mockResolvedValueOnce(new Response('{"ok":false,"reason":"no-metro-port"}'))
      .mockResolvedValueOnce(new Response('{"error":"Invalid coordinates"}', { status: 400 }))
    const signal = new AbortController().signal, api = createSimsApi('owner', fetcher)
    await expect(api.inspect('sim/udid', 1.5, 2, signal)).resolves.toEqual({ ok: true, element })
    await expect(api.inspectSource('sim/udid', 1.5, 2, signal)).resolves.toEqual({ ok: false, reason: 'no-metro-port' })
    for (const path of ['inspect', 'inspect/source']) expect(fetcher).toHaveBeenCalledWith(`/api/sims/sim%2Fudid/${path}?x=1.5&y=2`, expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal, headers: { Authorization: 'Bearer owner' },
    }))
    await expect(api.inspect('sim', -1, 2)).rejects.toThrow('Invalid coordinates')
  })

  it('sends orientation actions through the authenticated client', async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}'))
    await createSimsApi('owner', fetcher).action('sim/udid', { action: 'orientation', value: 'landscape-left' })
    expect(fetcher).toHaveBeenCalledWith('/api/sims/sim%2Fudid/action', expect.objectContaining({
      method: 'POST', body: '{"action":"orientation","value":"landscape-left"}', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    }))
  })
  it('sends authenticated action JSON, encodes the UDID and fetches schemes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"ok":true,"value":"dark"}'))
      .mockResolvedValueOnce(new Response('{"schemes":["myapp","https"]}'))
      .mockResolvedValueOnce(new Response('{"error":"baguette failed: input unavailable"}', { status: 500 }))
    const api = createSimsApi('owner-token', fetcher)
    const body = { action: 'appearance', value: 'toggle' } as const
    await expect(api.action('sim/udid', body)).resolves.toEqual({ ok: true, value: 'dark' })
    expect(fetcher).toHaveBeenCalledWith('/api/sims/sim%2Fudid/action', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(body),
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
    }))
    await expect(api.schemes('sim/udid')).resolves.toEqual(['myapp', 'https'])
    expect(fetcher).toHaveBeenCalledWith('/api/sims/sim%2Fudid/schemes', expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer owner-token' } }))
    await expect(api.action('sim/udid', { action: 'shake' })).rejects.toThrow('input unavailable')
  })

  it('supports session auth without a bearer token and propagates schemes errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"ok":true}'))
      .mockResolvedValueOnce(new Response('{"error":"Simulator is not booted"}', { status: 404 }))
    const api = createSimsApi('', fetcher)
    await api.action('sim', { action: 'shake' })
    expect(fetcher).toHaveBeenCalledWith('/api/sims/sim/action', expect.objectContaining({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }))
    await expect(api.schemes('sim')).rejects.toThrow('Simulator is not booted')
  })

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
    const sim = { udid: 'sim', name: 'Phone', deviceModel: 'iPhone', runtime: 'iOS 26', slim: 'slim' as const, lease: null, pool: true, poolProjects: ['gizmo', 'commando'] }
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

describe('installed apps and privacy API', () => {
  it('fetches installed apps with auth and cancellation and posts privacy actions', async () => {
    const apps = [{ bundleId: 'com.example.app', name: 'Example', type: 'user' }]
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ apps })))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
      .mockResolvedValueOnce(new Response('{"error":"listapps failed"}', { status: 500 }))
    const signal = new AbortController().signal, api = createSimsApi('owner', fetcher)
    await expect(api.apps('sim/udid', signal)).resolves.toEqual(apps)
    expect(fetcher).toHaveBeenCalledWith('/api/sims/sim%2Fudid/apps', expect.objectContaining({ method: 'GET', signal, headers: { Authorization: 'Bearer owner' } }))
    const body = { action: 'privacy', operation: 'revoke', service: 'photos', bundleId: 'com.example.app' } as const
    await api.action('sim/udid', body)
    expect(fetcher).toHaveBeenLastCalledWith('/api/sims/sim%2Fudid/action', expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }))
    await expect(api.apps('sim')).rejects.toThrow('listapps failed')
  })
})

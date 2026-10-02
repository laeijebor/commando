// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createSimsApi } from './simsApi'

describe('simulator claim actions', () => {
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

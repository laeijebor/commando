import { beforeEach, describe, expect, it, vi } from 'vitest'
import { socketState as state, resetSocketState } from './board-pinned-socket-test-fixture.js'
vi.mock('node:http', async () => ({ request: (await import('./board-pinned-socket-test-fixture.js')).stubPinnedRequest }))
vi.mock('node:https', async () => ({ request: (await import('./board-pinned-socket-test-fixture.js')).stubPinnedRequest }))
import { fetchCaptureRequest } from './board-capture-network.js'
import { registerBrowserDebuggingPort } from './board-capture-policy.js'

beforeEach(resetSocketState)
describe('pinned capture transport (stub sockets)', () => {
  it.each(['http:', 'https:'])('uses a fresh %s socket and the second approved address when the same host changes policy', async (protocol) => {
    const request = { url: `${protocol}//rebind.example/app` }, signal = new AbortController().signal
    await fetchCaptureRequest(request, { address: '10.0.0.8', family: 4 }, signal)
    await fetchCaptureRequest(request, { address: '93.184.216.34', family: 4 }, signal)
    expect(state.calls.every((call) => call.options.agent === false)).toBe(true)
    expect(state.calls.map((call) => call.lookupAddress)).toEqual(['10.0.0.8', '93.184.216.34'])
    expect(state.sockets).toHaveLength(2)
    expect(state.calls[1].socket).not.toBe(state.calls[0].socket)
    expect(state.calls[1].socket?.remoteAddress).toBe('93.184.216.34')
  })
  it.each([false, true])('aborts a mismatched peer before sending HTTP bytes (already connected: %s)', async (connected) => {
    state.remoteAddress = '10.0.0.8'; state.alreadyConnected = connected
    await expect(fetchCaptureRequest({ url: 'https://rebind.example/app' }, { address: '93.184.216.34', family: 4 }, new AbortController().signal)).rejects.toThrow('unapproved address')
    expect(state.calls[0].sent).toBe(false)
    expect(state.calls[0].socket?.destroyed).toBe(true)
  })
  it.each([
    ['93.184.216.34', '::ffff:93.184.216.34', 4],
    ['2606:4700:0:0:0:0:0:1111', '2606:4700::1111', 6],
  ] as const)('accepts equivalent IP representations for %s', async (approved, peer, family) => {
    state.remoteAddress = peer
    expect(await fetchCaptureRequest({ url: 'https://public.example/app' }, { address: approved, family }, new AbortController().signal)).toMatchObject({ status: 302 })
  })
  it('rejects newly registered debugging ports again at transport dispatch without opening a socket', async () => {
    let exit!: () => void
    registerBrowserDebuggingPort(9556, new Promise<void>((resolve) => { exit = resolve }))
    try {
      await expect(fetchCaptureRequest({ url: 'http://127.0.0.1:9556/json/version' }, { address: '127.0.0.1', family: 4 }, new AbortController().signal)).rejects.toThrow('debugging')
      expect(state.calls).toHaveLength(0)
    } finally { exit(); await Promise.resolve() }
  })
  it('keeps the original TLS host, pins lookup, preserves redirects without following them, and bounds headers/body', async () => {
    const address = { address: '93.184.216.34', family: 4 }
    const response = await fetchCaptureRequest({ url: 'https://public.example/app', method: 'POST', headers: { Host: 'spoofed', Connection: 'keep-alive', Cookie: 'capture-only=1' }, postData: 'body' }, address, new AbortController().signal)
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0].url.hostname).toBe('public.example')
    expect(state.calls[0]).toMatchObject({ body: 'body', options: { method: 'POST', headers: { Cookie: 'capture-only=1', 'accept-encoding': 'identity' } } })
    const lookup = state.calls[0].options.lookup as (host: string, opts: { all: boolean }, cb: ReturnType<typeof vi.fn>) => void
    const callback = vi.fn(); lookup('public.example', { all: true }, callback)
    expect(callback).toHaveBeenCalledWith(null, [address])
    expect(response).toMatchObject({ status: 302, headers: [{ name: 'Location', value: '/next' }], body: Buffer.from('page') })
  })
  it('fails oversized requests/responses without real Chromium, DNS or sockets', async () => {
    const address = { address: '93.184.216.34', family: 4 }, signal = new AbortController().signal
    await expect(fetchCaptureRequest({ url: 'https://public.example/', hasPostData: true }, address, signal)).rejects.toThrow('request body')
    expect(state.calls).toHaveLength(0)
    state.body = Buffer.alloc(20 * 1024 * 1024 + 1)
    await expect(fetchCaptureRequest({ url: 'https://public.example/' }, address, signal)).rejects.toThrow('20 MiB')
  })
})

import { claimPairing, EXPIRED_CODE, pairingLinkFromParams, parsePairingLink, UNREACHABLE } from './client'
const code = 'a'.repeat(32)
const token = 't'.repeat(43)
const urls = ['http://studio.tail.ts.net:4310', 'http://100.64.0.1:4310']
const link = { code, urls, name: 'Studio Mac' }
const response = (status: number, value: unknown = {}) => new Response(JSON.stringify(value), { status })
const fetchMock = globalThis.fetch as jest.Mock
beforeEach(() => { fetchMock.mockReset() })

it('parses versioned QR links and repeated, already-decoded Expo route params', () => {
  const url = new URL('commando://pair')
  url.searchParams.set('v', '1')
  url.searchParams.set('c', code)
  for (const entry of urls) url.searchParams.append('u', entry)
  url.searchParams.set('n', link.name)
  expect(parsePairingLink(url.toString())).toEqual(link)
  expect(pairingLinkFromParams({ v: '1', c: code, u: urls, n: link.name })).toEqual(link)
})
it.each([
  'https://example.com/pair?v=1',
  'commando://other?v=1',
  `commando://pair?v=2&c=${code}&u=${urls[0]}`,
  `commando://pair?v=1&c=weak&u=${urls[0]}`,
  `commando://pair?v=1&c=${code}&u=javascript:alert(1)`,
  `commando://pair?v=1&c=${code}&u=http://user:password@studio:4310`,
  `commando://pair?v=1&c=${code}&u=http://studio:4310/api`,
  `commando://pair?v=1&c=${code}&c=${code}&u=${urls[0]}`,
])('rejects malformed/untrusted link shapes before any network request: %s', (raw) => {
  expect(() => parsePairingLink(raw)).toThrow('not a Commando pairing code')
  expect(fetchMock).not.toHaveBeenCalled()
})
it('tries URLs in order, skips untrusted Host 403, treats private health 401 as reachable, and claims without credentials', async () => {
  fetchMock.mockResolvedValueOnce(response(403)).mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200, { token, deviceId: 'device', name: 'Mac' }))
  const trying = jest.fn()
  expect(await claimPairing(link, 'iPhone', 'ios', trying)).toEqual({ token, deviceId: 'device', name: 'Mac', baseUrl: urls[1] })
  expect(trying.mock.calls).toEqual(urls.map((url) => [url]))
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${urls[0]}/api/health`, `${urls[1]}/api/health`, `${urls[1]}/api/pairing/claim`])
  expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error', body: JSON.stringify({ code, deviceName: 'iPhone', platform: 'ios' }) })
  expect(fetchMock.mock.calls[2]?.[1].headers.Authorization).toBeUndefined()
})
it('never claims on an unreachable host and explains Tailscale', async () => {
  fetchMock.mockRejectedValue(new Error('offline'))
  await expect(claimPairing(link, 'iPhone', 'ios')).rejects.toThrow(UNREACHABLE)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
it('does not retry a single-use claim against another address after expiry or network loss', async () => {
  fetchMock.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(401))
  await expect(claimPairing(link, 'iPhone', 'ios')).rejects.toThrow(EXPIRED_CODE)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  fetchMock.mockReset().mockResolvedValueOnce(response(401)).mockRejectedValueOnce(new Error('lost response'))
  await expect(claimPairing(link, 'iPhone', 'ios')).rejects.toThrow('new code')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
it('aborts a slow health probe, then falls back to the next URL', async () => {
  jest.useFakeTimers()
  try {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timeout')))))
      .mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200, { token, deviceId: 'device', name: 'Mac' }))
    const pending = claimPairing(link, 'iPhone', 'ios')
    await jest.advanceTimersByTimeAsync(3001)
    expect((await pending).baseUrl).toBe(urls[1])
  } finally { jest.useRealTimers() }
})

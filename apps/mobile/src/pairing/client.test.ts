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
const claimed = () => response(200, { token, deviceId: 'device', name: 'Mac' })
const reachable = (claim: () => Promise<Response> | Response = claimed) => {
  fetchMock.mockImplementation((url: string) => url.endsWith('/api/health') ? Promise.resolve(response(401)) : Promise.resolve().then(claim))
}

it('probes in parallel, skips untrusted Host 403, and claims without credentials on the chosen URL', async () => {
  fetchMock.mockResolvedValueOnce(response(403)).mockResolvedValueOnce(response(401)).mockResolvedValueOnce(claimed())
  const trying = jest.fn()
  expect(await claimPairing(link, 'iPhone', 'ios', trying)).toEqual({ token, deviceId: 'device', name: 'Mac', baseUrl: urls[1] })
  expect(trying.mock.calls).toEqual([[urls[1]]])
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
  reachable(() => response(401))
  await expect(claimPairing(link, 'iPhone', 'ios')).rejects.toThrow(EXPIRED_CODE)
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/claim'))).toHaveLength(1)
  fetchMock.mockReset()
  reachable(() => Promise.reject(new Error('lost response')))
  await expect(claimPairing(link, 'iPhone', 'ios')).rejects.toThrow('new code')
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/claim'))).toHaveLength(1)
})
it('uses a reachable IP after 400ms without waiting for hanging MagicDNS and aborts its probe', async () => {
  jest.useFakeTimers()
  try {
    let dnsSignal: AbortSignal | undefined
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === `${urls[0]}/api/health`) { dnsSignal = init.signal ?? undefined; return new Promise(() => undefined) }
      return Promise.resolve(url.endsWith('/api/health') ? response(401) : claimed())
    })
    const pending = claimPairing(link, 'iPhone', 'ios')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(urls.map((url) => `${url}/api/health`))
    await jest.advanceTimersByTimeAsync(399)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(1)
    expect((await pending).baseUrl).toBe(urls[1])
    expect(dnsSignal?.aborted).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  } finally { jest.useRealTimers() }
})
it('prefers an earlier URL that responds within the grace window', async () => {
  jest.useFakeTimers()
  try {
    fetchMock.mockImplementation((url: string) => {
      if (url === `${urls[0]}/api/health`) return new Promise((resolve) => setTimeout(() => resolve(response(401)), 250))
      return Promise.resolve(url.endsWith('/api/health') ? response(401) : claimed())
    })
    const pending = claimPairing(link, 'iPhone', 'ios')
    await jest.advanceTimersByTimeAsync(249)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(1)
    expect((await pending).baseUrl).toBe(urls[0])
    expect(jest.getTimerCount()).toBe(0)
  } finally { jest.useRealTimers() }
})
it('ignores a preferred URL arriving after the grace window and claims only once', async () => {
  jest.useFakeTimers()
  try {
    let finishDns!: (response: Response) => void
    fetchMock.mockImplementation((url: string) => {
      if (url === `${urls[0]}/api/health`) return new Promise<Response>((resolve) => { finishDns = resolve })
      return Promise.resolve(url.endsWith('/api/health') ? response(401) : claimed())
    })
    const pending = claimPairing(link, 'iPhone', 'ios')
    await jest.advanceTimersByTimeAsync(400)
    expect((await pending).baseUrl).toBe(urls[1])
    finishDns(response(401))
    await jest.advanceTimersByTimeAsync(0)
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/claim'))).toHaveLength(1)
  } finally { jest.useRealTimers() }
})
it('times out all unreachable probes concurrently and cancels each request', async () => {
  jest.useFakeTimers()
  try {
    const signals: AbortSignal[] = []
    fetchMock.mockImplementation((_url: string, init: RequestInit) => { signals.push(init.signal!); return new Promise(() => undefined) })
    const rejected = expect(claimPairing(link, 'iPhone', 'ios')).rejects.toThrow(UNREACHABLE)
    await jest.advanceTimersByTimeAsync(3000)
    await rejected
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  } finally { jest.useRealTimers() }
})
it('names ATS errors instead of suggesting that Tailscale is off', async () => {
  fetchMock.mockRejectedValue(Object.assign(new Error('App Transport Security requires a secure connection'), { code: -1022 }))
  await expect(claimPairing(link, 'iPhone', 'ios')).rejects.toThrow('App Transport Security')
})
it('bounds a stalled claim body after successful headers', async () => {
  jest.useFakeTimers()
  try {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.endsWith('/api/health') ? response(401) : { status: 200, ok: true, text: () => new Promise(() => undefined) }))
    const rejected = expect(claimPairing(link, 'iPhone', 'ios')).rejects.toThrow('new code')
    await jest.advanceTimersByTimeAsync(3001)
    await rejected
  } finally { jest.useRealTimers() }
})
it('cancels all parallel probes without claiming', async () => {
  const controller = new AbortController()
  const signals: AbortSignal[] = []
  fetchMock.mockImplementation((_url: string, init: RequestInit) => { signals.push(init.signal!); return new Promise(() => undefined) })
  const rejected = expect(claimPairing(link, 'iPhone', 'ios', undefined, controller.signal)).rejects.toThrow('Pairing cancelled')
  controller.abort()
  await rejected
  expect(signals).toHaveLength(2)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
it('cancels a stalled claim body without claiming another address', async () => {
  jest.useFakeTimers()
  try {
    const controller = new AbortController()
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.endsWith('/api/health') ? response(401) : { status: 200, ok: true, text: () => new Promise(() => undefined) }))
    const rejected = expect(claimPairing(link, 'iPhone', 'ios', undefined, controller.signal)).rejects.toThrow('Pairing cancelled')
    await jest.advanceTimersByTimeAsync(0)
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/claim'))).toHaveLength(1)
    controller.abort()
    await rejected
    expect(jest.getTimerCount()).toBe(0)
  } finally { jest.useRealTimers() }
})

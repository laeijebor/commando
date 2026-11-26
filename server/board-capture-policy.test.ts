import { describe, expect, it, vi } from 'vitest'
import { CaptureRequestPolicy, registerBrowserDebuggingPort, resolveCaptureDestination, type CaptureResolver } from './board-capture-policy.js'

const publicAnswer = [{ address: '93.184.216.34', family: 4 }]
describe('Board capture destination policy', () => {
  it('always denies link-local destinations, including DNS aliases and mapped IPv4, even with own-origin private authority', async () => {
    for (const host of ['169.254.0.1', '169.254.169.254', '[fe80::1]', '[febf::1]', '[::ffff:169.254.169.254]']) {
      const url = `http://${host}:5273/app`
      await expect(resolveCaptureDestination(url)).rejects.toThrow('link-local')
      const policy = new CaptureRequestPolicy({ url, origin: new URL(url).origin, policy: 'private', addresses: [{ address: host.replace(/[\[\]]/g, ''), family: host.startsWith('[') ? 6 : 4 }] }, [], [])
      await expect(policy.address(url)).rejects.toThrow('link-local')
    }
    await expect(resolveCaptureDestination('http://metadata.internal/', async () => [{ address: '169.254.169.254', family: 4 }])).rejects.toThrow('link-local')
    for (const host of ['127.0.0.1', '[::1]', '10.0.0.8', '172.16.0.1', '192.168.1.2']) {
      const d = await resolveCaptureDestination(`http://${host}:5273/app`)
      expect(await new CaptureRequestPolicy(d, [], []).address(d.url)).toBeDefined()
    }
  })
  it('blocks debugging ports dynamically through process exit, with reference counts for shared port registrations', async () => {
    const d = await resolveCaptureDestination('http://127.0.0.1:9333/app'), policy = new CaptureRequestPolicy(d, [], [])
    let first!: () => void, second!: () => void
    registerBrowserDebuggingPort(9333, new Promise<void>((resolve) => { first = resolve }))
    registerBrowserDebuggingPort(9333, new Promise<void>((resolve) => { second = resolve }))
    await expect(policy.address(d.url)).rejects.toThrow('Blocked')
    await expect(resolveCaptureDestination('https://alias.example:9333/')).rejects.toThrow('debugging')
    first(); await Promise.resolve()
    await expect(policy.address(d.url)).rejects.toThrow('Blocked')
    second(); await Promise.resolve()
    expect(await policy.address(d.url)).toMatchObject({ address: '127.0.0.1' })
  })
  it('rechecks ports registered while a request DNS lookup was pending', async () => {
    const d = await resolveCaptureDestination('https://public.example/', async () => publicAnswer)
    let answer!: (addresses: typeof publicAnswer) => void, exit!: () => void
    const policy = new CaptureRequestPolicy(d, [], [], () => new Promise((resolve) => { answer = resolve }))
    const pending = policy.address('https://alias.example:9555/')
    const rejected = expect(pending).rejects.toThrow('Blocked')
    registerBrowserDebuggingPort(9555, new Promise<void>((resolve) => { exit = resolve }))
    try { answer(publicAnswer); await rejected } finally { exit(); await Promise.resolve() }
  })
  it('classifies private DNS aliases once and pins memoized answers for every resource', async () => {
    const resolve = vi.fn<CaptureResolver>(async (host) => host === 'dev.internal' ? [{ address: '10.0.0.8', family: 4 }] : publicAnswer)
    const destination = await resolveCaptureDestination('http://dev.internal:5273/app', resolve)
    expect(destination.policy).toBe('private')
    const policy = new CaptureRequestPolicy(destination, ['http://localhost:4310'], [4310], resolve)
    expect(await policy.address('http://dev.internal:5273/script.js')).toEqual({ address: '10.0.0.8', family: 4 })
    await policy.address('https://cdn.example/a'); await policy.address('https://cdn.example/b')
    expect(resolve.mock.calls.map(([host]) => host)).toEqual(['dev.internal', 'cdn.example'])
    await expect(policy.address('http://10.0.0.9:5273/')).rejects.toThrow('private')
    await expect(policy.address('http://dev.internal:5274/')).rejects.toThrow('private')
    await expect(policy.address('https://dev.internal:5273/')).rejects.toThrow('private')
  })
  it('never promotes public captures to private and rejects mixed or rebinding destinations', async () => {
    const resolve = vi.fn<CaptureResolver>(async () => publicAnswer)
    const destination = await resolveCaptureDestination('https://public.example/', resolve)
    resolve.mockResolvedValue([{ address: '10.0.0.1', family: 4 }])
    const policy = new CaptureRequestPolicy(destination, [], [4310], resolve)
    expect(await policy.address('https://public.example/redirect')).toEqual(publicAnswer[0])
    for (const url of ['http://localhost/', 'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'https://private-alias.example/']) await expect(policy.address(url)).rejects.toThrow(/private|link-local/)
    resolve.mockResolvedValue([...publicAnswer, { address: '10.0.0.1', family: 4 }])
    await expect(resolveCaptureDestination('http://mixed.example/', resolve)).rejects.toThrow('Mixed')
  })
  it('blocks control ports on all aliases, explicit daemon origins, auth, credentials and non-HTTP navigation', async () => {
    const destination = await resolveCaptureDestination('http://127.0.0.1:5273/')
    const policy = new CaptureRequestPolicy(destination, ['https://daemon.example'], [4310, 4491], async () => publicAnswer)
    for (const url of ['http://127.0.0.1:4310/', 'https://anything.example:4491/', 'https://daemon.example/path', 'http://127.0.0.1:5273/api/auth/bootstrap', 'http://127.0.0.1:5273/api/pairing/claim', 'http://127.0.0.1:5273/api/%61uth/bootstrap', 'http://u:p@127.0.0.1:5273/', 'file:///tmp/private', 'data:text/html,secret']) await expect(policy.address(url)).rejects.toThrow('Blocked')
  })
})

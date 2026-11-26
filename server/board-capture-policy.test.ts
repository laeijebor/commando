import { describe, expect, it, vi } from 'vitest'
import { CaptureRequestPolicy, resolveCaptureDestination, type CaptureResolver } from './board-capture-policy.js'

const publicAnswer = [{ address: '93.184.216.34', family: 4 }]
describe('Board capture destination policy', () => {
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
    for (const url of ['http://localhost/', 'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'https://private-alias.example/']) await expect(policy.address(url)).rejects.toThrow('private')
    resolve.mockResolvedValue([...publicAnswer, { address: '10.0.0.1', family: 4 }])
    await expect(resolveCaptureDestination('http://mixed.example/', resolve)).rejects.toThrow('Mixed')
  })
  it('blocks control ports on all aliases, explicit daemon origins, auth, credentials and non-HTTP navigation', async () => {
    const destination = await resolveCaptureDestination('http://127.0.0.1:5273/')
    const policy = new CaptureRequestPolicy(destination, ['https://daemon.example'], [4310, 4491], async () => publicAnswer)
    for (const url of ['http://127.0.0.1:4310/', 'https://anything.example:4491/', 'https://daemon.example/path', 'http://127.0.0.1:5273/api/auth/bootstrap', 'http://127.0.0.1:5273/api/pairing/claim', 'http://127.0.0.1:5273/api/%61uth/bootstrap', 'http://u:p@127.0.0.1:5273/', 'file:///tmp/private', 'data:text/html,secret']) await expect(policy.address(url)).rejects.toThrow('Blocked')
  })
})

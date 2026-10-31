import { type lookup, type LookupAddress, type LookupAllOptions } from 'node:dns'
import { type LookupFunction } from 'node:net'
import { expect, it, vi } from 'vitest'
import { createHostLookup, hostLookupFor } from './hosts-transport.js'

function stubLookup(addresses: LookupAddress[], error: NodeJS.ErrnoException | null = null) {
  return vi.fn((_hostname: string, _options: LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => callback(error, addresses))
}
function resolveWith(hook: LookupFunction, all = false) {
  return new Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }>((resolve) => {
    hook('hub.tailnet.ts.net', { all }, (error, address, family) => resolve({ error, address, family }))
  })
}

it.each([
  { address: '127.0.0.1', family: 4 },
  { address: '::1', family: 6 },
  { address: '0:0:0:0:0:0:0:1', family: 6 },
  { address: '100.64.0.1', family: 4 },
  { address: '100.127.255.255', family: 4 },
  { address: 'fd7a:115c:a1e0::1', family: 6 },
])('passes the checked address directly to connect: $address', async (address) => {
  const stub = stubLookup([address])
  const hook = createHostLookup(stub as unknown as typeof lookup)
  expect(await resolveWith(hook)).toEqual({ error: null, address: address.address, family: address.family })
  expect(stub).toHaveBeenCalledWith('hub.tailnet.ts.net', { all: true }, expect.any(Function))
})

it.each(['8.8.8.8', '192.168.0.1', '169.254.169.254', '100.128.0.1', '2001:4860:4860::8888', 'fd7a:115c:a1e1::1', 'fe80::1%en0'])('rejects rebinding to %s', async (address) => {
  const stub = stubLookup([{ address, family: address.includes(':') ? 6 : 4 }])
  expect((await resolveWith(createHostLookup(stub as unknown as typeof lookup))).error?.code).toBe('EACCES')
})

it('supports all-address callers and rejects a mixed safe/unsafe DNS answer', async () => {
  const safe = [{ address: '100.64.0.1', family: 4 }, { address: 'fd7a:115c:a1e0::1', family: 6 }]
  expect(await resolveWith(createHostLookup(stubLookup(safe) as unknown as typeof lookup), true)).toMatchObject({ error: null, address: safe })
  const mixed = stubLookup([...safe, { address: '8.8.8.8', family: 4 }])
  expect((await resolveWith(createHostLookup(mixed as unknown as typeof lookup), true)).error?.code).toBe('EACCES')
})

it('fails closed on an empty result and propagates resolver errors', async () => {
  expect((await resolveWith(createHostLookup(stubLookup([]) as unknown as typeof lookup))).error?.code).toBe('EACCES')
  const error = Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' })
  expect((await resolveWith(createHostLookup(stubLookup([], error) as unknown as typeof lookup))).error).toBe(error)
})

it('installs the hook for MagicDNS HTTP(S) and WS(S) connections only', () => {
  for (const protocol of ['http', 'https', 'ws', 'wss']) expect(hostLookupFor(new URL(`${protocol}://hub.tailnet.ts.net`))).toBeTypeOf('function')
  for (const hostname of ['127.0.0.1', '[::1]', 'localhost']) expect(hostLookupFor(new URL(`http://${hostname}`))).toBeUndefined()
})

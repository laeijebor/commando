import { expect, it } from 'vitest'
import { pairingLink } from './pairingApi'
it('encodes a versioned deep link with repeated ordered URLs and an escaped daemon name', () => {
  const input = { code: 'a'.repeat(32), expiresAt: 123, urls: ['http://studio.tail.ts.net:4310', 'http://100.64.0.1:4310'], name: 'Studio & Mac', tailscaleEnabled: true }
  const url = new URL(pairingLink(input))
  expect(url.protocol).toBe('commando:')
  expect(url.hostname).toBe('pair')
  expect(url.searchParams.get('v')).toBe('1')
  expect(url.searchParams.get('c')).toBe(input.code)
  expect(url.searchParams.getAll('u')).toEqual(input.urls)
  expect(url.searchParams.get('n')).toBe(input.name)
  expect(url.searchParams.has('token')).toBe(false)
})

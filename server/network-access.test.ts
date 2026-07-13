import type { IncomingMessage } from 'node:http'
import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createNetworkAccess, isTailscaleAddress } from './network-access.js'

function request(options: {
  host: string
  origin?: string
  remoteAddress: string
}): IncomingMessage {
  return {
    headers: { host: options.host, origin: options.origin },
    socket: { remoteAddress: options.remoteAddress },
  } as IncomingMessage
}

const interfaces = {
  lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' }],
  utun8: [{ address: '100.101.102.103', netmask: '255.192.0.0', family: 'IPv4', mac: '', internal: false, cidr: '100.101.102.103/10' }],
} satisfies NodeJS.Dict<NetworkInterfaceInfo[]>

describe('Commando network access', () => {
  it('recognizes Tailscale IPv4, mapped IPv4, and IPv6 addresses', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true)
    expect(isTailscaleAddress('::ffff:100.127.255.254')).toBe(true)
    expect(isTailscaleAddress('fd7a:115c:a1e0::1234')).toBe(true)
    expect(isTailscaleAddress('100.128.0.1')).toBe(false)
    expect(isTailscaleAddress('192.168.1.2')).toBe(false)
  })

  it('defaults to loopback-only access', () => {
    const access = createNetworkAccess(4310, { allowTailscale: 'false', interfaces })
    expect(access.listeners).toEqual(['127.0.0.1'])
    expect(access.validRequest(request({ host: '127.0.0.1:4310', origin: 'http://127.0.0.1:5173', remoteAddress: '127.0.0.1' }))).toBe(true)
    expect(access.validRequest(request({ host: '127.0.0.1:4310', remoteAddress: '100.101.102.103' }))).toBe(false)
  })

  it('listens only on loopback and detected Tailscale addresses when enabled', () => {
    const access = createNetworkAccess(4310, {
      allowTailscale: 'true',
      interfaces,
      trustedOrigins: 'https://commando.example-tailnet.ts.net',
    })
    expect(access.listeners).toEqual(['127.0.0.1', '100.101.102.103'])
    expect(access.validRequest(request({ host: '100.101.102.103:4310', origin: 'http://100.101.102.103:4310', remoteAddress: '100.99.1.2' }))).toBe(true)
    expect(access.validRequest(request({ host: 'commando.example-tailnet.ts.net', origin: 'https://commando.example-tailnet.ts.net', remoteAddress: '100.99.1.2' }))).toBe(true)
    expect(access.validRequest(request({ host: '100.101.102.103:4310', origin: 'http://100.101.102.103:4310', remoteAddress: '192.168.1.2' }))).toBe(false)
  })

  it('fails closed when Tailscale is requested but unavailable', () => {
    expect(() => createNetworkAccess(4310, { allowTailscale: 'true', interfaces: {} })).toThrow('no Tailscale interface')
  })
})

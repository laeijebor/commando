import type { IncomingMessage } from 'node:http'
import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createNetworkAccess, isLocalClient, isLoopbackAddress, isTailscaleAddress } from './network-access.js'

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
  it('recognizes IPv4, mapped IPv4, and IPv6 loopback peers', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('100.99.1.2')).toBe(false)
  })

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

describe('isLocalClient', () => {
  const client = (remoteAddress: string, headers: Record<string, string | undefined>) =>
    ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage

  it('accepts a browser on this Mac, directly or through the Vite dev proxy', () => {
    expect(isLocalClient(client('127.0.0.1', { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' }))).toBe(true)
    expect(isLocalClient(client('::ffff:127.0.0.1', { host: 'localhost:5173', origin: 'http://localhost:5173' }))).toBe(true)
    expect(isLocalClient(client('::1', { host: '[::1]:4310' }))).toBe(true)
  })

  it('rejects remote peers and remote users a local proxy forwards', () => {
    expect(isLocalClient(client('100.101.102.104', { host: '100.101.102.103:4310', origin: 'http://100.101.102.103:4310' }))).toBe(false)
    // Tailscale Serve: loopback peer, public Host and Origin, forwarding headers.
    expect(isLocalClient(client('127.0.0.1', { host: 'machine.example-tailnet.ts.net', origin: 'https://machine.example-tailnet.ts.net', 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': 'ada@example.com' }))).toBe(false)
    expect(isLocalClient(client('127.0.0.1', { host: '127.0.0.1:4310', origin: 'https://machine.example-tailnet.ts.net' }))).toBe(false)
    expect(isLocalClient(client('127.0.0.1', { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310', 'x-forwarded-for': '100.64.0.9' }))).toBe(false)
    expect(isLocalClient(client('127.0.0.1', { host: '127.0.0.1:4310', origin: 'null' }))).toBe(false)
  })
})

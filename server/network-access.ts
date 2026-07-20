import type { IncomingMessage } from 'node:http'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export type NetworkAccess = {
  listeners: string[]
  trustedOrigins: string[]
  validRequest(request: IncomingMessage): boolean
}

type NetworkInterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>

function enabled(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true') return true
  throw new Error('COMMANDO_TAILSCALE must be true, false, 1, or 0')
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map(Number)
  return numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? numbers
    : null
}

export function isTailscaleAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '').split('%')[0]
  const ipv4 = ipv4Parts(normalized)
  if (ipv4) return ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127
  return normalized === 'fd7a:115c:a1e0::' || normalized.startsWith('fd7a:115c:a1e0:')
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.toLowerCase().replace(/^::ffff:/, '').split('%')[0]
  const ipv4 = ipv4Parts(normalized)
  return normalized === '::1' || (ipv4 !== null && ipv4[0] === 127)
}

function urlHostname(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

function parseOrigins(value: string | undefined): URL[] {
  if (!value?.trim()) return []
  return value.split(',').map((entry) => {
    const raw = entry.trim()
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error(`Invalid COMMANDO_TRUSTED_ORIGINS entry: ${raw}`)
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error(`Invalid COMMANDO_TRUSTED_ORIGINS entry: ${raw}`)
    }
    return url
  })
}

function tailscaleListeners(interfaces: NetworkInterfaceMap): string[] {
  const addresses = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal && isTailscaleAddress(entry.address)) addresses.add(entry.address)
    }
  }
  return [...addresses]
}

export function createNetworkAccess(
  port: number,
  options: {
    allowTailscale?: string
    trustedOrigins?: string
    interfaces?: NetworkInterfaceMap
  } = {},
): NetworkAccess {
  const allowTailscale = enabled(options.allowTailscale ?? process.env.COMMANDO_TAILSCALE)
  const extraOrigins = parseOrigins(
    options.trustedOrigins ?? process.env.COMMANDO_TRUSTED_ORIGINS,
  )
  const tailAddresses = allowTailscale
    ? tailscaleListeners(options.interfaces ?? networkInterfaces())
    : []
  if (allowTailscale && tailAddresses.length === 0) {
    throw new Error('COMMANDO_TAILSCALE is enabled, but no Tailscale interface was found')
  }

  const listeners = ['127.0.0.1', ...tailAddresses]
  const tailHosts = new Set(tailAddresses.map((address) => address.toLowerCase()))
  const extraOriginValues = new Set(extraOrigins.map((url) => url.origin.toLowerCase()))
  const allowedHosts = new Set([
    ...LOOPBACK_HOSTS,
    ...tailAddresses.map((address) => address.toLowerCase()),
    ...extraOrigins.map((url) => url.hostname.toLowerCase()),
  ])
  const trustedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    ...tailAddresses.map((address) => `http://${urlHostname(address)}:${port}`),
    ...extraOrigins.map((url) => url.origin),
  ])

  const validHost = (request: IncomingMessage): boolean => {
    const host = request.headers.host
    if (!host || host.length > 255) return false
    try {
      const parsed = new URL(`http://${host}`)
      return (
        allowedHosts.has(parsed.hostname.toLowerCase()) &&
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.pathname === '/' &&
        parsed.search === '' &&
        parsed.hash === ''
      )
    } catch {
      return false
    }
  }

  const validOrigin = (request: IncomingMessage): boolean => {
    const origin = request.headers.origin
    if (origin === undefined) return true
    if (origin.length > 512) return false
    try {
      const parsed = new URL(origin)
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.pathname !== '/' ||
        parsed.search !== '' ||
        parsed.hash !== ''
      ) return false
      if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return true
      if (extraOriginValues.has(parsed.origin.toLowerCase())) return true
      return tailHosts.has(parsed.hostname.toLowerCase()) && parsed.port === String(port)
    } catch {
      return false
    }
  }

  return {
    listeners,
    trustedOrigins: [...trustedOrigins],
    validRequest: (request) => {
      const remoteAddress = request.socket.remoteAddress
      const trustedPeer = isLoopbackAddress(remoteAddress) || (
        allowTailscale && remoteAddress !== undefined && isTailscaleAddress(remoteAddress)
      )
      return trustedPeer && validHost(request) && validOrigin(request)
    },
  }
}

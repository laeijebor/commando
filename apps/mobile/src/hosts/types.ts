/** How the app proves it is the daemon's owner. */
export type HostAuth =
  | { kind: 'session' }
  | { kind: 'token'; token: string }

export type Host = {
  id: string
  name: string
  /** Absolute origin of the daemon, e.g. `http://studio.tail-1a2b.ts.net:4310`. */
  baseUrl: string
  auth: HostAuth
}

export type HostReachability = {
  state: 'unknown' | 'checking' | 'online' | 'unauthorized' | 'offline'
  checkedAt?: number
  message?: string
  sessions?: number
}

/** Shape of `GET /api/auth/bootstrap` on the daemon. */
export type AuthBootstrap = {
  enabled: boolean
  needsOwner: boolean
  ownerEmail: string | null
}

export function normaliseBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Enter the daemon address')
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    throw new Error('The daemon speaks http or https only')
  }
  const withScheme = scheme ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`${input} is not a valid address`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The daemon speaks http or https only')
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '4310')
  return `${url.protocol}//${url.hostname}:${port}`
}

/** `http://host:4310` → `ws://host:4310`, keeping TLS when the host uses it. */
export function webSocketBase(baseUrl: string): string {
  if (/^https:/i.test(baseUrl)) return baseUrl.replace(/^https:/i, 'wss:')
  return baseUrl.replace(/^http:/i, 'ws:')
}

export function hostLabel(host: Host): string {
  try {
    const url = new URL(host.baseUrl)
    return `${url.hostname} · ${url.port}`
  } catch {
    return host.baseUrl
  }
}

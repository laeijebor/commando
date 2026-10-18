import type { PairingClaimRequest, PairingClaimResponse } from '@commando/pairing'

export type PairingLink = { code: string; urls: string[]; name: string }
const INVALID_LINK = 'This is not a Commando pairing code. Scan the code shown in Pair a phone on your Mac.'
export const EXPIRED_CODE = 'Ask your Mac for a new code. This code has expired or was already used.'
export const UNREACHABLE = 'Make sure Tailscale is on for this phone and the Mac, and the daemon uses COMMANDO_TAILSCALE=true.'

export function parsePairingLink(raw: string): PairingLink {
  if (raw.length > 8192) throw new Error(INVALID_LINK)
  let link: URL
  try { link = new URL(raw) } catch { throw new Error(INVALID_LINK) }
  if (link.protocol !== 'commando:' || link.hostname !== 'pair' || (link.pathname !== '' && link.pathname !== '/') ||
    link.username || link.password || link.port || link.hash || link.searchParams.getAll('v').length !== 1 || link.searchParams.get('v') !== '1') throw new Error(INVALID_LINK)
  const code = link.searchParams.get('c')
  const urls = link.searchParams.getAll('u')
  const name = link.searchParams.get('n')?.trim() || 'your Mac'
  if (!code || !/^[A-Za-z0-9_-]{22,128}$/.test(code) || link.searchParams.getAll('c').length !== 1 || !urls.length || urls.length > 5 || name.length > 160) throw new Error(INVALID_LINK)
  const origins = urls.map((raw) => {
    let url: URL
    try { url = new URL(raw) } catch { throw new Error(INVALID_LINK) }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(INVALID_LINK)
    return url.origin
  })
  return { code, urls: [...new Set(origins)], name }
}

/** expo-router has already decoded query values; preserve repeated `u` parameters. */
export function pairingLinkFromParams(params: Record<string, string | string[] | undefined>): PairingLink {
  const url = new URL('commando://pair')
  for (const key of ['v', 'c', 'u', 'n']) {
    const value = params[key]
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) url.searchParams.append(key, entry)
  }
  return parsePairingLink(url.toString())
}

async function pairingFetch(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    return await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal, credentials: 'omit', redirect: 'error' })
  } finally { clearTimeout(timer) }
}

export async function claimPairing(link: PairingLink, deviceName: string, platform: PairingClaimRequest['platform'], onTrying?: (url: string) => void): Promise<PairingClaimResponse & { baseUrl: string }> {
  let baseUrl: string | undefined
  for (const url of link.urls) {
    onTrying?.(url)
    try {
      const health = await pairingFetch(url, '/api/health')
      // Health stays private; 401 proves the daemon is reachable without widening auth.
      if (health.ok || health.status === 401) { baseUrl = url; break }
    } catch { /* try the next advertised address */ }
  }
  if (!baseUrl) throw new Error(UNREACHABLE)
  let response: Response
  try {
    const body: PairingClaimRequest = { code: link.code, deviceName, platform }
    response = await pairingFetch(baseUrl, '/api/pairing/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
  } catch { throw new Error(`${UNREACHABLE} If pairing already completed, ask your Mac for a new code.`) }
  if (response.status === 401) throw new Error(EXPIRED_CODE)
  if (response.status === 429) throw new Error('Too many attempts. Wait a minute, then ask your Mac for a new code.')
  if (!response.ok) throw new Error('Pairing failed. Ask your Mac for a new code and try again.')
  const result = await response.json() as Partial<PairingClaimResponse>
  if (typeof result.deviceId !== 'string' || typeof result.name !== 'string' || typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(result.token)) throw new Error('The daemon returned an invalid pairing response.')
  return { deviceId: result.deviceId, token: result.token, name: result.name, baseUrl }
}

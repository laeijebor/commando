import { ATS_BLOCKED, isAtsError } from '../hosts/networkErrors'
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

function cancelled(): Error { const error = new Error('Pairing cancelled'); error.name = 'AbortError'; return error }

/** The deadline covers headers AND body; the race also bounds native stalled reads. */
async function pairingFetch(baseUrl: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ status: number; ok: boolean; text: string }> {
  const controller = new AbortController()
  let rejectAbort: (error: Error) => void = () => undefined
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const abort = () => { controller.abort(); rejectAbort(cancelled()) }
  const timer = setTimeout(abort, 3000)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    return await Promise.race([aborted, (async () => {
      const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal, credentials: 'omit', redirect: 'error' })
      return { status: response.status, ok: response.ok, text: await response.text() }
    })()])
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

export async function claimPairing(link: PairingLink, deviceName: string, platform: PairingClaimRequest['platform'], onTrying?: (url: string) => void, signal?: AbortSignal): Promise<PairingClaimResponse & { baseUrl: string }> {
  let baseUrl: string | undefined
  let atsBlocked = false
  for (const url of link.urls) {
    if (signal?.aborted) throw cancelled()
    onTrying?.(url)
    try {
      const health = await pairingFetch(url, '/api/health', {}, signal)
      // Health stays private; 401 proves the daemon is reachable without widening auth.
      if (health.ok || health.status === 401) { baseUrl = url; break }
    } catch (error) {
      if (signal?.aborted) throw cancelled()
      atsBlocked ||= isAtsError(error)
    }
  }
  if (!baseUrl) throw new Error(atsBlocked ? ATS_BLOCKED : UNREACHABLE)
  let response: Awaited<ReturnType<typeof pairingFetch>>
  try {
    const body: PairingClaimRequest = { code: link.code, deviceName, platform }
    response = await pairingFetch(baseUrl, '/api/pairing/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }, signal)
  } catch (error) {
    if (signal?.aborted) throw cancelled()
    throw new Error(isAtsError(error) ? ATS_BLOCKED : `${UNREACHABLE} If pairing already completed, ask your Mac for a new code.`)
  }
  if (signal?.aborted) throw cancelled()
  if (response.status === 401) throw new Error(EXPIRED_CODE)
  if (response.status === 429) throw new Error('Too many attempts. Wait a minute, then ask your Mac for a new code.')
  if (!response.ok) throw new Error('Pairing failed. Ask your Mac for a new code and try again.')
  let result: Partial<PairingClaimResponse>
  try { result = JSON.parse(response.text) as Partial<PairingClaimResponse> } catch { throw new Error('The daemon returned an invalid pairing response.') }
  if (!result || typeof result.deviceId !== 'string' || typeof result.name !== 'string' || typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(result.token)) throw new Error('The daemon returned an invalid pairing response.')
  return { deviceId: result.deviceId, token: result.token, name: result.name, baseUrl }
}

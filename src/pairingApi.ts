import type { PairingCodeResponse, PairingDevicesResponse } from '../shared/pairing'

export function pairingLink(details: PairingCodeResponse): string {
  const link = new URL('commando://pair')
  link.searchParams.set('v', '1')
  link.searchParams.set('c', details.code)
  for (const url of details.urls) link.searchParams.append('u', url)
  link.searchParams.set('n', details.name)
  return link.toString()
}

async function request<T>(token: string, path: string, method = 'GET', signal?: AbortSignal): Promise<T> {
  const result = await fetch(`/api/pairing/${path}`, {
    method, signal, credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  if (!result.ok) throw new Error(result.status === 401 ? 'Sign in as the owner to manage paired phones.' : 'Could not update phone pairing. Try again.')
  return result.json() as Promise<T>
}
export const createPairingCode = (token: string, signal?: AbortSignal) => request<PairingCodeResponse>(token, 'codes', 'POST', signal)
export const listPairedDevices = (token: string, signal?: AbortSignal) => request<PairingDevicesResponse>(token, 'devices', 'GET', signal)
export const revokePairedDevice = (token: string, id: string) => request<{ ok: boolean }>(token, `devices/${encodeURIComponent(id)}`, 'DELETE')

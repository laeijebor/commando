import type { Host } from './types'
export const ACCESS_REVOKED = 'Access revoked — scan a new code'
const listeners = new Set<(host: Host) => void>()
export function onTokenRejected(listener: (host: Host) => void): void { listeners.add(listener) }
export function reportTokenRejected(host: Host): void {
  if (host.auth.kind === 'token') for (const listener of listeners) listener(host)
}

/** RN iOS still merges its shared cookie jar; its JS WebSocket API cannot disable it. */
export function socketAuthHeaders(host: Host, cookie?: string | null): Record<string, string> {
  if (host.auth.kind === 'token') return { Authorization: `Bearer ${host.auth.token}` }
  return cookie ? { Cookie: cookie } : {}
}

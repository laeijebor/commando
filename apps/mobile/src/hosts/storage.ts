import * as SecureStore from 'expo-secure-store'

import type { Host } from './types'

/**
 * Hosts carry automation tokens, so the whole list lives in the keychain
 * rather than in a plain preference store. SecureStore values are capped at a
 * couple of kilobytes per key on iOS, which a handful of hosts fits into
 * comfortably.
 */
export const HOSTS_STORAGE_KEY = 'commando.hosts'

function isHost(value: unknown): value is Host {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Host>
  if (typeof candidate.id !== 'string' || !candidate.id) return false
  if (typeof candidate.name !== 'string') return false
  if (typeof candidate.baseUrl !== 'string' || !candidate.baseUrl) return false
  const auth: unknown = candidate.auth
  if (typeof auth !== 'object' || auth === null) return false
  const kind = (auth as { kind?: unknown }).kind
  if (kind === 'session') return true
  return kind === 'token' && typeof (auth as { token?: unknown }).token === 'string'
}

export async function loadHosts(): Promise<Host[]> {
  let raw: string | null = null
  try {
    raw = await SecureStore.getItemAsync(HOSTS_STORAGE_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isHost)
  } catch {
    return []
  }
}

export async function saveHosts(hosts: readonly Host[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(HOSTS_STORAGE_KEY, JSON.stringify(hosts))
  } catch {
    // Losing the write is better than losing the running session; the list
    // still applies until the app is killed.
  }
}

export function createHostId(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `host-${Date.now().toString(36)}-${random}`
}

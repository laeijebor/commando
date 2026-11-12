import type { ClaudeProfile } from '../shared/tmux-create'

export const CLAUDE_PROFILES_STORAGE_KEY = 'commando.claude-profiles'

const remembered = new Map<string, ClaudeProfile[]>()

const storageKey = (host: string) => host === 'local' ? CLAUDE_PROFILES_STORAGE_KEY : `${CLAUDE_PROFILES_STORAGE_KEY}.${host}`

function isProfile(value: unknown): value is ClaudeProfile {
  if (!value || typeof value !== 'object') return false
  const { name, configDir, lastUsedAt, label, isDefault } = value as Partial<Record<keyof ClaudeProfile, unknown>>
  return typeof name === 'string' && typeof configDir === 'string'
    && (lastUsedAt === undefined || typeof lastUsedAt === 'number')
    && (label === undefined || typeof label === 'string') && (isDefault === undefined || typeof isDefault === 'boolean')
}

/** The host's Claude profiles from the last load (this page, else an earlier one), or null. */
export function cachedClaudeProfiles(host = 'local'): ClaudeProfile[] | null {
  const inMemory = remembered.get(host)
  if (inMemory) return inMemory
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(host)) ?? 'null') as unknown
    if (!Array.isArray(parsed) || !parsed.every(isProfile)) return null
    remembered.set(host, parsed)
    return parsed
  } catch {
    return null
  }
}

export function rememberClaudeProfiles(host: string, profiles: ClaudeProfile[]): void {
  remembered.set(host, profiles)
  try {
    window.localStorage.setItem(storageKey(host), JSON.stringify(profiles))
  } catch {
    // The in-memory copy still serves this page.
  }
}

/** Tests start each case without a remembered list. */
export function forgetClaudeProfiles(): void {
  remembered.clear()
}

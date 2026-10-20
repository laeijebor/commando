import { chatPermissionModes, type ChatLaunchProvider, type ChatPermissionMode } from '../shared/tmux-create'

export const CHAT_LAUNCH_STORAGE_KEY = 'commando.chat-launch.by-repo'
const LAST_KEY = '*'

/** How a chat pane is started: the Claude profile (login) and permission mode. */
export type ChatLaunchPreference = { configDir?: string; permissionMode: ChatPermissionMode }

const DEFAULT_PREFERENCE: ChatLaunchPreference = { permissionMode: 'default' }

function readAll(): Record<string, ChatLaunchPreference> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_LAUNCH_STORAGE_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, ChatLaunchPreference> : {}
  } catch {
    return {}
  }
}

/**
 * Claude keeps the bare keys it always had; other chats prefix theirs (`codex:`, `cursor:`, `muse2:`).
 * Muse's first keys (`muse:`) stored a sandboxed "approve everything" as bypassPermissions,
 * which now means full access, so those choices are left behind rather than reread.
 */
function storageKeys(repoKey: string | undefined, provider: ChatLaunchProvider): { key: string | undefined; lastKey: string } {
  if (provider === 'claude-chat') return { key: repoKey, lastKey: LAST_KEY }
  const prefix = provider === 'codex-chat' ? 'codex' : provider === 'cursor-chat' ? 'cursor' : 'muse2'
  return { key: `${prefix}:${repoKey ?? LAST_KEY}`, lastKey: `${prefix}:${LAST_KEY}` }
}

/** The preference remembered for a repository (or folder), else the last one used anywhere. */
export function loadChatLaunch(repoKey: string | undefined, provider: ChatLaunchProvider = 'claude-chat'): ChatLaunchPreference {
  const { key, lastKey } = storageKeys(repoKey, provider)
  const all = readAll()
  const stored = (key && all[key]) || all[lastKey]
  if (provider !== 'claude-chat') return { permissionMode: chatPermissionModes(provider).some((mode) => mode.value === stored?.permissionMode) ? stored.permissionMode : provider === 'cursor-chat' ? 'bypassPermissions' : 'default' }
  return stored && typeof stored === 'object' ? { ...DEFAULT_PREFERENCE, ...stored } : DEFAULT_PREFERENCE
}

export function saveChatLaunch(repoKey: string | undefined, preference: ChatLaunchPreference, provider: ChatLaunchProvider = 'claude-chat'): void {
  try {
    const all = readAll()
    const { key, lastKey } = storageKeys(repoKey, provider)
    const saved = provider === 'claude-chat' ? preference : { permissionMode: preference.permissionMode }
    if (key) all[key] = saved
    all[lastKey] = saved
    window.localStorage.setItem(CHAT_LAUNCH_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Remembering is a convenience; launching still works without storage.
  }
}

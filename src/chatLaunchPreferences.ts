import type { ChatPermissionMode } from '../shared/tmux-create'

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

/** The preference remembered for a repository (or folder), else the last one used anywhere. */
export function loadChatLaunch(repoKey: string | undefined): ChatLaunchPreference {
  const all = readAll()
  const stored = (repoKey && all[repoKey]) || all[LAST_KEY]
  return stored && typeof stored === 'object' ? { ...DEFAULT_PREFERENCE, ...stored } : DEFAULT_PREFERENCE
}

export function saveChatLaunch(repoKey: string | undefined, preference: ChatLaunchPreference): void {
  try {
    const all = readAll()
    if (repoKey) all[repoKey] = preference
    all[LAST_KEY] = preference
    window.localStorage.setItem(CHAT_LAUNCH_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Remembering is a convenience; launching still works without storage.
  }
}

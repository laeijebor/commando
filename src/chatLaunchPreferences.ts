import { CODEX_CHAT_PERMISSION_MODES, type ChatPermissionMode } from '../shared/tmux-create'

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
export function loadChatLaunch(repoKey: string | undefined, provider: 'claude-chat' | 'codex-chat' = 'claude-chat'): ChatLaunchPreference {
  const key = provider === 'codex-chat' ? `codex:${repoKey ?? LAST_KEY}` : repoKey
  const lastKey = provider === 'codex-chat' ? `codex:${LAST_KEY}` : LAST_KEY
  const all = readAll()
  const stored = (key && all[key]) || all[lastKey]
  if (provider === 'codex-chat') return { permissionMode: CODEX_CHAT_PERMISSION_MODES.some((mode) => mode.value === stored?.permissionMode) ? stored.permissionMode : 'default' }
  return stored && typeof stored === 'object' ? { ...DEFAULT_PREFERENCE, ...stored } : DEFAULT_PREFERENCE
}

export function saveChatLaunch(repoKey: string | undefined, preference: ChatLaunchPreference, provider: 'claude-chat' | 'codex-chat' = 'claude-chat'): void {
  try {
    const all = readAll()
    const key = provider === 'codex-chat' ? `codex:${repoKey ?? LAST_KEY}` : repoKey
    const lastKey = provider === 'codex-chat' ? `codex:${LAST_KEY}` : LAST_KEY
    const saved = provider === 'codex-chat' ? { permissionMode: preference.permissionMode } : preference
    if (key) all[key] = saved
    all[lastKey] = saved
    window.localStorage.setItem(CHAT_LAUNCH_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Remembering is a convenience; launching still works without storage.
  }
}

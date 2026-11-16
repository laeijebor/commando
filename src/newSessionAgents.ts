import {
  claudeProfileLabel,
  isChatLaunchProvider,
  type ClaudeProfile,
  type SessionAgentProvider,
} from '../shared/tmux-create'

// The model helpers live in shared code so the phone's create screen uses the same rules.
export { DEFAULT_MODEL, modelCatalogFor, modelChoices, modelProvider } from '../shared/tmux-create'

/** `none` starts the session with an empty pane that offers to launch something later. */
export type StartWith = SessionAgentProvider | 'shell' | 'none'

/** One row of the Agent menu: a provider, and for Claude the profile (login) it starts with. */
export type AgentOption = {
  provider: StartWith
  configDir?: string
  label: string
  /** The profile's name, shown beside the label. */
  tag?: string
  group: 'Chat' | 'Terminal' | 'Other'
}

const CHATS: readonly { provider: StartWith; label: string }[] = [
  { provider: 'codex-chat', label: 'Codex chat' },
  { provider: 'muse-chat', label: 'Muse chat' },
  { provider: 'cursor-chat', label: 'Cursor chat' },
  { provider: 'deepseek-chat', label: 'DeepSeek chat' },
]
const TERMINALS: readonly { provider: StartWith; label: string }[] = [
  { provider: 'codex', label: 'Codex' },
  { provider: 'opencode', label: 'OpenCode' },
  { provider: 'cursor', label: 'Cursor' },
]

/** Claude rows list every profile, the way `claudep` / `claudew` aliases pick a login. */
export function agentOptions(profiles: readonly ClaudeProfile[] | null): AgentOption[] {
  const claude = (provider: 'claude-chat' | 'claude', label: string, group: AgentOption['group']): AgentOption[] => profiles?.length
    ? profiles.map((profile) => ({ provider, configDir: profile.configDir, label, tag: claudeProfileLabel(profile), group }))
    : [{ provider, label, group }]
  return [
    ...claude('claude-chat', 'Claude chat', 'Chat'),
    ...CHATS.map((chat) => ({ ...chat, group: 'Chat' as const })),
    ...claude('claude', 'Claude terminal', 'Terminal'),
    ...TERMINALS.map((terminal) => ({ ...terminal, group: 'Terminal' as const })),
    { provider: 'shell', label: 'Shell', group: 'Other' },
    { provider: 'none', label: 'Nothing', group: 'Other' },
  ]
}

export function usesClaudeProfile(provider: StartWith): provider is 'claude-chat' | 'claude' {
  return provider === 'claude-chat' || provider === 'claude'
}

/** Whether the agent starts with an opening prompt (OpenCode is started without one). */
export function takesPrompt(provider: StartWith): boolean {
  return provider !== 'none' && provider !== 'shell' && provider !== 'opencode'
}

/** Only chats can be sent pasted images. */
export function takesImages(provider: StartWith): boolean {
  return isChatLaunchProvider(provider)
}

export const MODEL_STORAGE_KEY = 'commando.tmux-create.model-by-agent'
const LAST = '*'

function readModels(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MODEL_STORAGE_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

/** The model last picked for this agent in this repository, else anywhere. */
export function loadModelChoice(repoKey: string | undefined, catalogKey: string): string | undefined {
  const all = readModels()
  const stored = (repoKey ? all[`${repoKey}|${catalogKey}`] : undefined) ?? all[`${LAST}|${catalogKey}`]
  return typeof stored === 'string' ? stored : undefined
}

export function saveModelChoice(repoKey: string | undefined, catalogKey: string, model: string): void {
  try {
    const all = readModels()
    if (repoKey) all[`${repoKey}|${catalogKey}`] = model
    all[`${LAST}|${catalogKey}`] = model
    window.localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Remembering is a convenience; launching still works without storage.
  }
}

/** `~/…` for paths under a home folder, so the summary line stays short. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/u, '~')
}

export function relativeAge(updatedAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - updatedAt) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

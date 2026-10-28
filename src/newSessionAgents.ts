import type { ChatModelOption, ChatProvider } from '../shared/agent-chat'
import {
  claudeProfileLabel,
  isChatLaunchProvider,
  modelCatalogKey,
  type ClaudeProfile,
  type ModelCatalogEntry,
  type ModelCatalogs,
  type SessionAgentProvider,
} from '../shared/tmux-create'

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

/** The provider whose model list applies, or null when the agent has no model choice here. */
export function modelProvider(provider: StartWith): ChatProvider | null {
  switch (provider) {
    case 'claude-chat': case 'claude': return 'claude'
    case 'codex-chat': case 'codex': return 'codex'
    case 'muse-chat': return 'muse'
    case 'cursor-chat': return 'cursor'
    default: return null
  }
}

export const DEFAULT_MODEL: ChatModelOption = { value: 'default', displayName: 'Default' }

/**
 * The cached list for this agent and profile. A Claude profile that has never run a chat
 * borrows the newest Claude list, since logins rarely differ in what they offer.
 */
export function modelCatalogFor(catalogs: ModelCatalogs | null, provider: StartWith, configDir: string | undefined): ModelCatalogEntry | null {
  const chatProvider = modelProvider(provider)
  if (!catalogs || !chatProvider) return null
  const exact = catalogs[modelCatalogKey(chatProvider, configDir)]
  if (exact || chatProvider !== 'claude') return exact ?? null
  return Object.entries(catalogs)
    .filter(([key]) => key === 'claude' || key.startsWith('claude:'))
    .map(([, entry]) => entry)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
}

/** The picker's options: the cached list, always led by the provider's own default. */
export function modelChoices(entry: ModelCatalogEntry | null): ChatModelOption[] {
  const models = entry?.models ?? []
  return models.some((model) => model.value === 'default') ? models : [DEFAULT_MODEL, ...models]
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

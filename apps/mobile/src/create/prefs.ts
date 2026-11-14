import { chatPermissionModes, type ChatLaunchProvider, type ChatPermissionMode } from '@commando/tmux-create'

import { readPreference, writePreference } from '../prefs'
import { AGENT_CHOICES, type AgentChoice } from './model'

/**
 * The desktop keeps the create dialog's directory history and its per-repo
 * preparation commands in `localStorage`
 * (`src/TmuxCreateControls.tsx`: `TMUX_CWD_HISTORY_STORAGE_KEY`,
 * `WORKTREE_PREPARE_COMMANDS_STORAGE_KEY`). The daemon's
 * `/api/session-management/preferences` is not a home for them —
 * `parseSessionTreePreferences` only keeps session groups and drops every
 * other key — so the phone mirrors the same two keys in SecureStore, beside
 * its own record of how sessions were last started.
 */

export const CWD_HISTORY_KEY = 'commando.tmux-create.cwd'
export const PREPARE_COMMANDS_KEY = 'commando.tmux-create.prepare-by-repo'

const MAX_DIRECTORY_HISTORY = 10

async function readJson(key: string): Promise<unknown> {
  const stored = await readPreference(key)
  if (!stored) return null
  try {
    return JSON.parse(stored) as unknown
  } catch {
    return null
  }
}

export async function loadDirectoryHistory(): Promise<string[]> {
  const value = await readJson(CWD_HISTORY_KEY)
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('/'))
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, MAX_DIRECTORY_HISTORY)
}

export async function rememberDirectory(directory: string): Promise<string[]> {
  const history = await loadDirectoryHistory()
  if (!directory.startsWith('/')) return history
  const next = [directory, ...history.filter((entry) => entry !== directory)]
    .slice(0, MAX_DIRECTORY_HISTORY)
  await writePreference(CWD_HISTORY_KEY, JSON.stringify(next))
  return next
}

export async function loadPrepareCommands(): Promise<Record<string, string>> {
  const value = await readJson(PREPARE_COMMANDS_KEY)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => entry[0].startsWith('/') && typeof entry[1] === 'string',
    ),
  )
}

export async function rememberPrepareCommand(repoRoot: string, command: string): Promise<void> {
  const commands = await loadPrepareCommands()
  if (command.trim()) commands[repoRoot] = command
  else delete commands[repoRoot]
  await writePreference(PREPARE_COMMANDS_KEY, JSON.stringify(commands))
}



/**
 * How the last session was started, per repository and overall (`*`), the
 * way the desktop dialog remembers its start-with, chat launch and model
 * choices. Fast mode is remembered too, which the desktop leaves off.
 */
export const LAUNCH_KEY = 'commando.tmux-create.launch-by-repo'
const LAST_LAUNCH = '*'

export type LaunchPrefs = {
  startWith?: AgentChoice
  /** Each chat provider keeps its own permission mode. */
  permissions?: Partial<Record<ChatLaunchProvider, ChatPermissionMode>>
  /** The Claude profile (config dir) Claude chats and terminals start with. */
  configDir?: string
  /** Keyed by `modelCatalogKey`, so each Claude login keeps its own pick. */
  models?: Record<string, string>
  fast?: boolean
}

export type LaunchStore = Record<string, LaunchPrefs>

const AGENT_VALUES = new Set<string>(AGENT_CHOICES.map((choice) => choice.value))
const CHAT_PROVIDERS: readonly ChatLaunchProvider[] = ['claude-chat', 'codex-chat', 'muse-chat', 'cursor-chat', 'deepseek-chat']

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** Drops anything a newer or older app stored that this one can't start with. */
function parseLaunch(value: unknown): LaunchPrefs | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const stored = stringRecord(record.permissions) ?? {}
  const permissions = Object.fromEntries(CHAT_PROVIDERS.flatMap((provider) => {
    const mode = stored[provider]
    return mode && chatPermissionModes(provider).some((option) => option.value === mode) ? [[provider, mode as ChatPermissionMode]] : []
  }))
  const models = stringRecord(record.models)
  return {
    ...(typeof record.startWith === 'string' && AGENT_VALUES.has(record.startWith) ? { startWith: record.startWith as AgentChoice } : {}),
    ...(Object.keys(permissions).length ? { permissions } : {}),
    ...(typeof record.configDir === 'string' && record.configDir.startsWith('/') ? { configDir: record.configDir } : {}),
    ...(models ? { models } : {}),
    ...(typeof record.fast === 'boolean' ? { fast: record.fast } : {}),
  }
}

export async function loadLaunchStore(): Promise<LaunchStore> {
  const value = await readJson(LAUNCH_KEY)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const parsed = parseLaunch(entry)
    return parsed ? [[key, parsed]] : []
  }))
}

function merge(base: LaunchPrefs | undefined, over: LaunchPrefs | undefined): LaunchPrefs {
  const permissions = { ...base?.permissions, ...over?.permissions }
  const models = { ...base?.models, ...over?.models }
  return {
    ...base,
    ...over,
    ...(Object.keys(permissions).length ? { permissions } : {}),
    ...(Object.keys(models).length ? { models } : {}),
  }
}

/** What this repository last started with, field by field, else what was last used anywhere. */
export function resolveLaunch(store: LaunchStore, repoKey: string | undefined): LaunchPrefs {
  return merge(store[LAST_LAUNCH], repoKey ? store[repoKey] : undefined)
}

/** Records a launch under the repository and as the last one used anywhere. */
export async function rememberLaunch(repoKey: string | undefined, launch: LaunchPrefs): Promise<LaunchStore> {
  const store = await loadLaunchStore()
  const next: LaunchStore = { ...store, [LAST_LAUNCH]: merge(store[LAST_LAUNCH], launch) }
  if (repoKey) next[repoKey] = merge(store[repoKey], launch)
  await writePreference(LAUNCH_KEY, JSON.stringify(next))
  return next
}

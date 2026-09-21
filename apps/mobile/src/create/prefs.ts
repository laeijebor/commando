import { readPreference, writePreference } from '../prefs'

/**
 * The desktop keeps the create dialog's directory history and its per-repo
 * preparation commands in `localStorage`
 * (`src/TmuxCreateControls.tsx`: `TMUX_CWD_HISTORY_STORAGE_KEY`,
 * `WORKTREE_PREPARE_COMMANDS_STORAGE_KEY`). The daemon's
 * `/api/session-management/preferences` is not a home for them —
 * `parseSessionTreePreferences` only keeps session groups and drops every
 * other key — so the phone mirrors the same two keys in SecureStore and adds
 * one of its own for the sessions the owner asked to be notified about.
 */

export const CWD_HISTORY_KEY = 'commando.tmux-create.cwd'
export const PREPARE_COMMANDS_KEY = 'commando.tmux-create.prepare-by-repo'
/** Session names the notifications settings screen will read back. */

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



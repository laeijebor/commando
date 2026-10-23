import type { ClaudeProfile } from './tmux-create.js'

export const AGENT_PROFILE_ROUTES = {
  list: '/api/agent-profiles',
  claude: '/api/agent-profiles/claude',
  claudePreferences: '/api/agent-profiles/claude/preferences',
  claudeLogin: '/api/agent-profiles/claude/login',
} as const

/** What `claude auth status` reports for a profile; `unknown` when the check itself failed. */
export type ClaudeLoginStatus = {
  state: 'logged-in' | 'logged-out' | 'unknown'
  email?: string
  orgName?: string
  subscriptionType?: string
  error?: string
}

export type ClaudeProfileSettings = ClaudeProfile & { hidden: boolean; status: ClaudeLoginStatus }

/** An agent with a single config folder, shown read-only. */
export type OtherAgentProfile = {
  provider: 'codex' | 'cursor' | 'opencode'
  label: string
  configDir: string
  installed: boolean
  state: 'logged-in' | 'logged-out' | 'unknown'
  /** The CLI's own status line(s). */
  detail: string
}

export type AgentProfilesResponse = { claude: ClaudeProfileSettings[]; others: OtherAgentProfile[] }

/** A Settings change to one Claude profile; a null label clears it. */
export type ClaudeProfilePreferenceChange = { configDir: string; label?: string | null; hidden?: boolean; isDefault?: boolean }

/** Folder names after `~/.claude`, e.g. `w` for `~/.claudew`. */
export const CLAUDE_PROFILE_NAME = /^[A-Za-z0-9_-]{1,32}$/u

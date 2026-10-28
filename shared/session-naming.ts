import type { ChatImageRef, ChatProvider } from './agent-chat.js'

export const SESSION_NAMING_ROUTES = {
  /** POST: suggest a session name from an opening prompt. */
  suggest: '/api/session-names',
  /** GET the settings and the naming model's status; PUT to change the settings. */
  settings: '/api/session-naming',
  /** POST: forget a remembered failure and try the naming model again. */
  retry: '/api/session-naming/retry',
} as const

/** The providers that can name a session in one shot: `codex exec` and `claude -p`. */
export type NamingProvider = 'codex' | 'claude'
export type NamingModel = { provider: NamingProvider; model: string; configDir?: string }

export type SessionNamingSettings = {
  /** Name with the naming model (falling back to the chat's own), or always with the chat's model. */
  mode: 'naming-model' | 'chat-model'
  namingModel: NamingModel
  /** How long the New session modal waits for a name before using a generated one. */
  timeoutSeconds: number
}

export const DEFAULT_SESSION_NAMING: SessionNamingSettings = {
  mode: 'naming-model',
  namingModel: { provider: 'codex', model: 'gpt-6-luna' },
  timeoutSeconds: 10,
}
export const MIN_NAMING_TIMEOUT_SECONDS = 2
export const MAX_NAMING_TIMEOUT_SECONDS = 60

export type NamingModelStatus =
  | { state: 'available'; lastNamedAt?: number }
  /** A hard failure (no login, unknown model, missing CLI): skipped until Try again or a login change. */
  | { state: 'unavailable'; since: number; reason: string; canRetry: boolean }
  /** Timed out twice in a row: skipped for a while. */
  | { state: 'resting'; until: number; reason: string }

export type SessionNamingResponse = {
  settings: SessionNamingSettings
  status: NamingModelStatus
  /** The naming model's display name, e.g. `GPT-6-Luna`. */
  label: string
}

export type SuggestSessionNameRequest = {
  prompt?: string
  images?: ChatImageRef[]
  /** The chat being started: its model names the session when the naming model can't. */
  chat?: { provider: ChatProvider; configDir?: string; model?: string }
}

export type SuggestSessionNameResponse = {
  /** A kebab-case name, or null when no model could name it in time. */
  name: string | null
  /** Display name of the model that named it. */
  by?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function parseNamingModel(value: unknown, isModel: (value: unknown) => value is string): NamingModel | null {
  if (!isRecord(value)) return null
  const { provider, model, configDir } = value
  if ((provider !== 'codex' && provider !== 'claude') || !isModel(model)) return null
  if (configDir !== undefined && (provider !== 'claude' || typeof configDir !== 'string')) return null
  return { provider, model, ...(typeof configDir === 'string' ? { configDir } : {}) }
}

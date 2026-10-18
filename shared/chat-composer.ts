/**
 * The chat composer's logic that holds no UI: the `/` and `@` triggers, the
 * picker labels and the attachment limit. The web composer and the companion
 * app both use it, so the two read a chat's settings and menus the same way.
 */
import {
  MAX_CHAT_IMAGES,
  baseModelId,
  hostTakesSettings,
  selectedModelOption,
  type ChatCommand,
  type ChatEffort,
  type ChatFileEntry,
  type ChatSessionInfo,
  type ChatSessionPermissionMode,
} from './agent-chat.js'

// Composer triggers, after t3code's composer-logic.ts (detectComposerTrigger,
// replaceTextRange) (MIT).

export type ComposerTriggerKind = 'slash' | 'mention' | 'pr'

export interface ComposerTrigger {
  kind: ComposerTriggerKind
  /** What follows the `/`, `@` or `#`. */
  query: string
  rangeStart: number
  rangeEnd: number
  /** Only whitespace comes before it: a command here runs, mid-message it doesn't. */
  atStart: boolean
}

const SLASH_TOKEN = /^\/([\w:.@-]*)$/
const PR_TOKEN = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r'
}

function tokenStart(text: string, cursor: number): number {
  let index = cursor - 1
  while (index >= 0 && !isWhitespace(text[index])) index -= 1
  return index + 1
}

/**
 * The trigger the caret sits in, if any. Unlike t3code's start-of-line `/`,
 * a `/` opens the menu after any whitespace, as in the Claude Code TUI.
 */
export function detectTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = Math.max(0, Math.min(text.length, Math.floor(cursorInput)))
  const start = tokenStart(text, cursor)
  const token = text.slice(start, cursor)
  const atStart = text.slice(0, start).trim() === ''
  const at = (kind: ComposerTriggerKind, query: string): ComposerTrigger => ({ kind, query, rangeStart: start, rangeEnd: cursor, atStart })
  const slash = SLASH_TOKEN.exec(token)
  if (slash) return at('slash', slash[1] ?? '')
  const pr = PR_TOKEN.exec(token)
  if (pr) return at('pr', pr[1] ?? '')
  if (token.startsWith('@') && !token.startsWith('@"')) return at('mention', token.slice(1))
  return null
}

/** Replaces `[rangeStart, rangeEnd)`, swallowing a space the replacement already ends with. */
export function replaceRange(text: string, rangeStart: number, rangeEnd: number, replacement: string): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(text.length, rangeStart))
  let end = Math.max(start, Math.min(text.length, rangeEnd))
  if (replacement.endsWith(' ') && text[end] === ' ') end += 1
  return { text: `${text.slice(0, start)}${replacement}${text.slice(end)}`, cursor: start + replacement.length }
}

/**
 * Moves a start-only command picked mid-message to the front, the rest of
 * the message becoming its arguments: `keep the API notes /comp` becomes
 * `/compact keep the API notes`.
 */
export function moveCommandToStart(text: string, trigger: ComposerTrigger, name: string): { text: string; cursor: number } {
  // Only the token and the spaces around it go; newlines and indentation elsewhere stay.
  const before = text.slice(0, trigger.rangeStart).replace(/[ \t]+$/, '')
  let after = text.slice(trigger.rangeEnd).replace(/^[ \t]+/, '')
  // A token alone on its line takes the line with it.
  if ((!before || before.endsWith('\n')) && after.startsWith('\n')) after = after.slice(1)
  const joiner = before && after && !before.endsWith('\n') && !after.startsWith('\n') ? ' ' : ''
  const rest = `${before}${joiner}${after}`.trim()
  const head = `/${name} `
  return { text: `${head}${rest}`, cursor: head.length + rest.length }
}

/** Ranks `/` entries: name prefix, then alias prefix, then (from three letters) name, then description. */
export function filterCommands(commands: readonly ChatCommand[], rawQuery: string, limit = 60): ChatCommand[] {
  const query = rawQuery.toLowerCase()
  if (!query) return commands.slice(0, limit)
  const scored = commands.flatMap((command) => {
    const name = command.name.toLowerCase()
    // Plugin entries (`codex:review`) also match on the part after the colon.
    const short = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
    const score = name.startsWith(query) ? 0
      : short.startsWith(query) ? 1
        : command.aliases?.some((alias) => alias.toLowerCase().startsWith(query)) ? 2
          // Two letters match too much of a long list mid-word; wait for a third.
          : query.length >= 3 && name.includes(query) ? 3
            : query.length >= 3 && command.description.toLowerCase().includes(query) ? 4
              : -1
    return score < 0 ? [] : [{ command, score }]
  })
  return scored
    .sort((a, b) => a.score - b.score || a.command.name.length - b.command.name.length || a.command.name.localeCompare(b.command.name))
    .slice(0, limit)
    .map(({ command }) => command)
}

/** `@path`, quoted when the path has spaces so Claude Code reads it whole. */
export function mentionText(entry: ChatFileEntry): string {
  return /\s/.test(entry.path) ? `@"${entry.path}" ` : `@${entry.path} `
}

// ---- pickers ----

const DEFAULT_MODEL = 'default'

export const EFFORT_LABELS: Record<ChatEffort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

export const PERMISSION_MODES: Record<ChatSessionPermissionMode, { label: string; description: string }> = {
  default: { label: 'Ask before edits', description: 'Claude asks before it edits files or runs commands.' },
  acceptEdits: { label: 'Accept edits', description: 'Edits apply without asking; commands still ask.' },
  plan: { label: 'Plan mode', description: 'Claude explores and plans without changing anything.' },
  auto: { label: 'Auto', description: 'A classifier approves routine actions; the rest still ask.' },
  dontAsk: { label: "Don't ask", description: 'Anything not already allowed is denied.' },
  bypassPermissions: { label: 'Bypass permissions', description: 'Nothing asks first. Only for chats started with it.' },
}

const CODEX_WORKSPACE_ACCESS = { label: 'Workspace access', description: 'Workspace edits and sandboxed commands are allowed; escalation asks.' }
const CODEX_PERMISSION_MODES: Partial<typeof PERMISSION_MODES> = {
  default: CODEX_WORKSPACE_ACCESS,
  acceptEdits: CODEX_WORKSPACE_ACCESS,
  plan: { label: 'Read only', description: 'Read-only sandbox; Codex asks before escalating access.' },
  bypassPermissions: { label: 'Full access', description: 'Full filesystem access without approval prompts.' },
}

const MUSE_PERMISSION_MODES: Partial<typeof PERMISSION_MODES> = {
  default: { label: 'Ask when needed', description: 'Tools run in the sandbox; Muse asks before going beyond it.' },
  bypassPermissions: { label: 'Approve everything', description: 'Muse runs every tool without asking. The sandbox stays on.' },
}

function providerPermissionModes(session?: Pick<ChatSessionInfo, 'provider'>): Partial<typeof PERMISSION_MODES> | undefined {
  return session?.provider === 'codex' ? CODEX_PERMISSION_MODES : session?.provider === 'muse' ? MUSE_PERMISSION_MODES : undefined
}

export function providerLabel(session: Pick<ChatSessionInfo, 'provider'>): string {
  return session.provider === 'claude' ? 'Claude' : session.provider === 'muse' ? 'Muse' : 'Codex'
}

export function permissionLabel(mode: string, session?: Pick<ChatSessionInfo, 'provider'>): string {
  const permission = mode as ChatSessionPermissionMode
  return providerPermissionModes(session)?.[permission]?.label
    ?? PERMISSION_MODES[permission]?.label ?? mode
}

export function permissionDescription(mode: ChatSessionPermissionMode, session?: Pick<ChatSessionInfo, 'provider'>): string {
  return providerPermissionModes(session)?.[mode]?.description
    ?? PERMISSION_MODES[mode].description.replace('Claude', session ? providerLabel(session) : 'Claude')
}

/** Whether the model menu can open: the host takes settings and has listed its models. */
export function modelMenuAvailable(session: ChatSessionInfo): boolean {
  return Boolean(session.models?.length && hostTakesSettings(session))
}

/** Fast mode is on and the selected model offers it, so replies run fast. */
export function fastModeOn(session: ChatSessionInfo): boolean {
  return Boolean(session.fast && selectedModelOption(session)?.supportsFast)
}

/** The fast-mode toggle is offered: the pickers work and the selected model has fast mode. */
export function fastModeAvailable(session: ChatSessionInfo): boolean {
  return modelMenuAvailable(session) && Boolean(selectedModelOption(session)?.supportsFast)
}

/** "Opus 5.5": the named row for the running model, never the "Default" alias. */
export function modelLabel(session: ChatSessionInfo): string | undefined {
  const models = session.models ?? []
  const fallback = models.find((model) => model.value === DEFAULT_MODEL)
  // Claude reports the running model with its first turn; until then a fresh chat runs the default.
  const running = session.model ? baseModelId(session.model) : fallback?.resolvedModel
  const picked = session.selectedModel ?? running
  const named = models.find((model) => model.value !== DEFAULT_MODEL && model.value === picked)
    ?? models.find((model) => model.value !== DEFAULT_MODEL && model.resolvedModel === running)
  return named?.displayName ?? session.model ?? fallback?.displayName
}

/** The modes the permission menu offers: the current one, the launch modes, and those this chat and model allow. */
export function permissionModeOptions(session: ChatSessionInfo): ChatSessionPermissionMode[] {
  const current = session.permissionMode
  const supportsAuto = selectedModelOption(session)?.supportsAutoMode ?? false
  return (Object.keys(PERMISSION_MODES) as ChatSessionPermissionMode[]).filter((mode) => (
    mode === current
    || mode === 'default' || (mode === 'plan' && session.provider !== 'muse')
    || (session.provider === 'claude' && (mode === 'acceptEdits' || (mode === 'auto' && supportsAuto)))
    || (mode === 'bypassPermissions' && session.bypassAllowed)
  ))
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

// ---- attachments ----

/** How many of `adding` fit beside `current` attachments, and what to say about the rest. */
export function fitAttachments(current: number, adding: number): { accepted: number; error?: string } {
  const room = Math.max(0, MAX_CHAT_IMAGES - current)
  if (adding <= room) return { accepted: adding }
  return { accepted: room, error: `A message can carry at most ${MAX_CHAT_IMAGES} images` }
}

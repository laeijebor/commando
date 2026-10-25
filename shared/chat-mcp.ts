/**
 * A chat agent's MCP servers, as its pane's palette shows and manages them
 * (like Claude Code's `/mcp`). The host reads them from the agent, so every
 * field is validated where it crosses into the daemon and the client.
 */

export type ChatMcpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
export const CHAT_MCP_STATUSES: readonly ChatMcpStatus[] = ['connected', 'failed', 'needs-auth', 'pending', 'disabled']

export interface ChatMcpTool {
  name: string
  description?: string
  readOnly?: boolean
  destructive?: boolean
}

export interface ChatMcpServer {
  name: string
  status: ChatMcpStatus
  /** Where it is configured: user, project, local, plugin, claudeai, managed… */
  scope?: string
  error?: string
  /** `name version` the server reported when it connected. */
  serverInfo?: string
  /** stdio, http, sse, claudeai-proxy, sdk… */
  transport?: string
  /** The command it runs, or its URL without query or credentials. */
  target?: string
  tools: ChatMcpTool[]
}

export type ChatMcpServerAction = 'reconnect' | 'enable' | 'disable' | 'authenticate' | 'clear_auth'
export const CHAT_MCP_SERVER_ACTIONS: readonly ChatMcpServerAction[] = ['reconnect', 'enable', 'disable', 'authenticate', 'clear_auth']

export type ChatMcpRequest =
  | { action: 'status' }
  | { action: ChatMcpServerAction; server: string }

/** Every answer carries the servers as they are after the action. */
export interface ChatMcpResult {
  servers: ChatMcpServer[]
  /** The sign-in page an `authenticate` needs the user to open; the agent waits for its callback. */
  authUrl?: string
  error?: string
}

const MAX_SERVERS = 200
const MAX_TOOLS = 500
const MAX_NAME = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length ? value.slice(0, max) : undefined
}

function name(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME && !/[\u0000-\u001f]/.test(value)
}

export function isChatMcpServerAction(value: unknown): value is ChatMcpServerAction {
  return CHAT_MCP_SERVER_ACTIONS.includes(value as ChatMcpServerAction)
}

export function parseChatMcpRequest(value: unknown): ChatMcpRequest | null {
  if (!isRecord(value)) return null
  if (value.action === 'status') return { action: 'status' }
  return isChatMcpServerAction(value.action) && name(value.server) ? { action: value.action, server: value.server } : null
}

/** Only web pages: the client opens this in a browser. */
export function safeAuthUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function parseTool(value: unknown): ChatMcpTool | null {
  if (!isRecord(value) || !name(value.name)) return null
  const description = text(value.description, 2000)
  return {
    name: value.name,
    ...(description ? { description } : {}),
    ...(value.readOnly === true ? { readOnly: true } : {}),
    ...(value.destructive === true ? { destructive: true } : {}),
  }
}

export function parseChatMcpServer(value: unknown): ChatMcpServer | null {
  if (!isRecord(value) || !name(value.name) || !CHAT_MCP_STATUSES.includes(value.status as ChatMcpStatus)) return null
  const optional = {
    scope: text(value.scope, 40),
    error: text(value.error, 2000),
    serverInfo: text(value.serverInfo, 200),
    transport: text(value.transport, 40),
    target: text(value.target, 2000),
  }
  const tools = Array.isArray(value.tools) ? value.tools.slice(0, MAX_TOOLS).map(parseTool).filter((tool): tool is ChatMcpTool => tool !== null) : []
  return {
    name: value.name,
    status: value.status as ChatMcpStatus,
    ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)),
    tools,
  }
}

export function parseChatMcpResult(value: unknown): ChatMcpResult | null {
  if (!isRecord(value) || !Array.isArray(value.servers)) return null
  const servers = value.servers.slice(0, MAX_SERVERS).map(parseChatMcpServer).filter((server): server is ChatMcpServer => server !== null)
  const authUrl = safeAuthUrl(value.authUrl)
  const error = text(value.error, 1000)
  return { servers, ...(authUrl ? { authUrl } : {}), ...(error ? { error } : {}) }
}

const SCOPE_ORDER = ['local', 'project', 'user', 'plugin', 'claudeai', 'managed', 'enterprise', 'dynamic', 'sdk']
const SCOPE_LABELS: Record<string, string> = {
  local: 'Local',
  project: 'Project',
  user: 'User',
  plugin: 'Plugins',
  claudeai: 'claude.ai',
  managed: 'Managed',
  enterprise: 'Enterprise',
  dynamic: 'Session',
  sdk: 'Built-in',
}

export function chatMcpScopeLabel(scope: string | undefined): string {
  return scope ? SCOPE_LABELS[scope] ?? scope[0]!.toUpperCase() + scope.slice(1) : 'Other'
}

/** Servers grouped by where they are configured, in Claude Code's order, each group by name. */
export function groupChatMcpServers(servers: readonly ChatMcpServer[]): { scope: string; label: string; servers: ChatMcpServer[] }[] {
  const groups = new Map<string, ChatMcpServer[]>()
  for (const server of servers) {
    const scope = server.scope ?? 'other'
    groups.set(scope, [...(groups.get(scope) ?? []), server])
  }
  const rank = (scope: string) => {
    const index = SCOPE_ORDER.indexOf(scope)
    return index < 0 ? SCOPE_ORDER.length : index
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([scope, entries]) => ({
      scope,
      label: chatMcpScopeLabel(scope === 'other' ? undefined : scope),
      servers: entries.sort((a, b) => a.name.localeCompare(b.name)),
    }))
}

export const CHAT_MCP_STATUS_LABELS: Record<ChatMcpStatus, string> = {
  connected: 'Connected',
  failed: 'Failed',
  'needs-auth': 'Needs authentication',
  pending: 'Connecting',
  disabled: 'Disabled',
}

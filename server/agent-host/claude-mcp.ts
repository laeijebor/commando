import type { McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk'
import { parseChatMcpServer, safeAuthUrl, type ChatMcpRequest, type ChatMcpResult, type ChatMcpServer } from '../../shared/chat-mcp.js'

/**
 * What the palette needs from a Claude query. `mcpAuthenticate` and
 * `mcpClearAuth` exist on the SDK's query but not in its published types, so
 * they are optional here and checked before use.
 */
export type ClaudeMcpHandle = Pick<Query, 'mcpServerStatus' | 'reconnectMcpServer' | 'toggleMcpServer'> & {
  mcpAuthenticate?: (serverName: string, redirectUri?: string) => Promise<unknown>
  mcpClearAuth?: (serverName: string) => Promise<unknown>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const HIDDEN = '•••'
const SECRET_NAME = /key|token|secret|password|passwd|auth|credential|bearer/i
/** A long run of id characters with a digit in it reads as a key (`/s/k3j4h5…/mcp`). */
const OPAQUE = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/

/** A URL without its query, fragment, credentials or key-like path segments, which may carry tokens. */
export function displayUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!url.host) return undefined
    const path = url.pathname === '/' ? '' : url.pathname.split('/').map((segment) => OPAQUE.test(segment) ? HIDDEN : segment).join('/')
    return `${url.protocol}//${url.host}${path}`
  } catch {
    return undefined
  }
}

/** A command line with what looks secret masked: values of key-like flags or variables, and URLs' credentials. */
export function displayCommand(command: string, args: readonly string[] = []): string {
  const shown: string[] = [command]
  let hideNext = false
  for (const arg of args) {
    if (hideNext && !arg.startsWith('-')) {
      shown.push(HIDDEN)
      hideNext = false
      continue
    }
    hideNext = false
    const assigned = /^(-{0,2}[A-Za-z_][\w.-]*)=(.*)$/.exec(arg)
    if (assigned) shown.push(SECRET_NAME.test(assigned[1]!) ? `${assigned[1]}=${HIDDEN}` : `${assigned[1]}=${displayUrl(assigned[2]!) ?? assigned[2]}`)
    else if (arg.startsWith('-')) {
      shown.push(arg)
      hideNext = SECRET_NAME.test(arg)
    } else shown.push(/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? displayUrl(arg) ?? HIDDEN : OPAQUE.test(arg) ? HIDDEN : arg)
  }
  return shown.join(' ')
}

/** Never env or headers: they hold secrets. */
function target(config: McpServerStatus['config']): { transport?: string; target?: string } {
  if (!config) return {}
  if ('url' in config && typeof config.url === 'string') return { transport: config.type, target: displayUrl(config.url) }
  if ('command' in config) return { transport: config.type ?? 'stdio', target: displayCommand(config.command, config.args) }
  return { transport: config.type }
}

export function chatMcpServers(statuses: readonly McpServerStatus[]): ChatMcpServer[] {
  return statuses.flatMap((status) => {
    const server = parseChatMcpServer({
      name: status.name,
      status: status.status,
      // Plugin servers report a config scope too; the CLI groups them as plugins.
      scope: status.source === 'plugin' ? 'plugin' : status.scope ?? status.source,
      error: status.error,
      serverInfo: status.serverInfo ? `${status.serverInfo.name} ${status.serverInfo.version}`.trim() : undefined,
      ...target(status.config),
      tools: (status.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.annotations?.readOnly,
        destructive: tool.annotations?.destructive,
      })),
    })
    return server ? [server] : []
  })
}

async function act(handle: ClaudeMcpHandle, request: Exclude<ChatMcpRequest, { action: 'status' }>): Promise<{ authUrl?: string }> {
  switch (request.action) {
    case 'reconnect':
      await handle.reconnectMcpServer(request.server)
      return {}
    case 'enable':
    case 'disable':
      await handle.toggleMcpServer(request.server, request.action === 'enable')
      return {}
    case 'authenticate': {
      if (!handle.mcpAuthenticate) throw new Error("This Claude Code version can't sign in to MCP servers from Commando")
      const response = await handle.mcpAuthenticate(request.server)
      const authUrl = typeof response === 'object' && response !== null ? safeAuthUrl((response as { authUrl?: unknown }).authUrl) : undefined
      return authUrl ? { authUrl } : {}
    }
    case 'clear_auth':
      if (!handle.mcpClearAuth) throw new Error("This Claude Code version can't clear MCP sign-ins from Commando")
      await handle.mcpClearAuth(request.server)
      return {}
  }
}

/** Acts on a server when asked, then lists them all; a failed action still lists them. */
export async function runClaudeMcp(handle: ClaudeMcpHandle, request: ChatMcpRequest): Promise<ChatMcpResult> {
  let error: string | undefined
  let authUrl: string | undefined
  if (request.action !== 'status') {
    try {
      authUrl = (await act(handle, request)).authUrl
    } catch (cause) {
      error = errorText(cause)
    }
  }
  try {
    const servers = chatMcpServers(await handle.mcpServerStatus())
    return { servers, ...(authUrl ? { authUrl } : {}), ...(error ? { error } : {}) }
  } catch (cause) {
    return { servers: [], error: error ?? `Couldn't read the MCP servers: ${errorText(cause)}` }
  }
}

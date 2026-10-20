import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { chatMcpServers, displayCommand, displayUrl, runClaudeMcp, type ClaudeMcpHandle } from './claude-mcp.js'

const statuses: McpServerStatus[] = [
  {
    name: 'github', status: 'connected', scope: 'project', serverInfo: { name: 'github-mcp', version: '1.4.0' },
    config: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'ghp_secret' } },
    tools: [{ name: 'create_issue', description: 'Open an issue', annotations: { destructive: true } }],
  },
  { name: 'linear', status: 'needs-auth', scope: 'user', config: { type: 'http', url: 'https://user:pw@mcp.linear.app/mcp?token=abc', headers: { Authorization: 'Bearer secret' } } },
  { name: 'docs', status: 'failed', scope: 'dynamic', source: 'plugin', error: 'spawn ENOENT' },
]

function handle(overrides: Partial<ClaudeMcpHandle> = {}): ClaudeMcpHandle {
  return {
    mcpServerStatus: vi.fn(async () => statuses),
    reconnectMcpServer: vi.fn(async () => undefined),
    toggleMcpServer: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('Claude MCP servers', () => {
  it('shows what a server is without its env, headers, credentials or query', () => {
    const servers = chatMcpServers(statuses)
    expect(servers).toEqual([
      { name: 'github', status: 'connected', scope: 'project', serverInfo: 'github-mcp 1.4.0', transport: 'stdio', target: 'npx -y server-github', tools: [{ name: 'create_issue', description: 'Open an issue', destructive: true }] },
      { name: 'linear', status: 'needs-auth', scope: 'user', transport: 'http', target: 'https://mcp.linear.app/mcp', tools: [] },
      { name: 'docs', status: 'failed', scope: 'plugin', error: 'spawn ENOENT', tools: [] },
    ])
    expect(JSON.stringify(servers)).not.toMatch(/secret|abc|pw/)
  })

  it('masks secrets that commands and URLs commonly carry', () => {
    expect(displayCommand('npx', ['-y', '@upstash/context7-mcp', '--api-key', 'ctx7sk-abc'])).toBe('npx -y @upstash/context7-mcp --api-key •••')
    expect(displayCommand('npx', ['--token=ghp_123', '--port=3000', 'API_KEY=xyz'])).toBe('npx --token=••• --port=3000 API_KEY=•••')
    expect(displayCommand('npx', ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://me:hunter2@db.local/app'])).toBe('npx -y @modelcontextprotocol/server-postgres postgresql://db.local/app')
    expect(displayCommand('mcp-server', ['sk1234567890abcdefghijklmnop'])).toBe('mcp-server •••')
    expect(displayUrl('https://actions.zapier.com/mcp/sk-ak-1a2b3c4d5e6f7g8h9i0j/sse')).toBe('https://actions.zapier.com/mcp/•••/sse')
  })

  it('runs the action, then lists the servers as they are after it', async () => {
    const query = handle()
    await runClaudeMcp(query, { action: 'disable', server: 'github' })
    expect(query.toggleMcpServer).toHaveBeenCalledWith('github', false)
    await runClaudeMcp(query, { action: 'enable', server: 'github' })
    expect(query.toggleMcpServer).toHaveBeenCalledWith('github', true)
    const result = await runClaudeMcp(query, { action: 'reconnect', server: 'docs' })
    expect(query.reconnectMcpServer).toHaveBeenCalledWith('docs')
    expect(result.servers).toHaveLength(3)
    expect(result.error).toBeUndefined()
  })

  it('still lists the servers when an action fails', async () => {
    const result = await runClaudeMcp(handle({ reconnectMcpServer: vi.fn(async () => { throw new Error('Server not found: nope') }) }), { action: 'reconnect', server: 'nope' })
    expect(result.error).toBe('Server not found: nope')
    expect(result.servers).toHaveLength(3)
  })

  it('passes on the sign-in page Claude Code opens, and only a web page', async () => {
    const mcpAuthenticate = vi.fn(async () => ({ authUrl: 'https://mcp.linear.app/authorize?state=s', requiresUserAction: true }))
    expect((await runClaudeMcp(handle({ mcpAuthenticate }), { action: 'authenticate', server: 'linear' })).authUrl).toBe('https://mcp.linear.app/authorize?state=s')
    expect(mcpAuthenticate).toHaveBeenCalledWith('linear')
    const sneaky = vi.fn(async () => ({ authUrl: 'javascript:alert(1)' }))
    expect((await runClaudeMcp(handle({ mcpAuthenticate: sneaky }), { action: 'authenticate', server: 'linear' })).authUrl).toBeUndefined()
    expect((await runClaudeMcp(handle(), { action: 'authenticate', server: 'linear' })).error).toMatch(/can't sign in/)
    const mcpClearAuth = vi.fn(async () => ({}))
    await runClaudeMcp(handle({ mcpClearAuth }), { action: 'clear_auth', server: 'linear' })
    expect(mcpClearAuth).toHaveBeenCalledWith('linear')
  })

  it('reports a failed read', async () => {
    const result = await runClaudeMcp(handle({ mcpServerStatus: vi.fn(async () => { throw new Error('Query closed') }) }), { action: 'status' })
    expect(result).toEqual({ servers: [], error: "Couldn't read the MCP servers: Query closed" })
  })
})

import { describe, expect, it } from 'vitest'
import { groupChatMcpServers, parseChatMcpRequest, parseChatMcpResult, type ChatMcpServer } from './chat-mcp.js'

describe('chat MCP validation', () => {
  it('accepts a status read or a known action on a named server', () => {
    expect(parseChatMcpRequest({ action: 'status', server: 'ignored' })).toEqual({ action: 'status' })
    expect(parseChatMcpRequest({ action: 'authenticate', server: 'linear' })).toEqual({ action: 'authenticate', server: 'linear' })
    expect(parseChatMcpRequest({ action: 'authenticate' })).toBeNull()
    expect(parseChatMcpRequest({ action: 'delete', server: 'linear' })).toBeNull()
    expect(parseChatMcpRequest({ action: 'reconnect', server: 'bad\nname' })).toBeNull()
    expect(parseChatMcpRequest({ action: 'reconnect', server: 'x'.repeat(201) })).toBeNull()
  })

  it('drops malformed servers, unknown fields and sign-in links that are not web pages', () => {
    const result = parseChatMcpResult({
      servers: [
        { name: 'github', status: 'connected', scope: 'project', env: { TOKEN: 'secret' }, tools: [{ name: 'create_issue', readOnly: 'yes' }, { description: 'no name' }] },
        { name: 'broken', status: 'exploded' },
        'nonsense',
      ],
      authUrl: 'file:///etc/passwd',
      error: '',
    })
    expect(result).toEqual({ servers: [{ name: 'github', status: 'connected', scope: 'project', tools: [{ name: 'create_issue' }] }] })
    expect(parseChatMcpResult({ servers: [], authUrl: 'https://auth.example.com/authorize?state=1' })?.authUrl).toBe('https://auth.example.com/authorize?state=1')
    expect(parseChatMcpResult({ servers: 'all' })).toBeNull()
  })

  it('groups servers the way Claude Code lists them', () => {
    const server = (name: string, scope?: string): ChatMcpServer => ({ name, status: 'connected', ...(scope ? { scope } : {}), tools: [] })
    const groups = groupChatMcpServers([server('zeta', 'user'), server('alpha', 'user'), server('docs', 'plugin'), server('repo', 'project'), server('odd'), server('mine', 'local')])
    expect(groups.map((group) => [group.label, group.servers.map((entry) => entry.name)])).toEqual([
      ['Local', ['mine']], ['Project', ['repo']], ['User', ['alpha', 'zeta']], ['Plugins', ['docs']], ['Other', ['odd']],
    ])
  })
})

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatMcpRequest, ChatMcpResult, ChatMcpServer } from '../shared/chat-mcp'
import { McpSettings, mcpServerActions } from './McpSettings'

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(cleanup)

const github: ChatMcpServer = { name: 'github', status: 'connected', scope: 'project', transport: 'stdio', target: 'npx server-github', tools: [{ name: 'create_issue', description: 'Open an issue' }] }
const linear: ChatMcpServer = { name: 'linear', status: 'needs-auth', scope: 'user', transport: 'http', target: 'https://mcp.linear.app/mcp', tools: [] }

function renderSettings(answer: (request: ChatMcpRequest) => ChatMcpResult, extra: Partial<Parameters<typeof McpSettings>[0]> = {}) {
  const load = vi.fn(async (request: ChatMcpRequest) => answer(request))
  const props = { agentLabel: 'Claude', load, onBack: vi.fn(), onClose: vi.fn(), openUrl: vi.fn(() => true), pollMs: 60_000, ...extra }
  render(<McpSettings {...props} />)
  return props
}

describe('mcpServerActions', () => {
  it('offers what Claude Code offers for each kind of server', () => {
    expect(mcpServerActions(linear).map((action) => action.action)).toEqual(['authenticate', 'reconnect', 'disable'])
    expect(mcpServerActions({ ...linear, status: 'connected' }).map((action) => action.label)).toEqual(['Re-authenticate', 'Reconnect', 'Disable', 'Clear authentication'])
    expect(mcpServerActions(github).map((action) => action.action)).toEqual(['reconnect', 'disable'])
    expect(mcpServerActions({ ...github, status: 'disabled' }).map((action) => action.action)).toEqual(['enable'])
  })
})

describe('McpSettings', () => {
  it('lists servers by scope and goes back to the menu with Backspace', async () => {
    const props = renderSettings(() => ({ servers: [github, linear] }))
    expect(await screen.findByText('1 connected · 1 needs authentication')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Project' })).getByText('github')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'User' })).getByText('linear')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Filter MCP servers' }), { key: 'Backspace' })
    expect(props.onBack).toHaveBeenCalled()
  })

  it('opens a server, runs an action by its key and shows the result', async () => {
    let status: ChatMcpServer['status'] = 'connected'
    const props = renderSettings((request) => {
      if (request.action === 'disable') status = 'disabled'
      return { servers: [{ ...github, status }] }
    })
    fireEvent.click(await screen.findByRole('option', { name: /github/ }))
    expect(screen.getByText('create_issue')).toBeInTheDocument()
    expect(screen.getByText('npx server-github')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('button', { name: /Disable/ }), { key: 'd' })
    expect(await screen.findByRole('button', { name: /Enable/ })).toBeInTheDocument()
    expect(props.load).toHaveBeenCalledWith({ action: 'disable', server: 'github' })
    // Escape steps back to the list rather than closing.
    fireEvent.keyDown(screen.getByRole('button', { name: /Enable/ }), { key: 'Escape' })
    expect(await screen.findByRole('textbox', { name: 'Filter MCP servers' })).toBeInTheDocument()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('opens the sign-in page an authenticate returns, with a link when the browser blocks it', async () => {
    const openUrl = vi.fn(() => false)
    renderSettings((request) => ({ servers: [linear], ...(request.action === 'authenticate' ? { authUrl: 'https://mcp.linear.app/authorize' } : {}) }), { openUrl })
    fireEvent.click(await screen.findByRole('option', { name: /linear/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Authenticate/ }))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://mcp.linear.app/authorize'))
    expect(screen.getByRole('link', { name: /Open sign-in page/ })).toHaveAttribute('href', 'https://mcp.linear.app/authorize')
  })

  it('keeps the last list and shows the error when a read fails', async () => {
    let fail = false
    renderSettings(() => fail ? { servers: [], error: "This session isn't running" } : { servers: [github] }, { pollMs: 20 })
    expect(await screen.findByText('github')).toBeInTheDocument()
    fail = true
    expect(await screen.findByRole('alert')).toHaveTextContent("This session isn't running")
    expect(screen.getByText('github')).toBeInTheDocument()
  })
})

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatRequest } from '../shared/agent-chats'
import { AgentChatRequestCard } from './AgentChatRequestCard'
import { createAgentChatsApi } from './agentChatsApi'

afterEach(cleanup)
const request: AgentChatRequest = { id: 'cr-abcd', callerPaneId: '%1', callerTargetId: 'stable', requestedBy: 'claude · main', reason: 'rate', requestedAt: 0,
  summary: { location: 'session', title: 'Review', branch: 'review', provider: 'claude-chat', permissionMode: 'default', promptPreview: 'Review the diff' } }

describe('AgentChatRequestCard', () => {
  it.each([['Open', 'accepted'], ['Dismiss', 'dismissed']] as const)('sends an authenticated %s decision and disables both actions in flight', async (button, decision) => {
    let resolve!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done }))
    const api = createAgentChatsApi('owner-token', fetcher)
    render(<AgentChatRequestCard request={request} onAnswer={api.answerRequest} />)
    expect(screen.getByRole('alertdialog')).toHaveAttribute('data-native-terminal-occluder', '')
    expect(screen.getByText('New session Review · review · claude-chat · default')).toBeInTheDocument()
    expect(screen.getByText('Over the rate limit')).toBeInTheDocument()
    expect(screen.getByText('Review the diff')).toHaveClass('agent-chat-request-preview')
    fireEvent.click(screen.getByRole('button', { name: button }))
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled()
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/agent-chats/requests/cr-abcd', expect.objectContaining({ method: 'POST', credentials: 'same-origin',
      headers: expect.objectContaining({ Authorization: 'Bearer owner-token' }), body: JSON.stringify({ decision }) }))
    resolve(new Response(JSON.stringify({ ok: true, decision })))
    await waitFor(() => expect(screen.getByRole('button', { name: button })).toBeEnabled())
  })
  it('shows depth limits and inline API errors, then allows retrying', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Parent has gone' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'Launch failed' })))
    const api = createAgentChatsApi('', fetcher)
    render(<AgentChatRequestCard request={{ ...request, reason: 'depth', summary: { ...request.summary, location: 'pane', branch: undefined, permissionMode: undefined } }} onAnswer={api.answerRequest} />)
    expect(screen.getByText('Opened by another chat (depth limit)')).toBeInTheDocument()
    expect(screen.getByText('Pane Review · no worktree · claude-chat')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Parent has gone')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Launch failed'))
  })
})

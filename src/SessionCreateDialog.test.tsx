// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionCreateDialog } from './SessionCreateDialog'
import { loadChatLaunch, saveChatLaunch } from './chatLaunchPreferences'
import type { CreateTmuxSessionRequest, TmuxCreateResponse } from '../shared/tmux-create'

afterEach(() => { cleanup(); window.localStorage.clear() })
const request = { id: 1, groupId: 'g', groupName: 'Work', suggestedDirectories: [] }

describe('Codex chat creation dialog', () => {
  it('offers Codex chat without Claude profiles and sends the chosen mode and prompt', async () => {
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({
      created: { kind: 'session', sessionId: '$1', sessionName: input.name, windowId: '@2', windowIndex: 0, windowName: 'chat', paneId: '%3', paneIndex: 0, panePath: '/tmp' },
      agentLaunch: { version: 1, provider: input.agent!.provider, paneId: '%3', mode: 'interactive-pty', state: 'initiated' },
    }))
    const profiles = vi.fn(async () => [])
    render(<SessionCreateDialog request={request} onClose={vi.fn()} onCreateSession={onCreateSession} loadClaudeProfiles={profiles} />)
    expect(screen.getByRole('option', { name: 'Codex chat' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Claude chat' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'codex' } })
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: '/tmp' } })
    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'codex-chat' } })
    expect(screen.queryByLabelText('Profile')).not.toBeInTheDocument()
    expect(profiles).not.toHaveBeenCalled()
    expect(screen.queryByRole('option', { name: 'Accept edits' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Permissions'), { target: { value: 'plan' } })
    fireEvent.change(screen.getByLabelText(/Opening prompt/), { target: { value: 'Hello Codex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    expect(onCreateSession.mock.calls[0]![0]).toMatchObject({ name: 'codex', cwd: '/tmp', agent: { provider: 'codex-chat', permissionMode: 'plan', prompt: 'Hello Codex' } })
    expect(onCreateSession.mock.calls[0]![0].agent).not.toHaveProperty('configDir')
    expect(loadChatLaunch('/tmp', 'codex-chat')).toEqual({ permissionMode: 'plan' })
  })
  it('stores Codex preferences separately and preserves the existing Claude preference format', () => {
    saveChatLaunch('/work', { configDir: '/u/.claudep', permissionMode: 'acceptEdits' })
    saveChatLaunch('/work', { permissionMode: 'bypassPermissions' }, 'codex-chat')
    expect(loadChatLaunch('/work')).toEqual({ configDir: '/u/.claudep', permissionMode: 'acceptEdits' })
    expect(loadChatLaunch('/work', 'codex-chat')).toEqual({ permissionMode: 'bypassPermissions' })
    expect(loadChatLaunch('/another', 'codex-chat')).toEqual({ permissionMode: 'bypassPermissions' })
  })
})

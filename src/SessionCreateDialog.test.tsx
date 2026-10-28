// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionCreateDialog } from './SessionCreateDialog'
import { agentPill, chooseAgent, choosePermission, menuLabels, permissionPill } from './newSessionTestHelpers'
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
    expect(menuLabels(agentPill()).map((label) => label.replace(/^\*/u, ''))).toEqual(expect.arrayContaining(['Codex chat', 'Claude chat']))
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'codex' } })
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: '/tmp' } })
    chooseAgent('codex-chat')
    expect(menuLabels(permissionPill())).toEqual(['*Workspace access', 'Read only', 'Full access'])
    choosePermission('Read only')
    fireEvent.change(screen.getByLabelText(/Opening prompt/), { target: { value: 'Hello Codex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
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


describe('Cursor chat creation dialog', () => {
  it('offers Cursor beside Codex, defaults to full access and remembers the selected mode', async () => {
    const onCreateSession = vi.fn(async (input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> => ({
      created: { kind: 'session', sessionId: '$1', sessionName: input.name, windowId: '@2', windowIndex: 0, windowName: 'chat', paneId: '%3', paneIndex: 0, panePath: '/tmp' },
      agentLaunch: { version: 1, provider: input.agent!.provider, paneId: '%3', mode: 'interactive-pty', state: 'initiated' },
    }))
    const profiles = vi.fn(async () => [])
    render(<SessionCreateDialog request={request} onClose={vi.fn()} onCreateSession={onCreateSession} loadClaudeProfiles={profiles} />)
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'cursor' } })
    fireEvent.change(screen.getByLabelText(/Working directory/), { target: { value: '/tmp' } })
    expect(menuLabels(agentPill()).map((label) => label.replace(/^\*/u, ''))).toEqual(expect.arrayContaining(['Cursor chat', 'Cursor']))
    chooseAgent('cursor-chat')
    expect(menuLabels(permissionPill())).toEqual(['*Full access', 'Sandboxed', 'Auto-review', 'Plan'])
    choosePermission('Auto-review')
    fireEvent.change(screen.getByLabelText(/Opening prompt/), { target: { value: 'Hello Cursor' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledOnce())
    expect(onCreateSession.mock.calls[0]![0].agent).toEqual({ provider: 'cursor-chat', permissionMode: 'auto', prompt: 'Hello Cursor' })
    expect(loadChatLaunch('/tmp', 'cursor-chat')).toEqual({ permissionMode: 'auto' })
  })
  it('keeps Cursor preferences isolated and discards modes or profiles belonging to Claude', () => {
    expect(loadChatLaunch('/work', 'cursor-chat')).toEqual({ permissionMode: 'bypassPermissions' })
    saveChatLaunch('/work', { configDir: '/u/.claudep', permissionMode: 'acceptEdits' })
    saveChatLaunch('/work', { permissionMode: 'plan' }, 'codex-chat')
    saveChatLaunch('/work', { configDir: '/ignored', permissionMode: 'auto' }, 'cursor-chat')
    expect(loadChatLaunch('/work')).toEqual({ configDir: '/u/.claudep', permissionMode: 'acceptEdits' })
    expect(loadChatLaunch('/work', 'codex-chat')).toEqual({ permissionMode: 'plan' })
    expect(loadChatLaunch('/another', 'cursor-chat')).toEqual({ permissionMode: 'auto' })
    expect(JSON.parse(window.localStorage.getItem('commando.chat-launch.by-repo')!)).toMatchObject({ 'cursor:/work': { permissionMode: 'auto' } })
    saveChatLaunch('/work', { permissionMode: 'acceptEdits' }, 'cursor-chat')
    expect(loadChatLaunch('/work', 'cursor-chat')).toEqual({ permissionMode: 'bypassPermissions' })
  })
})

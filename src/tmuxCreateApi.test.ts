import { describe, expect, it, vi } from 'vitest'
import { TmuxAgentLaunchCompatibilityError } from '../shared/tmux-create'
import { createTmuxHttpApi } from './tmuxCreateApi'

const created = { kind: 'session' as const, sessionId: '$1', sessionName: 'cursor', windowId: '@1', windowIndex: 0, windowName: 'agent', paneId: '%1', paneIndex: 0, panePath: '/worktree' }

describe('the tmux creation client', () => {
  it.each([
    undefined,
    { version: 1, provider: 'claude', paneId: '%1', mode: 'interactive-pty', state: 'initiated' },
    { version: 1, provider: 'cursor', paneId: '%2', mode: 'interactive-pty', state: 'initiated' },
    { version: 1, provider: 'cursor', paneId: '%1', mode: 'detached', state: 'initiated' },
    { version: 2, provider: 'cursor', paneId: '%1', mode: 'interactive-pty', state: 'initiated' },
    { version: 1, provider: 'cursor', paneId: '%1', mode: 'interactive-pty', state: 'done' },
  ])('preserves the created target on missing or mismatched acknowledgment %j without retrying', async (agentLaunch) => {
    const worktree = { path: '/worktree', branch: 'cursor', base: 'HEAD', reusedBranch: false }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ created, worktree, agentLaunch }), { status: 201 }))
    const result = await createTmuxHttpApi('', fetcher).createSession({ name: 'cursor', agent: { provider: 'cursor' } }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(TmuxAgentLaunchCompatibilityError)
    expect((result as TmuxAgentLaunchCompatibilityError).response.created).toEqual(created)
    expect((result as TmuxAgentLaunchCompatibilityError).response.worktree).toEqual(worktree)
    expect((result as Error).message).toContain('Update Commando on the daemon host')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('continues creating Shell sessions against old daemons without agent acknowledgment', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ created }), { status: 201 }))
    await expect(createTmuxHttpApi('', fetcher).createSession({ name: 'cursor' })).resolves.toEqual({ created })
  })
  it('sends one pane-owned launch request and returns the reported target', async () => {
    const response = { created, agentLaunch: { version: 1, provider: 'cursor', paneId: '%1', mode: 'interactive-pty', state: 'initiated' } }
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 201 }))
    const api = createTmuxHttpApi('fixture', fetcher)
    const request = { name: 'cursor', cwd: '/worktree', agent: { provider: 'cursor' as const, prompt: "Leo's spec\n$HOME" } }
    await expect(api.createSession(request)).resolves.toEqual(response)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith('/api/tmux/sessions', expect.objectContaining({ body: JSON.stringify(request) }))
  })
  it('reports a missing CLI error without retrying creation', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Cannot start agent: executable not found on the daemon PATH' }), { status: 400 }))
    await expect(createTmuxHttpApi('', fetcher).createSession({ name: 'cursor', agent: { provider: 'cursor' } })).rejects.toThrow('executable not found')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

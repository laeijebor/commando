import { describe, expect, it, vi } from 'vitest'
import { createSessionManagementApi } from './sessionManagementApi'

describe('session management API client', () => {
  it('requests linked worktree deletion with the exact session confirmation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, sessionId: '$1' }))
    const api = createSessionManagementApi('token', fetcher)

    await api.deleteSession('$1', true)

    expect(fetcher).toHaveBeenCalledWith('/api/session-management/sessions/%241/delete', expect.objectContaining({
      method: 'DELETE',
       body: JSON.stringify({ confirmSessionId: '$1', deleteWorktree: true, confirmAuxiliarySessionIds: [] }),
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }))
  })

  it('previews dependent sessions and confirms their exact ids for deletion', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ auxiliarySessions: [{ id: '$2', name: 'native_app-work' }] }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    const api = createSessionManagementApi('token', fetcher)
    await expect(api.previewWorktreeDeletion('$1')).resolves.toEqual({ auxiliarySessions: [{ id: '$2', name: 'native_app-work' }] })
    await api.deleteSession('$1', true, ['$2'])
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/session-management/sessions/%241/delete-preview', expect.objectContaining({ credentials: 'same-origin' }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/session-management/sessions/%241/delete', expect.objectContaining({
      body: JSON.stringify({ confirmSessionId: '$1', deleteWorktree: true, confirmAuxiliarySessionIds: ['$2'] }),
    }))
  })

  it('archives a session and restores a saved archive', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ sessionId: '$9' }))
    const api = createSessionManagementApi('token', fetcher)
    await api.archiveSession('$1')
    await expect(api.restoreSession('archive-id')).resolves.toBe('$9')
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/session-management/sessions/%241/archive', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ confirmSessionId: '$1' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/session-management/archives/archive-id/restore', expect.objectContaining({ method: 'POST' }))
  })

  it('pauses a session and archives a paused one, returning any kept worktree', async () => {
    const archive = { id: 'archive-id', name: 'work', createdAt: 1, windowCount: 1, paneCount: 1 }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, archive: { ...archive, paused: true } }))
      .mockResolvedValueOnce(Response.json({ ok: true, archive, worktreeKept: 'locked' }))
    const api = createSessionManagementApi('token', fetcher)
    await expect(api.pauseSession('$1')).resolves.toMatchObject({ archive: { paused: true } })
    await expect(api.archivePausedSession('archive-id')).resolves.toMatchObject({ worktreeKept: 'locked' })
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/session-management/sessions/%241/pause', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ confirmSessionId: '$1' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/session-management/archives/archive-id/archive', expect.objectContaining({ method: 'POST' }))
  })
})

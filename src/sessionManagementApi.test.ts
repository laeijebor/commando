import { describe, expect, it, vi } from 'vitest'
import { createSessionManagementApi } from './sessionManagementApi'

describe('session management API client', () => {
  it('sends an exact confirmation when closing a window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, windowId: '@7' }))
    const api = createSessionManagementApi('token', fetcher)

    await api.deleteWindow('@7')

    expect(fetcher).toHaveBeenCalledWith('/api/session-management/windows/%407/delete', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ confirmWindowId: '@7' }),
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }))
  })
})

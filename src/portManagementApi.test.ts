import { describe, expect, it, vi } from 'vitest'
import { createPortManagementApi } from './portManagementApi'

describe('port management API client', () => {
  it('sends exact listener and session confirmations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }))
    const api = createPortManagementApi('token', fetcher)
    const port = { port: 3000, processName: 'node', sessionId: '$1', paneId: '%2' }
    const secondPort = { port: 5173, processName: 'node', sessionId: '$1', paneId: '%3' }

    await api.killPort(port)
    await api.killSessionPorts('$1', [port, secondPort])

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/port-management/ports/kill', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ sessionId: '$1', paneId: '%2', port: 3000, confirmPort: 3000 }),
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/port-management/sessions/%241/kill', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({
        confirmSessionId: '$1',
        targets: [{ paneId: '%2', port: 3000 }, { paneId: '%3', port: 5173 }],
      }),
    }))
  })
})

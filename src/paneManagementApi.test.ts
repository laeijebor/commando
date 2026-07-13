import { describe, expect, it, vi } from 'vitest'
import { createPaneManagementApi } from './paneManagementApi'

describe('pane management API client', () => {
  it('sends authenticated rename and confirmed delete requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }))
    const api = createPaneManagementApi('secret', fetcher)

    await api.renamePane('%12', 'tests')
    await api.deletePane('%12')

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/pane-management/panes/%2512/rename', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'tests' }),
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/pane-management/panes/%2512/delete', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ confirmPaneId: '%12' }),
    }))
  })

  it('surfaces the server error message', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: 'Tmux pane does not exist' }, { status: 404 }),
    )
    const api = createPaneManagementApi('', fetcher)

    await expect(api.renamePane('%99', 'gone')).rejects.toThrow('Tmux pane does not exist')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createPaneManagementApi } from './paneManagementApi'

describe('pane management API client', () => {
  it('sends authenticated pane management and mark requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }))
    const api = createPaneManagementApi('secret', fetcher)

    await api.renamePane('%12', 'tests')
    await api.deletePane('%12')
    await api.openPanePath('%12')
    await api.revealPaneScreenshot('%12', '0123456789abcdef', 'shot one.png')
    await api.runInPanePath('%12', 'open .')
    await api.setPaneMark('%12', 'target-12', 'Waiting for PR', 'amber')
    await api.acknowledgePaneMark('%12', 'target-12')
    await api.clearPaneMark('%12', 'target-12')

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/pane-management/panes/%2512/rename', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'tests' }),
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/pane-management/panes/%2512/delete', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ confirmPaneId: '%12' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(3, '/api/pane-management/panes/%2512/open', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(4, '/api/pane-management/panes/%2512/reveal', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ folderId: '0123456789abcdef', file: 'shot one.png' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(5, '/api/pane-management/panes/%2512/run', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ command: 'open .' }),
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(6, '/api/pane-management/panes/%2512/mark', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ targetId: 'target-12', label: 'Waiting for PR', tone: 'amber' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(7, '/api/pane-management/panes/%2512/mark/acknowledge', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ targetId: 'target-12' }),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(8, '/api/pane-management/panes/%2512/mark', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ targetId: 'target-12' }),
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

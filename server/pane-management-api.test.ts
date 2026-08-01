import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneManagementApi } from './pane-management-api.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function startApi(api: PaneManagementApi): Promise<string> {
  const server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('pane management API', () => {
  it('opens the server-resolved path for an existing pane', async () => {
    const openFolder = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
    const api = new PaneManagementApi({
      currentPaneIds: () => ['%12'],
      panePath: (paneId) => paneId === '%12' ? '/tmp/project' : undefined,
      openFolder,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2512/open`, { method: 'POST' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, paneId: '%12' })
    expect(openFolder).toHaveBeenCalledWith('/tmp/project')
  })

  it('does not open a client-selected or stale pane path', async () => {
    const openFolder = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
    const api = new PaneManagementApi({
      currentPaneIds: () => [],
      panePath: () => '/tmp/client-path',
      openFolder,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2599/open`, { method: 'POST' })

    expect(response.status).toBe(404)
    expect(openFolder).not.toHaveBeenCalled()
  })
})

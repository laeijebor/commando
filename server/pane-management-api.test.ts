import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneManagementApi } from './pane-management-api.js'
import { TmuxPaneActions } from './tmux-pane-actions.js'
import type { TmuxProcessExecutor } from './tmux-session-actions.js'

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

  it('runs a validated command from the server-resolved pane path', async () => {
    const runCommand = vi.fn<(command: string, cwd: string) => Promise<void>>().mockResolvedValue(undefined)
    const api = new PaneManagementApi({
      currentPaneIds: () => ['%12'],
      panePath: (paneId) => paneId === '%12' ? '/tmp/project' : undefined,
      runCommand,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2512/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'open .' }),
    })

    expect(response.status).toBe(202)
    expect(runCommand).toHaveBeenCalledWith('open .', '/tmp/project')
  })

  it('rejects invalid commands before launching them', async () => {
    const runCommand = vi.fn<(command: string, cwd: string) => Promise<void>>().mockResolvedValue(undefined)
    const api = new PaneManagementApi({
      currentPaneIds: () => ['%12'],
      panePath: () => '/tmp/project',
      runCommand,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2512/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'open .\nwhoami' }),
    })

    expect(response.status).toBe(400)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('releases resize ownership and deletes an exactly confirmed pane', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const beforePaneDeleted = vi.fn().mockResolvedValue(undefined)
    const onPanesChanged = vi.fn().mockResolvedValue(undefined)
    const api = new PaneManagementApi({
      actions: new TmuxPaneActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'qa' }),
      currentPaneIds: () => ['%12'],
      panePath: () => undefined,
      beforePaneDeleted,
      onPanesChanged,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2512/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmPaneId: '%12' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, paneId: '%12' })
    expect(beforePaneDeleted).toHaveBeenCalledWith('%12')
    expect(execute).toHaveBeenCalledWith(
      'tmux',
      ['-L', 'qa', 'kill-pane', '-t', '%12'],
      expect.objectContaining({ shell: false, timeout: 3_000 }),
    )
    expect(onPanesChanged).toHaveBeenCalled()
  })

  it('requires the exact pane confirmation id', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const api = new PaneManagementApi({
      actions: new TmuxPaneActions(execute, {}),
      currentPaneIds: () => ['%12'],
      panePath: () => undefined,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2512/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmPaneId: '%13' }),
    })

    expect(response.status).toBe(400)
    expect(execute).not.toHaveBeenCalled()
  })
})

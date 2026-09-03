import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneManagementApi } from './pane-management-api.js'
import { TmuxPaneActions } from './tmux-pane-actions.js'
import type { TmuxProcessExecutor } from './tmux-session-actions.js'
import { PaneScreenshotRegistry } from './pane-screenshots.js'

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
  it('sets, acknowledges, and clears a mark through the pane target id', async () => {
    const targetId = '11111111-1111-4111-8111-111111111111'
    const mark = { targetId, label: 'Waiting for PR', tone: 'amber' as const, markedAt: 100, activityCount: 2 }
    const setPaneMark = vi.fn().mockResolvedValue({ ...mark, activityCount: 0 })
    const acknowledgePaneMark = vi.fn().mockResolvedValue(mark)
    const clearPaneMark = vi.fn().mockResolvedValue(true)
    const onPaneMarkChanged = vi.fn()
    const api = new PaneManagementApi({
      currentPaneIds: () => ['%12'],
      panePath: () => undefined,
      paneTargetId: () => targetId,
      setPaneMark,
      acknowledgePaneMark,
      clearPaneMark,
      onPaneMarkChanged,
    })
    const baseUrl = await startApi(api)
    const markUrl = `${baseUrl}/api/pane-management/panes/%2512/mark`

    const setResponse = await fetch(markUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId, label: 'Waiting for PR', tone: 'amber' }),
    })
    const acknowledgeResponse = await fetch(`${markUrl}/acknowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId }),
    })
    const clearResponse = await fetch(markUrl, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId }),
    })

    expect(setResponse.status).toBe(200)
    expect(acknowledgeResponse.status).toBe(200)
    expect(clearResponse.status).toBe(200)
    expect(setPaneMark).toHaveBeenCalledWith(targetId, { label: 'Waiting for PR', tone: 'amber' })
    expect(acknowledgePaneMark).toHaveBeenCalledWith(targetId)
    expect(clearPaneMark).toHaveBeenCalledWith(targetId)
    expect(onPaneMarkChanged).toHaveBeenNthCalledWith(1, { type: 'upsert', mark: { ...mark, activityCount: 0 } })
    expect(onPaneMarkChanged).toHaveBeenNthCalledWith(2, { type: 'upsert', mark })
    expect(onPaneMarkChanged).toHaveBeenNthCalledWith(3, { type: 'remove', targetId })
  })

  it('rejects invalid pane mark input before changing the store', async () => {
    const setPaneMark = vi.fn()
    const api = new PaneManagementApi({
      currentPaneIds: () => ['%12'],
      panePath: () => undefined,
      paneTargetId: () => '11111111-1111-4111-8111-111111111111',
      setPaneMark,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2512/mark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId: '11111111-1111-4111-8111-111111111111', label: '', tone: 'cyan', activityCount: 99 }),
    })

    expect(response.status).toBe(400)
    expect(setPaneMark).not.toHaveBeenCalled()
  })

  it('rejects a delayed mark request after the pane id points at another target', async () => {
    const setPaneMark = vi.fn()
    const api = new PaneManagementApi({
      currentPaneIds: () => ['%12'],
      panePath: () => undefined,
      paneTargetId: () => '22222222-2222-4222-8222-222222222222',
      setPaneMark,
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2512/mark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetId: '11111111-1111-4111-8111-111111111111',
        label: 'Waiting for PR',
        tone: 'amber',
      }),
    })

    expect(response.status).toBe(409)
    expect(setPaneMark).not.toHaveBeenCalled()
  })

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

  it('reveals only files and folders registered for the source pane', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'commando-pane-reveal-')))
    try {
      const folder = join(parent, 'shots')
      const outside = join(parent, 'outside.png')
      await import('node:fs/promises').then(({ mkdir }) => mkdir(folder))
      await writeFile(join(folder, 'one.png'), 'png')
      await writeFile(outside, 'outside')
      await symlink(outside, join(folder, 'escaped.png'))
      const screenshots = new PaneScreenshotRegistry()
      const registration = await screenshots.register('%12', folder)
      const openFolder = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
      const revealFile = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
      const api = new PaneManagementApi({
        currentPaneIds: () => ['%12'],
        panePath: () => folder,
        screenshots,
        openFolder,
        revealFile,
      })
      const baseUrl = await startApi(api)
      const revealUrl = `${baseUrl}/api/pane-management/panes/%2512/reveal`
      const post = (body: unknown) => fetch(revealUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      await expect(post({ folderId: 'ffffffffffffffff' })).resolves.toMatchObject({ status: 404 })
      await expect(post({ folderId: registration.id, file: 'escaped.png' })).resolves.toMatchObject({ status: 400 })
      await expect(post({ folderId: registration.id })).resolves.toMatchObject({ status: 200 })
      await expect(post({ folderId: registration.id, file: 'one.png' })).resolves.toMatchObject({ status: 200 })
      expect(openFolder).toHaveBeenCalledWith(folder)
      expect(revealFile).toHaveBeenCalledWith(join(folder, 'one.png'))
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
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

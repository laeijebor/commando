import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneManagementApi } from './pane-management-api.js'
import { TmuxPaneActions } from './tmux-pane-actions.js'
import type { TmuxProcessExecutor } from './tmux-session-actions.js'
import { REDLINE_ARTIFACT_TTL_MS, RedlineArtifactRegistry } from './redline-artifacts.js'
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

  it("reports a session's last pane as emptied, respawned in its current folder", async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValueOnce({ stdout: '1 1\n', stderr: '' }).mockResolvedValue({ stdout: '', stderr: '' })
    const api = new PaneManagementApi({
      actions: new TmuxPaneActions(execute, {}),
      currentPaneIds: () => ['%12'],
      panePath: () => '/work/app',
    })
    const baseUrl = await startApi(api)

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2512/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmPaneId: '%12' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, paneId: '%12', emptied: true })
    expect(execute.mock.calls[1][1].slice(0, 6)).toEqual(['respawn-pane', '-k', '-t', '%12', '-c', '/work/app'])
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

  it('starts the Terminal-tab shell for an existing pane in its folder', async () => {
    const actions = new TmuxPaneActions(vi.fn<TmuxProcessExecutor>(), {})
    const ensureShell = vi.spyOn(actions, 'ensureShell').mockResolvedValue('%30')
    const onPanesChanged = vi.fn()
    const baseUrl = await startApi(new PaneManagementApi({ actions, currentPaneIds: () => ['%12'], panePath: () => '/work/app', onPanesChanged }))

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2512/shell`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, paneId: '%12', shellPaneId: '%30' })
    expect(ensureShell).toHaveBeenCalledWith('%12', '/work/app')
    expect(onPanesChanged).toHaveBeenCalledOnce()

    expect((await fetch(`${baseUrl}/api/pane-management/panes/%2599/shell`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/pane-management/panes/%2512/shell`)).status).toBe(405)
    expect(ensureShell).toHaveBeenCalledOnce()
  })

  it('captures an existing pane screen with its colour escapes', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '\u001b[32mok\u001b[0m\n', stderr: '' } as never)
    const actions = new TmuxPaneActions(execute, {})
    const baseUrl = await startApi(new PaneManagementApi({ actions, currentPaneIds: () => ['%12'], panePath: () => undefined }))

    const response = await fetch(`${baseUrl}/api/pane-management/panes/%2512/capture`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ paneId: '%12', text: '\u001b[32mok\u001b[0m\n' })
    expect(execute).toHaveBeenCalledWith('tmux', ['capture-pane', '-p', '-e', '-t', '%12'], expect.objectContaining({ maxBuffer: 1024 * 1024 }))

    expect((await fetch(`${baseUrl}/api/pane-management/panes/%2599/capture`)).status).toBe(404)
    const post = await fetch(`${baseUrl}/api/pane-management/panes/%2512/capture`, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('reports when panes were last viewed and which are on screen', async () => {
    const views = { viewedAt: { '%12': 100 }, viewing: ['%13'] }
    const baseUrl = await startApi(new PaneManagementApi({ currentPaneIds: () => ['%12'], panePath: () => undefined, paneViews: () => views }))

    const response = await fetch(`${baseUrl}/api/pane-management/views`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(views)
    expect((await fetch(`${baseUrl}/api/pane-management/views`, { method: 'POST' })).status).toBe(405)
  })
})

describe('resource actions', () => {
  async function setup(overrides: Partial<ConstructorParameters<typeof PaneManagementApi>[0]> = {}) {
    const { mkdir } = await import('node:fs/promises')
    const dir = await mkdtemp(join(tmpdir(), 'pane-resources-'))
    const home = join(dir, 'home')
    const cwd = join(dir, 'cwd')
    await mkdir(home)
    await mkdir(cwd)
    const execute = vi.fn().mockResolvedValue(undefined)
    const register = vi.fn().mockReturnValue({ id: '0123456789abcdef' })
    const openResourceTile = vi.fn().mockReturnValue('w-12345678')
    const api = new PaneManagementApi({
      currentPaneIds: () => ['%12'], panePath: () => cwd, platform: 'darwin', resourceHome: home,
      resourceTempRoots: [], resourceExecutor: execute, artifacts: { register, hasDirectory: () => false }, openResourceTile, ...overrides,
    })
    const baseUrl = await startApi(api)
    const request = (body: unknown) => fetch(`${baseUrl}/api/pane-management/panes/%2512/resource`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { dir, home, cwd, execute, register, openResourceTile, request }
  }

  it('rejects paths outside allowed roots, including symlink escapes', async () => {
    const { dir, home, request, execute } = await setup()
    try {
      const outside = join(dir, 'outside.txt')
      await writeFile(outside, 'secret')
      const link = join(home, 'escape.txt')
      await symlink(outside, link)
      expect((await request({ path: outside, action: 'open' })).status).toBe(403)
      expect((await request({ path: link, action: 'editor' })).status).toBe(403)
      expect(execute).not.toHaveBeenCalled()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('opens documents, falls back to reveal, opens the editor, and registers tile parents', async () => {
    const { chmod, mkdir } = await import('node:fs/promises')
    const { dir, home, cwd, request, execute, register, openResourceTile } = await setup()
    try {
      const artifacts = join(cwd, '.redline')
      await mkdir(artifacts)
      const doc = join(artifacts, 'my # page.html')
      const code = join(cwd, 'test.ts')
      await writeFile(doc, '<h1>Hello</h1>', { mode: 0o600 })
      await writeFile(code, 'export {}', { mode: 0o600 })
      expect(await (await request({ path: doc, action: 'open' })).json()).toEqual({ ok: true, performed: 'open' })
      expect(execute).toHaveBeenLastCalledWith('/usr/bin/open', [await realpath(doc)], expect.objectContaining({ shell: false }))
      expect(await (await request({ path: code, action: 'open' })).json()).toEqual({ ok: true, performed: 'reveal' })
      expect(execute).toHaveBeenLastCalledWith('/usr/bin/open', ['-R', await realpath(code)], expect.anything())
      await chmod(doc, 0o700)
      expect(await (await request({ path: doc, action: 'open' })).json()).toMatchObject({ performed: 'reveal' })
      expect((await request({ path: code, action: 'editor', line: 12 })).status).toBe(200)
      expect((await request({ path: home, action: 'editor' })).status).toBe(400)
      expect(await (await request({ path: doc, action: 'tile' })).json()).toEqual({ ok: true, performed: 'tile', webPaneId: 'w-12345678' })
      expect(register).toHaveBeenCalledWith(await realpath(artifacts))
      expect(openResourceTile).toHaveBeenCalledWith('%12', '/redline/artifacts/0123456789abcdef/my%20%23%20page.html')
      expect((await request({ path: code, action: 'tile' })).status).toBe(400)
      expect((await request({ path: home, action: 'open' })).status).toBe(200)
      expect((await request({ path: code, action: 'reveal' })).status).toBe(200)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('never registers a broad parent directory and falls back to the safe open action', async () => {
    const { chmod, mkdir } = await import('node:fs/promises')
    const temp = await mkdtemp(join(tmpdir(), 'resource-broad-temp-'))
    const { dir, home, cwd, request, execute, register, openResourceTile } = await setup({ resourceTempRoots: [temp] })
    try {
      const direct = join(home, 'page.html')
      await writeFile(direct, '<h1>Hello</h1>', { mode: 0o600 })
      expect(await (await request({ path: direct, action: 'tile' })).json()).toEqual({ ok: true, performed: 'open' })
      expect(execute).toHaveBeenLastCalledWith('/usr/bin/open', [await realpath(direct)], expect.anything())
      await chmod(direct, 0o700)
      expect(await (await request({ path: direct, action: 'tile' })).json()).toEqual({ ok: true, performed: 'reveal' })
      expect(execute).toHaveBeenLastCalledWith('/usr/bin/open', ['-R', await realpath(direct)], expect.anything())
      const temporary = join(temp, 'page.svg')
      await writeFile(temporary, '<svg/>', { mode: 0o600 })
      expect(await (await request({ path: temporary, action: 'tile' })).json()).toEqual({ ok: true, performed: 'open' })
      expect(register).not.toHaveBeenCalled()
      expect(openResourceTile).not.toHaveBeenCalled()
      const subfolder = join(cwd, '.redline')
      await mkdir(subfolder)
      const nested = join(subfolder, 'page.html')
      await writeFile(nested, '<h1>Hello</h1>')
      expect(await (await request({ path: nested, action: 'tile' })).json()).toMatchObject({ performed: 'tile', webPaneId: 'w-12345678' })
      expect(register).toHaveBeenCalledExactlyOnceWith(await realpath(subfolder))
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('copies image, SVG and PDF tiles into reusable private snapshots of just that file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-tile-snapshots-'))
    const registry = new RedlineArtifactRegistry()
    const register = vi.fn((directory: string) => registry.register(directory))
    const { dir, cwd, request, openResourceTile } = await setup({ resourceTileRoot: join(root, 'tiles'), artifacts: { register, hasDirectory: registry.hasDirectory.bind(registry) } })
    try {
      await writeFile(join(cwd, 'secret.txt'), 'must not be served')
      for (const extension of ['png', 'svg', 'pdf']) {
        const path = join(cwd, `preview.${extension}`)
        await writeFile(path, 'preview bytes')
        expect(await (await request({ path, action: 'tile' })).json()).toMatchObject({ performed: 'tile' })
        const directory = register.mock.lastCall![0]
        const artifactId = register.mock.results.at(-1)!.value!.id
        expect(directory).toMatch(new RegExp(`/tiles/[a-f0-9]{16}$`))
        expect(await readdir(directory)).toEqual([`preview.${extension}`])
        expect(await readFile(join(directory, `preview.${extension}`), 'utf8')).toBe('preview bytes')
        expect((await stat(directory)).mode & 0o777).toBe(0o700)
        expect((await stat(join(root, 'tiles'))).mode & 0o777).toBe(0o700)
        expect(await realpath(directory)).not.toBe(await realpath(cwd))
        expect((await request({ path, action: 'tile' })).status).toBe(200)
        expect(register).toHaveBeenLastCalledWith(directory)
        await writeFile(path, 'updated preview bytes')
        expect((await request({ path, action: 'tile' })).status).toBe(200)
        expect(register.mock.lastCall![0]).toBe(directory)
        expect(register.mock.results.at(-1)!.value!.id).toBe(artifactId)
        expect(openResourceTile).toHaveBeenLastCalledWith('%12', `/redline/artifacts/${artifactId}/preview.${extension}`)
        expect(await readFile(join(directory, `preview.${extension}`), 'utf8')).toBe('updated preview bytes')
        expect(await readdir(directory)).toEqual([`preview.${extension}`])
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prunes old unregistered snapshots at most hourly and keeps old registered ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-tile-pruning-'))
    let now = Date.now()
    const expired = join(root, '0'.repeat(16))
    const recent = join(root, '1'.repeat(16))
    const later = join(root, '2'.repeat(16))
    const retained = join(root, '3'.repeat(16))
    const registry = new RedlineArtifactRegistry({ now: () => now })
    const oldTime = new Date(now - REDLINE_ARTIFACT_TTL_MS - 1_000)
    await mkdir(expired)
    await mkdir(recent)
    await writeFile(join(expired, 'old.png'), 'old')
    await utimes(expired, oldTime, oldTime)
    await mkdir(retained)
    await writeFile(join(retained, 'kept.png'), 'still shown by an open tile')
    await utimes(retained, oldTime, oldTime)
    const { id: retainedId } = registry.register(retained)
    const { dir, cwd, request } = await setup({ resourceTileRoot: root, resourceNow: () => now, artifacts: registry })
    try {
      const path = join(cwd, 'preview.png')
      await writeFile(path, 'preview bytes')
      expect((await request({ path, action: 'tile' })).status).toBe(200)
      await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await stat(retained)).mtimeMs).toBeLessThan(now - REDLINE_ARTIFACT_TTL_MS)
      expect(registry.resolve(retainedId, 'kept.png')).toBe(join(await realpath(retained), 'kept.png'))
      expect((await stat(recent)).isDirectory()).toBe(true)
      await mkdir(later)
      await utimes(later, oldTime, oldTime)
      expect((await request({ path, action: 'tile' })).status).toBe(200)
      expect((await stat(later)).isDirectory()).toBe(true)
      now += 60 * 60 * 1000
      expect((await request({ path, action: 'tile' })).status).toBe(200)
      await expect(stat(later)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(registry.resolve(retainedId, 'kept.png')).toBe(join(await realpath(retained), 'kept.png'))
      expect((await stat(recent)).isDirectory()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  })

  it('registers the nearest named artifact ancestor for HTML and falls back for other folders', async () => {
    let paneCwd: string | undefined
    const { dir, home, cwd, request, register, openResourceTile, execute } = await setup({ panePath: () => paneCwd })
    paneCwd = cwd
    try {
      const allowed = new Map([
        ['.redline/x.html', '.redline'], ['.redline/sub/page.html', '.redline'],
        ['.redline/sub/.canvas/page.html', '.redline/sub/.canvas'], ['.redline/.private/page.html', '.redline'],
        ['.canvas/x.html', '.canvas'], ['.pr/x.htm', '.pr'],
      ])
      for (const relative of [...allowed.keys(), 'index.html', 'public/x.html', '.secret/x.html', 'public/.secret/x.html', '.commando/x.html']) {
        const path = join(cwd, relative)
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, '<h1>Preview</h1>', { mode: 0o600 })
        register.mockClear()
        const result = await (await request({ path, action: 'tile' })).json()
        const artifact = allowed.get(relative)
        if (artifact) {
          expect(result).toMatchObject({ performed: 'tile' })
          expect(register).toHaveBeenCalledExactlyOnceWith(await realpath(join(cwd, artifact)))
          expect(openResourceTile).toHaveBeenLastCalledWith('%12', `/redline/artifacts/0123456789abcdef/${relative.slice(artifact.length + 1)}`)
        } else {
          expect(result).toEqual({ ok: true, performed: 'open' })
          expect(register).not.toHaveBeenCalled()
          expect(execute).toHaveBeenLastCalledWith('/usr/bin/open', [await realpath(path)], expect.anything())
        }
      }
      const downloads = join(home, 'Downloads')
      await mkdir(downloads)
      const outside = join(downloads, 'x.html')
      await writeFile(outside, '<h1>Outside cwd</h1>', { mode: 0o600 })
      paneCwd = home
      register.mockClear()
      expect(await (await request({ path: outside, action: 'tile' })).json()).toEqual({ ok: true, performed: 'open' })
      expect(register).not.toHaveBeenCalled()
      const link = join(cwd, 'preview')
      await symlink(downloads, link)
      expect(await (await request({ path: join(link, 'x.html'), action: 'tile' })).json()).toEqual({ ok: true, performed: 'open' })
      expect(register).not.toHaveBeenCalled()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('never registers daemon state or artifact folders outside the real pane cwd', async () => {
    let paneCwd: string | undefined
    const { dir, home, cwd, request, register, execute } = await setup({ panePath: () => paneCwd })
    try {
      // The home cwd allows both paths through containment, so the state guard must reject them.
      paneCwd = home
      const state = join(home, '.commando')
      for (const relative of ['x/y.html', '.redline/y.html']) {
        const path = join(state, relative)
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, '<h1>Must not publish state</h1>', { mode: 0o600 })
        expect(await (await request({ path, action: 'tile' })).json()).toEqual({ ok: true, performed: 'open' })
        expect(register).not.toHaveBeenCalled()
        expect(execute).toHaveBeenLastCalledWith('/usr/bin/open', [await realpath(path)], expect.anything())
      }
      const outside = join(home, '.redline', 'page.html')
      await mkdir(join(outside, '..'), { recursive: true })
      await writeFile(outside, '<h1>Outside pane cwd</h1>', { mode: 0o600 })
      paneCwd = cwd
      expect(await (await request({ path: outside, action: 'tile' })).json()).toEqual({ ok: true, performed: 'open' })
      // A symlink in cwd must not turn the outside artifact directory into an allowed one.
      await symlink(join(home, '.redline'), join(cwd, '.redline'))
      expect(await (await request({ path: join(cwd, '.redline', 'page.html'), action: 'tile' })).json()).toEqual({ ok: true, performed: 'open' })
      expect(register).not.toHaveBeenCalled()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('only registers per-file snapshot directories when serving files under daemon state', async () => {
    const { dir, home, cwd, request, register } = await setup()
    try {
      const path = join(cwd, 'preview.png')
      await writeFile(path, 'preview bytes')
      expect((await request({ path, action: 'tile' })).status).toBe(200)
      const root = await realpath(join(home, '.commando', 'resource-tiles'))
      const directory = register.mock.lastCall![0] as string
      expect(directory).toMatch(new RegExp(`/resource-tiles/[a-f0-9]{16}$`))
      expect(join(directory, '..')).toBe(root)
      expect(await readdir(directory)).toEqual(['preview.png'])
      // Redirecting the per-file folder to the state root cannot grant the snapshot exception.
      await rm(directory, { recursive: true })
      await symlink(join(home, '.commando'), directory)
      register.mockClear()
      expect(await (await request({ path, action: 'tile' })).json()).toEqual({ ok: true, performed: 'open' })
      expect(register).not.toHaveBeenCalled()
      await expect(stat(join(home, '.commando', 'preview.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('presents a slides deck folder or a page in it as a canvas tile, and nothing else', async () => {
    const { mkdir, realpath } = await import('node:fs/promises')
    const { dir, home, cwd, request, register, openResourceTile } = await setup()
    try {
      const deck = join(cwd, 'talk')
      await mkdir(deck)
      const page = '<main class="deck"><section class="slide" id="intro"><h1>Hi</h1></section></main>'
      await writeFile(join(deck, 'deck.html'), page)
      await writeFile(join(deck, 'onepager.html'), page)
      await writeFile(join(deck, 'plain.html'), '<p>no slides</p>')
      const real = await realpath(deck)
      expect(await (await request({ path: deck, action: 'slides' })).json()).toEqual({ ok: true, performed: 'slides', webPaneId: 'w-12345678' })
      expect(register).toHaveBeenLastCalledWith(real)
      expect(openResourceTile).toHaveBeenLastCalledWith('%12', '/redline/artifacts/0123456789abcdef/', { kind: 'canvas', artifactId: '0123456789abcdef', manifest: 'deck.html' })
      expect((await request({ path: join(deck, 'onepager.html'), action: 'slides' })).status).toBe(200)
      expect(openResourceTile).toHaveBeenLastCalledWith('%12', '/redline/artifacts/0123456789abcdef/', expect.objectContaining({ manifest: 'onepager.html' }))
      const calls = register.mock.calls.length
      // Not a deck: no slides, no deck.html beside it, or not HTML.
      expect((await request({ path: join(deck, 'plain.html'), action: 'slides' })).status).toBe(400)
      await writeFile(join(cwd, 'loose.html'), page)
      expect((await request({ path: join(cwd, 'loose.html'), action: 'slides' })).status).toBe(400)
      await writeFile(join(deck, 'notes.txt'), 'x')
      expect((await request({ path: join(deck, 'notes.txt'), action: 'slides' })).status).toBe(400)
      // A broad or daemon-state folder is never served, even holding a deck.
      await writeFile(join(home, 'deck.html'), page)
      expect((await request({ path: home, action: 'slides' })).status).toBe(403)
      await mkdir(join(home, '.commando', 'deck'), { recursive: true })
      await writeFile(join(home, '.commando', 'deck', 'deck.html'), page)
      expect((await request({ path: join(home, '.commando', 'deck'), action: 'slides' })).status).toBe(403)
      // Outside the allowed roots.
      await mkdir(join(dir, 'elsewhere'))
      await writeFile(join(dir, 'elsewhere', 'deck.html'), page)
      expect((await request({ path: join(dir, 'elsewhere'), action: 'slides' })).status).toBe(403)
      expect(register).toHaveBeenCalledTimes(calls)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects Markdown tiles without registering their folder', async () => {
    const { dir, home, request, register, openResourceTile } = await setup()
    try {
      for (const extension of ['md', 'markdown']) {
        const path = join(home, `README.${extension}`)
        await writeFile(path, '# Hello')
        expect((await request({ path, action: 'tile' })).status).toBe(400)
      }
      expect(register).not.toHaveBeenCalled()
      expect(openResourceTile).not.toHaveBeenCalled()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('accepts the configured temporary root and rejects malformed input or missing files', async () => {
    const { dir, home, request, execute } = await setup({ resourceTempRoots: [tmpdir()] })
    try {
      const path = join(dir, 'temporary.txt')
      await writeFile(path, '')
      expect((await request({ path, action: 'open' })).status).toBe(200)
      expect((await request({ path: join(home, 'missing'), action: 'open' })).status).toBe(404)
      for (const body of [{ path: 'relative', action: 'open' }, { path: '/tmp/a\u0000', action: 'open' }, { path: '/' + 'é'.repeat(2100), action: 'open' }, { path, action: 'delete' }, { path, action: 'editor', line: 0 }]) {
        expect((await request(body)).status).toBe(400)
      }
      expect(execute).toHaveBeenCalledTimes(1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('returns 501 on non-macOS without executing anything', async () => {
    const { dir, request, execute } = await setup({ platform: 'linux' })
    try {
      const response = await request({ path: dir, action: 'open' })
      expect(response.status).toBe(501)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('macOS') })
      expect(execute).not.toHaveBeenCalled()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

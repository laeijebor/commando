import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdeWindowAmbiguousError, SessionIdeService, type IdeLaunchOptions, type IdeRuntime } from './session-ides.js'

let directory: string
let service: SessionIdeService
const stop = vi.fn<() => Promise<void>>()
const launch = vi.fn<(options: IdeLaunchOptions) => Promise<IdeRuntime>>()

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ide-test-'))
  await mkdir(join(directory, 'other'))
  stop.mockReset().mockResolvedValue(undefined)
  launch.mockReset().mockResolvedValue({ socketPath: '/test/socket', stop })
  service = new SessionIdeService({ launch, dataDirectory: directory })
})
afterEach(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })

describe('session IDE ownership', () => {
  it('converges concurrent opens and pins one workspace per session', async () => {
    const [first, second] = await Promise.all([service.attach('$1', directory), service.attach('$1', directory)])
    expect(first.id).toBe(second.id)
    expect(launch).toHaveBeenCalledTimes(1)
    expect((await service.attach('$1', join(directory, 'other'))).workspacePath).toBe(first.workspacePath)
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0].sessionIds).toEqual(['$1'])
  })

  it('shares canonical worktrees across sessions and stops only after the last detach', async () => {
    const alias = join(directory, 'alias')
    await symlink(directory, alias)
    const [first, second] = await Promise.all([service.attach('$1', directory), service.attach('$2', alias)])
    expect(first.id).toBe(second.id)
    expect(launch).toHaveBeenCalledTimes(1)
    await service.detach('$1')
    expect(stop).not.toHaveBeenCalled()
    expect(service.forSession('$2')?.sessionIds).toEqual(['$2'])
    await service.detach('$2')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(service.list()).toEqual([])
  })

  it('shares a single setup/backend across different worktrees and prunes removed sessions', async () => {
    await service.attach('$1', directory)
    await service.attach('$2', join(directory, 'other'))
    expect(launch).toHaveBeenCalledTimes(1)
    await service.retain(new Set(['$2']))
    expect(service.forSession('$1')).toBeUndefined()
    expect(service.forSession('$2')?.state).toBe('ready')
    expect(stop).not.toHaveBeenCalled()
    await service.detach('$2')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('keeps workbench identities separate while reusing the persistent shared profile', async () => {
    const first = await service.attach('$1', directory)
    const second = await service.attach('$2', join(directory, 'other'))
    expect(first.id).not.toBe(second.id)
    const profileA = launch.mock.calls[0][0].dataDirectory
    expect(profileA).toBe(join(directory, 'base'))
    expect(launch.mock.calls[0][0].workspacePath).toBe(first.workspacePath)
    expect(service.get(second.id)?.url).toContain(encodeURIComponent(second.workspacePath))
    await service.detach('$1')
    await service.attach('$1', directory)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(service.forSession('$2')?.id).toBe(second.id)
    await service.close()
    service = new SessionIdeService({ launch, dataDirectory: directory })
    await service.attach('$3', join(directory, 'other'))
    expect(launch.mock.calls[1][0].dataDirectory).toBe(profileA)
  })

  it('reports failed startups and retries on the same attachment', async () => {
    launch.mockRejectedValueOnce(new Error('binary missing'))
    await expect(service.attach('$1', directory)).rejects.toThrow('binary missing')
    const failed = service.forSession('$1')!
    expect(failed).toMatchObject({ state: 'failed', error: 'binary missing' })
    const ready = await service.attach('$1', directory)
    expect(ready).toMatchObject({ id: failed.id, state: 'ready', generation: 2 })
  })

  it('cancels startup when the owning session is detached', async () => {
    launch.mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }))
    const opening = service.attach('$1', directory)
    const outcome = expect(opening).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
    await service.detach('$1')
    await outcome
    expect(service.list()).toEqual([])
  })

  it('binds cookie authorization to a single live IDE and never publishes secrets', async () => {
    const first = await service.attach('$1', directory)
    const second = await service.attach('$2', join(directory, 'other'))
    const cookie = service.cookie(first.id, true)
    expect(cookie).toContain(`Path=/ide/${first.id}/; HttpOnly; SameSite=Strict; Secure`)
    expect(service.authorized(first.id, cookie)).toBe(true)
    expect(service.authorized(second.id, cookie)).toBe(false)
    expect(service.authorized(first.id, 'commando-ide=invalid')).toBe(false)
    expect(service.authorized(first.id, `commando-ide=${'é'.repeat(64)}`)).toBe(false)
    expect(JSON.stringify(service.list())).not.toContain(cookie.split(';')[0].split('=')[1])
    await service.detach('$1')
    expect(service.authorized(first.id, cookie)).toBe(false)
  })

  it('marks unexpected exits as failed and closes all owned processes on shutdown', async () => {
    await service.attach('$1', directory)
    launch.mock.calls[0][0].onExit()
    expect(service.forSession('$1')).toMatchObject({ state: 'failed', error: expect.stringContaining('stopped unexpectedly') })
    await service.close()
    expect(stop).toHaveBeenCalledOnce()
    await expect(service.attach('$2', directory)).rejects.toThrow('shutting down')
  })

  it('ignores exit notifications from an old generation during a retry', async () => {
    await service.attach('$1', directory)
    const oldExit = launch.mock.calls[0][0].onExit
    oldExit()
    await service.attach('$1', directory)
    oldExit()
    expect(service.forSession('$1')?.state).toBe('ready')
  })

  it('marks all workbenches failed on backend exit and shares their retry', async () => {
    await service.attach('$1', directory)
    await service.attach('$2', join(directory, 'other'))
    launch.mock.calls[0][0].onExit()
    expect(service.list().every((ide) => ide.state === 'failed')).toBe(true)
    await Promise.all([service.attach('$1', directory), service.attach('$2', join(directory, 'other'))])
    expect(launch).toHaveBeenCalledTimes(2)
    expect(service.list().every((ide) => ide.state === 'ready')).toBe(true)
  })

  it('does not cancel a shared startup when just one worktree detaches', async () => {
    let ready!: (runtime: IdeRuntime) => void
    launch.mockImplementation(() => new Promise((resolve) => { ready = resolve }))
    const opening = service.attach('$1', directory)
    const rejected = expect(opening).rejects.toThrow('cancelled')
    const other = service.attach('$2', join(directory, 'other'))
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(service.list()).toHaveLength(2))
    const detached = service.detach('$1')
    expect(launch.mock.calls[0][0].signal.aborted).toBe(false)
    ready({ socketPath: '/test/shared', stop })
    await detached
    await rejected
    expect((await other).state).toBe('ready')
    expect(stop).not.toHaveBeenCalled()
  })

  it('waits for the old writer to stop before reopening the shared profile', async () => {
    let finish!: () => void
    stop.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await service.attach('$1', directory)
    const detached = service.detach('$1')
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    const reopened = service.attach('$2', join(directory, 'other'))
    await vi.waitFor(() => expect(service.list()).toHaveLength(1))
    expect(launch).toHaveBeenCalledTimes(1)
    finish()
    await detached
    expect((await reopened).state).toBe('ready')
    expect(launch).toHaveBeenCalledTimes(2)
  })
})

describe('opening files in a loaded IDE window', () => {
  const servers: Server[] = []
  const listen = async (path: string, handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(path, resolve))
  }
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))) })

  /** code-server's ranking: windows whose folder contains the path first, then the latest. */
  const registry = async (windows: { folder: string; socket: string }[]) => {
    const path = join(directory, 'r.sock')
    const queries: string[] = []
    await listen(path, (req, res) => {
      const filePath = new URL(req.url!, 'http://x').searchParams.get('filePath')!
      queries.push(filePath)
      const latest = [...windows].reverse()
      const match = latest.find((window) => filePath.startsWith(`${window.folder}/`)) ?? latest[0]
      res.end(JSON.stringify({ socketPath: match?.socket }))
    })
    return { path, queries }
  }
  const windowServer = async (name: string) => {
    const socket = join(directory, `${name}.sock`)
    const opened: unknown[] = []
    await listen(socket, (req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => { opened.push(JSON.parse(body)); res.end('null') })
    })
    return { socket, opened }
  }

  it('asks the registry for the window showing this workspace and opens the file there', async () => {
    const workspace = await realpath(directory)
    const windows: { folder: string; socket: string }[] = []
    const { path, queries } = await registry(windows)
    const window = await windowServer('w')
    launch.mockResolvedValue({ socketPath: '/test/socket', sessionSocketPath: path, stop })
    await writeFile(join(directory, 'a #1.ts'), '')
    await expect(service.openFile('$1', join(directory, 'a #1.ts'))).rejects.toThrow('Open this session’s IDE first')
    await service.attach('$1', directory)
    await expect(service.openFile('$1', 'a.ts')).rejects.toThrow('absolute')
    await expect(service.openFile('$1', join(directory, 'missing.ts'))).rejects.toThrow('no longer exists')
    await expect(service.openFile('$1', join(directory, 'other'))).rejects.toThrow('Only files')
    await expect(service.openFile('$1', join(directory, 'a #1.ts'), 300)).rejects.toThrow('not finished loading')
    setTimeout(() => { windows.push({ folder: workspace, socket: window.socket }) }, 300)
    await service.openFile('$1', join(directory, 'a #1.ts'))
    expect(queries).toContain(join(workspace, '.commando-open-file'))
    expect(window.opened).toEqual([{ type: 'open', fileURIs: [`file://${workspace}/a%20%231.ts`], folderURIs: [], forceReuseWindow: true }])
  })

  it('opens only in a window it can tell belongs to this worktree among several IDEs', async () => {
    await mkdir(join(directory, 'a'))
    await mkdir(join(directory, 'b'))
    await writeFile(join(directory, 'a', 'x.ts'), '')
    const [a, b] = [await realpath(join(directory, 'a')), await realpath(join(directory, 'b'))]
    const windows: { folder: string; socket: string }[] = []
    const { path } = await registry(windows)
    const [windowA, windowB] = [await windowServer('wa'), await windowServer('wb')]
    launch.mockResolvedValue({ socketPath: '/test/socket', sessionSocketPath: path, stop })
    await service.attach('$1', a)
    await service.attach('$2', b)
    // Only B's window has registered: the registry's fallback is B's window, never A's.
    windows.push({ folder: b, socket: windowB.socket })
    await expect(service.openFile('$1', join(a, 'x.ts'))).rejects.toBeInstanceOf(IdeWindowAmbiguousError)
    // A's window registered before B's: A's lookup is a real match, not the latest window.
    windows.unshift({ folder: a, socket: windowA.socket })
    await service.openFile('$1', join(a, 'x.ts'))
    // A's window is the latest, and B's lookup finds B's own window.
    windows.reverse()
    await service.openFile('$1', join(a, 'x.ts'))
    expect(windowA.opened).toHaveLength(2)
    expect(windowB.opened).toHaveLength(0)
    // B has no window: its lookup falls back to A's latest window too, so it cannot be told apart.
    windows.splice(windows.findIndex((window) => window.folder === b), 1)
    await expect(service.openFile('$1', join(a, 'x.ts'))).rejects.toBeInstanceOf(IdeWindowAmbiguousError)
  })

  it('asks for a reload when an IDE on an ancestor folder could take the file', async () => {
    launch.mockResolvedValue({ socketPath: '/test/socket', sessionSocketPath: join(directory, 'none.sock'), stop })
    await writeFile(join(directory, 'other', 'a.ts'), '')
    await service.attach('$1', join(directory, 'other'))
    await service.attach('$2', directory)
    await expect(service.openFile('$1', join(directory, 'other', 'a.ts'))).rejects.toBeInstanceOf(IdeWindowAmbiguousError)
    // The ancestor's own window is unambiguous: nested folders do not contain its probe.
    await expect(service.openFile('$2', join(directory, 'other', 'a.ts'), 0)).rejects.toThrow('not finished loading')
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrAutofixStore, PrAutofixWatcher } from './pr-autofix.js'
import { createPrsApi } from '../src/prsApi.js'
import { Readable } from 'node:stream'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handlePrsApi } from './prs-api.js'
import { PrService } from './prs.js'
import { PrConflictError } from './pr-conflicts.js'

const servers: Server[] = []

const TARGET_ID = '123e4567-e89b-42d3-a456-426614174000'

async function startApi(
  panePath: (paneId: string) => string | undefined,
  paneTargetId: (paneId: string) => string | undefined = () => undefined,
  suppliedService?: PrService,
): Promise<string> {
  const gitRunner = vi.fn(async (args: string[]) => {
    if (args.join(' ') === 'rev-parse --show-toplevel') return '/workspace\n'
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'feature\n'
    if (args[0] === 'for-each-ref') return 'origin\n'
    if (args.join(' ') === 'remote get-url origin') return 'git@github.com:acme/widgets.git\n'
    throw new Error(`Unexpected git command: ${args.join(' ')}`)
  })
  const service = suppliedService ?? new PrService({
    runner: vi.fn(async () => JSON.stringify({ data: { linked: { issueCount: 0, nodes: [] } } })),
    gitRunner,
    preferencesPath: '/nonexistent/prs.json',
  })
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!(await handlePrsApi(request, response, url, service, { panePath, paneTargetId }))) {
        response.writeHead(404)
        response.end()
      }
    })()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise((resolve) => server.close(resolve)),
  ))
})

describe('PR pane repository API', () => {
  it('accepts only bounded JSON patch rendering requests', async () => {
    const base = await startApi(() => undefined)
    const url = `${base}/api/prs/diff-render`
    expect((await fetch(url)).status).toBe(405)
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(415)
    const invalid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'file\n.ts', patch: '+ok', width: 120 }) })
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ code: 'invalid_request' })
  })

  it('routes native stack reads and writes, and stamps a daemon-known creating pane', async () => {
    const service = new PrService({ runner: vi.fn() })
    const stack = { number: 7, open: true, baseRefName: 'main', pullRequests: [] }
    const get = vi.spyOn(service.stacks, 'get').mockResolvedValue(stack)
    const link = vi.spyOn(service.stacks, 'link').mockResolvedValue(stack)
    const create = vi.spyOn(service.stacks, 'create').mockResolvedValue({ pullRequest: { number: 20, url: 'https://github.com/acme/widgets/pull/20' }, stack })
    const base = await startApi(() => '/workspace', (pane) => pane === '%1' ? TARGET_ID : undefined, service)
    expect((await fetch(`${base}/api/prs/stack?repo=acme%2Fwidgets&number=7`)).status).toBe(200)
    expect(get).toHaveBeenCalledWith('acme/widgets', '7')
    const write = (path: string, body: unknown) => fetch(`${base}/api/prs/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await write('stack', { repo: 'acme/widgets', numbers: [10, 20] })).status).toBe(200)
    expect(link).toHaveBeenCalledWith('acme/widgets', [10, 20])
    const body = { repo: 'acme/widgets', parentNumber: 10, head: 'api', title: 'API', body: '', draft: true, paneId: '%1' }
    expect((await write('stacked-pr', body)).status).toBe(201)
    expect(create).toHaveBeenCalledWith('acme/widgets', 10, body, TARGET_ID)
    expect((await write('stacked-pr', { ...body, paneId: '%999' })).status).toBe(404)
    expect(create).toHaveBeenCalledTimes(1)
    expect((await fetch(`${base}/api/prs/stacked-pr`)).status).toBe(405)
  })
  it('accepts POST JSON thread actions and rejects other methods/content types', async () => {
    const service = new PrService({ runner: vi.fn() })
    const action = vi.spyOn(service, 'actOnReviewThread').mockResolvedValue({ ok: true })
    const base = await startApi(() => undefined, () => undefined, service)
    const url = `${base}/api/prs/thread-action`
    expect((await fetch(url)).status).toBe(405)
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(415)
    expect(action).not.toHaveBeenCalled()
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'acme/widgets', number: 12, threadId: 'PRRT_123', action: 'reply', body: '**Fixed**' }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(action).toHaveBeenCalledExactlyOnceWith('acme/widgets', 12, 'PRRT_123', 'reply', '**Fixed**')
  })

  it('forwards explicit pane refresh and rejects malformed refresh values', async () => {
    const service = new PrService({ runner: vi.fn() })
    const paneList = vi.spyOn(service, 'listPanePullRequests').mockResolvedValue({} as Awaited<ReturnType<PrService['listPanePullRequests']>>)
    const base = await startApi(() => '/workspace', () => TARGET_ID, service)
    expect((await fetch(`${base}/api/prs/pane?paneId=%251&refresh=1`)).status).toBe(200)
    expect(paneList).toHaveBeenCalledWith(TARGET_ID, { refresh: true })
    expect((await fetch(`${base}/api/prs/pane?paneId=%251&refresh=invalid`)).status).toBe(400)
  })

  it('serves conflict inspection as a read-only endpoint with actionable race errors', async () => {
    const service = new PrService({ runner: vi.fn() })
    const inspect = vi.spyOn(service, 'pullRequestConflicts').mockResolvedValue({ state: 'clean' } as Awaited<ReturnType<PrService['pullRequestConflicts']>>)
    const base = await startApi(() => undefined, () => undefined, service)
    const url = `${base}/api/prs/conflicts?repo=acme%2Fwidgets&number=12`
    expect((await fetch(url, { method: 'POST' })).status).toBe(405)
    expect(inspect).not.toHaveBeenCalled()
    await expect((await fetch(url)).json()).resolves.toMatchObject({ conflicts: { state: 'clean' } })
    expect(inspect).toHaveBeenCalledWith('acme/widgets', '12')
    inspect.mockRejectedValueOnce(new PrConflictError('Refs changed; retry', 409))
    const changed = await fetch(url)
    expect(changed.status).toBe(409)
    await expect(changed.json()).resolves.toMatchObject({ error: 'Refs changed; retry', code: 'conflict_inspection_failed' })
  })

  it('defaults to mine and forwards explicit scopes', async () => {
    const service = new PrService({ runner: vi.fn() })
    const list = vi.spyOn(service, 'listPullRequests').mockResolvedValue({} as Awaited<ReturnType<PrService['listPullRequests']>>)
    const base = await startApi(() => undefined, () => undefined, service)
    expect((await fetch(`${base}/api/prs?repo=acme%2Fwidgets&state=open`)).status).toBe(200)
    expect(list).toHaveBeenLastCalledWith('acme/widgets', 'open', { refresh: false, scope: 'mine' })
    expect((await fetch(`${base}/api/prs?repo=acme%2Fwidgets&state=open&scope=everyone&refresh=1`)).status).toBe(200)
    expect(list).toHaveBeenLastCalledWith('acme/widgets', 'open', { refresh: true, scope: 'everyone' })
  })

  it('rejects unsupported scopes', async () => {
    const base = await startApi(() => undefined)
    const response = await fetch(`${base}/api/prs?repo=acme%2Fwidgets&scope=other`)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_request' })
  })

  it('accepts only POST JSON for merging and forwards the expected head', async () => {
    const service = new PrService({ runner: vi.fn() })
    const merge = vi.spyOn(service, 'mergePullRequest').mockResolvedValue({ merged: true })
    const base = await startApi(() => undefined, () => undefined, service)
    expect((await fetch(`${base}/api/prs/merge`)).status).toBe(405)
    expect((await fetch(`${base}/api/prs/merge`, { method: 'POST', body: '{}' })).status).toBe(415)
    const headRefOid = 'a'.repeat(40)
    const response = await fetch(`${base}/api/prs/merge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'acme/widgets', number: 12, headRefOid }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ merged: true })
    expect(merge).toHaveBeenCalledExactlyOnceWith('acme/widgets', 12, headRefOid)
  })

  it('resolves the tracking repository for a daemon-known pane', async () => {
    const base = await startApi((paneId) => paneId === '%1' ? '/workspace/packages/app' : undefined)
    const response = await fetch(`${base}/api/prs/repo?paneId=%251`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ repo: 'acme/widgets' })
  })

  it('rejects invalid and unknown pane ids', async () => {
    const base = await startApi(() => undefined)
    const invalid = await fetch(`${base}/api/prs/repo?paneId=not-a-pane`)
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ code: 'invalid_request' })

    const missing = await fetch(`${base}/api/prs/repo?paneId=%251`)
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ code: 'pane_not_found' })
  })

  it('rejects unsupported refresh values', async () => {
    const base = await startApi(() => undefined)
    const response = await fetch(`${base}/api/prs?repo=acme%2Fwidgets&state=open&refresh=true`)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_request' })
  })

  it('resolves pane-linked pull requests through the pane target', async () => {
    const base = await startApi(
      () => '/workspace',
      (paneId) => paneId === '%1' ? TARGET_ID : undefined,
    )
    const response = await fetch(`${base}/api/prs/pane?paneId=%251`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      list: { targetId: TARGET_ID, pullRequests: [] },
    })
  })

  it('rejects invalid and unknown pane ids for pane-linked pull requests', async () => {
    const base = await startApi(() => '/workspace')
    expect((await fetch(`${base}/api/prs/pane?paneId=bad`)).status).toBe(400)
    expect((await fetch(`${base}/api/prs/pane?paneId=%251`)).status).toBe(404)
  })
})


/** Exercise the same HTTP handler and frontend client without binding a socket. */
function autofixFetch(service: PrService, watcher: PrAutofixWatcher): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    const request = Readable.from(init?.body ? [String(init.body)] : []) as IncomingMessage
    request.method = init?.method ?? 'GET'
    request.headers = Object.fromEntries(new Headers(init?.headers).entries())
    let status = 200
    let body = ''
    const headers = new Headers()
    const response = {
      setHeader: (name: string, value: string) => { headers.set(name, value) },
      writeHead: (code: number, values: Record<string, string | number>) => { status = code; for (const [key, value] of Object.entries(values)) headers.set(key, String(value)) },
      end: (value: string) => { body = value },
    } as unknown as ServerResponse
    await handlePrsApi(request, response, url, service, {
      panePath: () => '/work', paneTargetId: (pane) => pane === '%1' ? TARGET_ID : undefined, autofix: watcher,
    })
    return new Response(body, { status, headers })
  }) as typeof fetch
}

describe('PR auto-fix API', () => {
  it('connects the client toggle to persisted state and prompt delivery, with disable and reset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-autofix-api-'))
    try {
      const service = new PrService({ runner: vi.fn() })
      vi.spyOn(service, 'listPanePullRequests').mockResolvedValue({ targetId: TARGET_ID, totalCount: 1, truncated: false, fetchedAt: 0,
        pullRequests: [{ repo: 'acme/widgets', number: 12, state: 'open' }] } as Awaited<ReturnType<PrService['listPanePullRequests']>>)
      const send = vi.fn(() => true)
      const watcher = new PrAutofixWatcher(new PrAutofixStore(directory), {
        target: (id) => id === TARGET_ID ? { paneId: '%1', busy: false, connected: true } : undefined,
        snapshot: async () => ({ state: 'open', url: 'https://github.com/acme/widgets/pull/12', headSha: 'abc', failingChecks: ['lint'], viewer: 'leo', comments: [] }), send,
      })
      const api = createPrsApi('', autofixFetch(service, watcher))
      expect(await api.autofixStatus('acme/widgets', 12)).toBeNull()
      expect(await api.setAutofix('acme/widgets', 12, true, '%1')).toMatchObject({ status: 'watching', enabled: true, targetId: TARGET_ID, rounds: 0 })
      await watcher.tick()
      expect(send).toHaveBeenCalledWith('%1', expect.stringContaining('acme/widgets#12'))
      expect(await api.autofixStatus('acme/widgets', 12)).toMatchObject({ status: 'fix-requested', rounds: 1, lastEventAt: expect.any(Number) })
      expect(await api.setAutofix('acme/widgets', 12, false, '%999')).toMatchObject({ enabled: false, status: 'stopped' })
      await watcher.tick()
      expect(send).toHaveBeenCalledOnce()
      expect(await api.setAutofix('acme/widgets', 12, true, '%1')).toMatchObject({ enabled: true, rounds: 0, lastEventAt: null })
      await watcher.tick()
      expect(send).toHaveBeenCalledTimes(2)
      const status = await api.autofixStatus('acme/widgets', 12)
      expect(status).not.toHaveProperty('handledFailures')
      expect(status).not.toHaveProperty('handledComments')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects malformed requests, missing panes/agents, unlinked and non-open PRs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-autofix-api-'))
    try {
      const service = new PrService({ runner: vi.fn() })
      const list = vi.spyOn(service, 'listPanePullRequests').mockResolvedValue({ pullRequests: [] } as unknown as Awaited<ReturnType<PrService['listPanePullRequests']>>)
      let agentExists = true
      const watcher = new PrAutofixWatcher(new PrAutofixStore(directory), {
        target: () => agentExists ? { paneId: '%1', busy: false, connected: true } : undefined,
        snapshot: vi.fn(), send: vi.fn(),
      })
      const fetch = autofixFetch(service, watcher)
      const path = '/api/prs/autofix'
      const body = { repo: 'acme/widgets', number: 12, paneId: '%1', enabled: true }
      const put = (value: unknown) => fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
      expect((await fetch(path, { method: 'POST' })).status).toBe(405)
      expect((await fetch(`${path}?repo=bad&number=12`)).status).toBe(400)
      expect((await put({ ...body, number: 0 })).status).toBe(400)
      expect((await put({ ...body, enabled: 'yes' })).status).toBe(400)
      expect((await put({ ...body, paneId: 'bad' })).status).toBe(400)
      expect((await put({ ...body, paneId: '%999' })).status).toBe(404)
      agentExists = false
      expect((await put(body)).status).toBe(409)
      agentExists = true
      expect((await put(body)).status).toBe(404)
      list.mockResolvedValue({ pullRequests: [{ repo: 'acme/widgets', number: 12, state: 'merged' }] } as unknown as Awaited<ReturnType<PrService['listPanePullRequests']>>)
      expect((await put(body)).status).toBe(409)
      expect(await watcher.store.list()).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

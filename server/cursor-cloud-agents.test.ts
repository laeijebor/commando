import { CursorCloudEnvironmentsApi } from './cursor-cloud-environments.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { ChatSessionInfo } from '../shared/agent-chat.js'
import type { TmuxPane } from '../shared/protocol.js'
import type { SessionCreation } from '../shared/tmux-create.js'
import { CursorCloudAgentsApi, type CursorCloudAgentsSdk } from './cursor-cloud-agents.js'
import type { GitProcessExecutor } from './git-diff.js'

const id = 'bc-12345678-abcd'
function setup() {
  let now = 0
  const chats: ChatSessionInfo[] = []
  const panes = [{ id: '%1', path: '/repo/sub', dead: false }] as TmuxPane[]
  const agent = { agentId: id, name: 'Fix cloud', summary: 'A summary', env: { type: 'cloud', name: 'App Dev' }, repos: ['https://github.com/acme/app'], lastModified: 123, createdAt: 100, metadata: { commando: '' } }
  const sdk = {
    list: vi.fn<CursorCloudAgentsSdk['list']>().mockResolvedValue({ items: [agent], nextCursor: 'next' }),
    get: vi.fn<CursorCloudAgentsSdk['get']>().mockResolvedValue(agent),
    listRuns: vi.fn<CursorCloudAgentsSdk['listRuns']>().mockResolvedValue({ items: [{ status: 'running', git: { branches: [{ branch: 'fix/cloud', prUrl: 'https://github.com/acme/app/pull/1' }] } }] }),
  }
  const start = vi.fn(async () => ({ result: { created: { paneId: '%9' } } }) as SessionCreation)
  const execute = vi.fn<GitProcessExecutor>().mockImplementation(async (_file, args) => ({ stdout:
    args[0] === 'rev-parse' ? '/repo\n' : args.length === 1 ? 'origin\nupstream\n'
      : args[2] === 'origin' ? 'https://github.com/other/repo.git\n' : 'git@github.com:Acme/App.git\n', stderr: '' }))
  const loadSdk = vi.fn(async () => sdk)
  const api = new CursorCloudAgentsApi({ sdk: loadSdk, now: () => now, chatSessions: () => chats, snapshot: () => ({ panes }), creations: { start }, execute })
  const call = async (path = '', method = 'GET') => {
    const result = { status: 0, body: {} as Record<string, unknown> }
    const response = { writeHead: (status: number) => { result.status = status }, end: (body: string) => { result.body = JSON.parse(body) } } as ServerResponse
    const handled = await api.handle({ method } as IncomingMessage, response, new URL(`http://x/api/cursor-cloud-agents${path}`))
    expect(handled).toBe(true)
    return result
  }
  return { api, sdk, agent, chats, panes, start, execute, loadSdk, call, time: (value: number) => { now = value } }
}

describe('Cursor cloud agent list', () => {
  it('drops archived agents before looking up runs, retaining false and missing archive flags', async () => {
    const f = setup()
    f.sdk.list.mockResolvedValue({ items: [
      { ...f.agent, agentId: 'bc-archived', archived: true, lastModified: 999 },
      { ...f.agent, agentId: 'bc-active', archived: false, lastModified: 200 },
      f.agent,
    ] })
    const result = await f.api.list()
    expect(result.agents.map((agent) => agent.agentId)).toEqual(['bc-active', id])
    expect(f.sdk.listRuns.mock.calls.map(([id]) => id)).toEqual(['bc-active', id])
  })
  it('is lazy and maps metadata, run status, git and live panes', async () => {
    const f = setup()
    expect(f.loadSdk).not.toHaveBeenCalled()
    f.chats.push({ sessionId: id, paneId: '%4' } as ChatSessionInfo)
    expect(await f.call()).toEqual({ status: 200, body: { login: 'ok', more: true, agents: [{
      agentId: id, name: 'Fix cloud', summary: 'A summary', environment: 'App Dev', repoUrl: 'https://github.com/acme/app', lastModified: 123, createdAt: 100,
      startedInCommando: true, openPaneId: '%4', status: 'running', branch: 'fix/cloud', prUrl: 'https://github.com/acme/app/pull/1', webUrl: `https://cursor.com/agents/${id}`,
    }] } })
    expect(f.sdk.list).toHaveBeenCalledWith({ runtime: 'cloud', limit: 50 })
    expect(f.sdk.listRuns).toHaveBeenCalledWith(id, { runtime: 'cloud', limit: 1 })
  })
  it('looks up only the 15 most recent runs, at most four concurrently', async () => {
    const f = setup()
    f.sdk.list.mockResolvedValue({ items: Array.from({ length: 20 }, (_, i) => ({ ...f.agent, agentId: `bc-${i}`, lastModified: i, metadata: undefined })) })
    let active = 0; let peak = 0
    f.sdk.listRuns.mockImplementation(async () => {
      active++; peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return { items: [] }
    })
    const result = await f.api.list()
    expect(f.sdk.listRuns).toHaveBeenCalledTimes(15)
    expect(f.sdk.listRuns.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 15 }, (_, i) => `bc-${19 - i}`))
    expect(peak).toBe(4)
    expect(result.agents.every((agent) => !agent.startedInCommando && !agent.status)).toBe(true)
  })
  it('caches for 20 seconds, deduplicates requests and limits refresh to once per 5 seconds', async () => {
    const f = setup()
    await Promise.all([f.api.list(), f.api.list()])
    f.time(4999); await f.api.list(true)
    expect(f.sdk.list).toHaveBeenCalledTimes(1)
    f.time(5000); await f.api.list(true)
    expect(f.sdk.list).toHaveBeenCalledTimes(2)
    f.time(24_999); await f.api.list()
    expect(f.sdk.list).toHaveBeenCalledTimes(2)
    f.time(25_000); await f.api.list()
    expect(f.sdk.list).toHaveBeenCalledTimes(3)
  })
  it.each(['list', 'listRuns'] as const)('returns login required on %s auth errors', async (method) => {
    const f = setup()
    f.sdk[method].mockRejectedValue({ code: 'UNAUTHENTICATED', message: 'secret-key' })
    expect(await f.api.list()).toEqual({ login: 'required', agents: [], more: false })
  })
  it('contains SDK/import failures without returning diagnostics or keys', async () => {
    const f = setup()
    f.loadSdk.mockRejectedValue(new Error('secret-key'))
    const result = await f.api.list()
    expect(result.error).toMatch(/Unable to load/)
    expect(JSON.stringify(result)).not.toContain('secret-key')
  })
  it('keeps agents with unknown statuses if a run lookup fails', async () => {
    const f = setup()
    f.sdk.listRuns.mockRejectedValue(new Error('secret-key'))
    const result = await f.api.list()
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].status).toBeUndefined()
    expect(result.error).toMatch(/statuses/)
  })
})

describe('open Cursor cloud agent', () => {
  it('focuses an already open chat without loading SDK or creating a session', async () => {
    const f = setup()
    f.chats.push({ sessionId: id, paneId: '%4' } as ChatSessionInfo)
    expect(await f.call(`/${id}/open`, 'POST')).toEqual({ status: 200, body: { paneId: '%4' } })
    expect(f.loadSdk).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
  })
  it('reuses a just-opened pane until the snapshot shows it, and reopens once that pane has closed', async () => {
    const f = setup()
    expect(await f.api.open(id)).toEqual({ paneId: '%9' })
    // %9 hasn't reached the snapshot yet: reuse it rather than starting a second chat.
    expect(await f.api.open(id)).toEqual({ paneId: '%9' })
    expect(f.start).toHaveBeenCalledTimes(1)
    f.panes.push({ id: '%9', path: '/repo', dead: false } as TmuxPane)
    expect(await f.api.open(id)).toEqual({ paneId: '%9' })
    // The user closes %9 within the 15-second window: the next open starts a new chat.
    f.panes.splice(f.panes.findIndex((pane) => pane.id === '%9'), 1)
    expect(await f.api.open(id)).toEqual({ paneId: '%9' })
    expect(f.start).toHaveBeenCalledTimes(2)
  })
  it('matches any normalized remote and uses the existing session creation path once', async () => {
    const f = setup()
    await f.api.list()
    const results = await Promise.all([f.api.open(id), f.api.open(id)])
    expect(results).toEqual([{ paneId: '%9' }, { paneId: '%9' }])
    expect(f.sdk.get).toHaveBeenCalledWith(id)
    expect(f.start).toHaveBeenCalledExactlyOnceWith({ name: 'Fix cloud', autoName: true, cwd: '/repo',
      agent: { provider: 'cursor-chat', resume: id, permissionMode: 'bypassPermissions', cursorCloud: { repoUrl: 'https://github.com/acme/app' } } })
    await f.api.open(id)
    expect(f.start).toHaveBeenCalledTimes(1)
    expect((await f.api.list(true)).agents[0].openPaneId).toBe('%9')
    expect(f.sdk.list).toHaveBeenCalledTimes(1)
  })
  it('does not use dead panes and reports missing checkout with 409', async () => {
    const f = setup()
    f.panes[0].dead = true
    expect(await f.call(`/${id}/open`, 'POST')).toEqual({ status: 409, body: { error: 'No local checkout of acme/app is open in Commando. Open a session in that repo, then try again.' } })
    expect(f.start).not.toHaveBeenCalled()
  })
  it('uses the exact linked checkout root when supplied', async () => {
    const f = setup()
    f.panes[0].repo = { root: '/main', worktreeRoot: '/linked', name: 'app', isWorktree: true, branch: 'fix' }
    await f.api.open(id)
    expect(f.execute.mock.calls[0][2].cwd).toBe('/linked')
  })
  it.each(['not-cloud', 'bc-short', `bc-${'x'.repeat(81)}`, 'bc-12345678%20'])('rejects invalid id %s before SDK access', async (badId) => {
    const f = setup()
    expect((await f.call(`/${badId}/open`, 'POST')).status).toBe(400)
    expect(f.loadSdk).not.toHaveBeenCalled()
  })
})

describe('Cursor cloud environments endpoint', () => {
  function environmentsFixture() {
    let now = 0
    const loadKey = vi.fn<() => Promise<string | undefined>>().mockResolvedValue('secret-api-key')
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ items: [] })))
    const api = new CursorCloudEnvironmentsApi({ fetch: fetcher, loadKey, now: () => now })
    const call = async (query = '', method = 'GET') => {
      const result = { status: 0, body: {} as Record<string, unknown> }
      const response = { writeHead: (status: number) => { result.status = status }, end: (body: string) => { result.body = JSON.parse(body) } } as ServerResponse
      expect(await api.handle({ method } as IncomingMessage, response, new URL(`http://x/api/cursor-cloud-environments${query}`))).toBe(true)
      return result
    }
    return { api, fetcher, loadKey, call, time: (value: number) => { now = value } }
  }
  it('lists only named environments, normalises repos and follows pagination with bearer auth', async () => {
    const f = environmentsFixture()
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ items: [
      { id: 'named', name: 'App Dev', repos: [{ url: 'git@github.com:Acme/App.git' }, { url: 'https://gitlab.com/no/repo' }] },
      { id: 'unnamed', repos: [] }, { id: 'empty', name: '', repos: [] },
    ], nextCursor: 'page +2' }))).mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'second', name: 'Shared', repos: [{ url: 'https://github.com/acme/other.git' }] }] })))
    expect(await f.call()).toEqual({ status: 200, body: { login: 'ok', environments: [
      { id: 'named', name: 'App Dev', repoUrls: ['https://github.com/Acme/App'] },
      { id: 'second', name: 'Shared', repoUrls: ['https://github.com/acme/other'] },
    ] } })
    expect(String(f.fetcher.mock.calls[0][0])).toBe('https://api.cursor.com/v1/environments')
    expect(new URL(String(f.fetcher.mock.calls[1][0])).searchParams.get('cursor')).toBe('page +2')
    expect(f.fetcher.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer secret-api-key' }, redirect: 'error' })
  })
  it('caches five minutes, coalesces requests, bypasses with refresh and rate limits it', async () => {
    const f = environmentsFixture()
    await Promise.all([f.api.list(), f.api.list()])
    f.time(4999); await f.call('?refresh=1')
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    f.time(5000); await f.call('?refresh=1')
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    f.time(304999); await f.api.list()
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    f.time(305000); await f.api.list()
    expect(f.fetcher).toHaveBeenCalledTimes(3)
  })
  it.each([401, 403])('returns login required for HTTP %s without leaking response diagnostics', async (status) => {
    const f = environmentsFixture()
    f.fetcher.mockResolvedValue(new Response('secret-api-key', { status }))
    expect(await f.call()).toEqual({ status: 200, body: { login: 'required', environments: [] } })
  })
  it.each(['fetch', 'loadKey', 'http', 'pagination'])('never returns or logs credentials on %s failures', async (failure) => {
    const f = environmentsFixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      if (failure === 'fetch') f.fetcher.mockRejectedValue(new Error('secret-api-key'))
      if (failure === 'loadKey') f.loadKey.mockRejectedValue(new Error('secret-api-key'))
      if (failure === 'http') f.fetcher.mockResolvedValue(new Response('secret-api-key', { status: 500 }))
      if (failure === 'pagination') f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ items: [], nextCursor: 'repeat' })))
      const result = await f.call()
      expect(result.body.error).toMatch(/Unable to load/)
      expect(JSON.stringify(result)).not.toContain('secret-api-key')
      expect(log).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally { log.mockRestore(); warn.mockRestore() }
  })
  it('requires login without a key and rejects non-GET methods without fetching', async () => {
    const f = environmentsFixture()
    f.loadKey.mockResolvedValue(undefined)
    expect(await f.api.list()).toEqual({ login: 'required', environments: [] })
    expect((await f.call('', 'POST')).status).toBe(405)
    expect(f.fetcher).not.toHaveBeenCalled()
  })
})

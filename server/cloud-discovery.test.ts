import { describe, expect, it, vi } from 'vitest'
import type { SDKAgentInfo } from '@cursor/sdk'
import type { CloudTaskSummary } from '../shared/cloud-tasks.js'
import type { CloudCliRequest, CloudCliResult } from './cloud-provider.js'
import {
  ClaudeAgentsDiscoveryAdapter,
  CloudDiscoveryService,
  CodexCloudDiscoveryAdapter,
  CursorCloudDiscoveryAdapter,
  type CloudDiscoveryAdapter,
  type CursorDiscoverySdk,
} from './cloud-discovery.js'

function cliResult(stdout = '', overrides: Partial<CloudCliResult> = {}): CloudCliResult {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    signal: null,
    spawned: true,
    timedOut: false,
    truncated: false,
    ...overrides,
  }
}

function trackedTask(overrides: Partial<CloudTaskSummary> = {}): CloudTaskSummary {
  return {
    id: 'local-1',
    provider: 'codex',
    credentialContextId: 'codex:default',
    verifiedAccountRef: null,
    title: 'Tracked task',
    source: {},
    providerTaskId: 'task_tracked_1',
    providerUrl: 'https://chatgpt.com/codex/tasks/task_tracked_1',
    identityEvidence: 'provider_receipt',
    deliveryState: 'accepted',
    remoteState: 'running',
    rawState: 'pending',
    observationState: 'fresh',
    lastObservedAt: '2026-11-24T12:00:00.000Z',
    providerUpdatedAt: '2026-11-24T12:00:00.000Z',
    createdAt: '2026-11-24T12:00:00.000Z',
    updatedAt: '2026-11-24T12:00:00.000Z',
    revision: 1,
    archivedAt: null,
    issue: null,
    ...overrides,
  }
}

describe('CursorCloudDiscoveryAdapter', () => {
  it('maps Cursor cloud agents, skips archived entries, and marks canOpenAsChat', async () => {
    const items: SDKAgentInfo[] = [
      {
        agentId: 'bc-11111111-aaaa',
        name: 'Refactor sidebar',
        summary: 'Fallback summary',
        lastModified: Date.parse('2026-11-24T10:00:00.000Z'),
        status: 'running',
        runtime: 'cloud',
        repos: ['https://github.com/acme/commando.git'],
        metadata: { branch: 'feat/sidebar', prUrl: 'https://github.com/acme/commando/pull/42' },
      },
      {
        agentId: 'bc-22222222-bbbb',
        name: '',
        summary: 'Summary title fallback',
        lastModified: Date.parse('2026-11-24T09:00:00.000Z'),
        status: 'finished',
        runtime: 'cloud',
        repos: ['acme/other'],
        metadata: { prUrl: 'javascript:alert(1)' },
      },
      {
        agentId: 'bc-33333333-cccc',
        name: 'Archived agent',
        summary: '',
        lastModified: Date.parse('2026-11-24T08:00:00.000Z'),
        status: 'error',
        archived: true,
        runtime: 'cloud',
      },
    ]
    const sdk: CursorDiscoverySdk = {
      authStatus: vi.fn(async () => ({ status: 'logged-in' as const, email: 'user@example.test' })),
      listCloudAgents: vi.fn(async () => ({ items })),
    }
    const adapter = new CursorCloudDiscoveryAdapter({ loadSdk: async () => sdk, hasApiKey: () => false })
    const result = await adapter.discover(new AbortController().signal)

    expect(sdk.authStatus).toHaveBeenCalledTimes(1)
    expect(sdk.listCloudAgents).toHaveBeenCalledWith({ limit: 30 })
    expect(result.source).toEqual({ provider: 'cursor', status: 'ok' })
    expect(result.agents).toEqual([
      {
        id: 'bc-11111111-aaaa',
        provider: 'cursor',
        title: 'Refactor sidebar',
        status: 'running',
        repo: 'acme/commando',
        branch: 'feat/sidebar',
        url: 'https://cursor.com/agents?selectedBcId=bc-11111111-aaaa',
        prUrl: 'https://github.com/acme/commando/pull/42',
        updatedAt: '2026-11-24T10:00:00.000Z',
        canOpenAsChat: true,
      },
      {
        id: 'bc-22222222-bbbb',
        provider: 'cursor',
        title: 'Summary title fallback',
        status: 'completed',
        repo: 'acme/other',
        url: 'https://cursor.com/agents?selectedBcId=bc-22222222-bbbb',
        updatedAt: '2026-11-24T09:00:00.000Z',
        canOpenAsChat: true,
      },
    ])
  })

  it('reports unauthenticated cleanly when logged out without calling Agent.list', async () => {
    const sdk: CursorDiscoverySdk = {
      authStatus: vi.fn(async () => ({ status: 'logged-out' as const })),
      listCloudAgents: vi.fn(async () => ({ items: [] })),
    }
    const adapter = new CursorCloudDiscoveryAdapter({ loadSdk: async () => sdk, hasApiKey: () => false })
    const result = await adapter.discover(new AbortController().signal)

    expect(result).toEqual({
      source: { provider: 'cursor', status: 'unauthenticated', message: 'Log in to Cursor to list cloud agents.' },
      agents: [],
    })
    expect(sdk.listCloudAgents).not.toHaveBeenCalled()
  })

  it('maps API key auth errors to unauthenticated and SDK load errors to unavailable', async () => {
    const authErr = Object.assign(new Error('Invalid API key: secret_123'), { name: 'AuthenticationError' })
    const sdk: CursorDiscoverySdk = {
      authStatus: vi.fn(async () => ({ status: 'logged-in' as const })),
      listCloudAgents: vi.fn(async () => { throw authErr }),
    }
    const adapter = new CursorCloudDiscoveryAdapter({ loadSdk: async () => sdk, hasApiKey: () => true })
    const authResult = await adapter.discover(new AbortController().signal)
    expect(authResult.source.status).toBe('unauthenticated')
    expect(authResult.source.message).not.toContain('secret_123')
    expect(sdk.authStatus).not.toHaveBeenCalled()

    const missingSdk = new CursorCloudDiscoveryAdapter({ loadSdk: async () => { throw new Error('MODULE_NOT_FOUND') } })
    const unavailableResult = await missingSdk.discover(new AbortController().signal)
    expect(unavailableResult.source).toEqual({
      provider: 'cursor',
      status: 'unavailable',
      message: 'Cursor SDK is unavailable.',
    })
  })

  it('ignores out-of-range numeric timestamps and stops before listCloudAgents if aborted during auth check', async () => {
    const controller = new AbortController()
    const sdk: CursorDiscoverySdk = {
      authStatus: vi.fn(async () => {
        controller.abort()
        return { status: 'logged-in' as const }
      }),
      listCloudAgents: vi.fn(async () => ({ items: [] })),
    }
    const adapter = new CursorCloudDiscoveryAdapter({ loadSdk: async () => sdk, hasApiKey: () => false })
    const abortedResult = await adapter.discover(controller.signal)
    expect(abortedResult.source.status).toBe('error')
    expect(sdk.listCloudAgents).not.toHaveBeenCalled()

    const badDateItems: SDKAgentInfo[] = [{
      agentId: 'bc-huge-date',
      name: 'Huge timestamp',
      summary: '',
      lastModified: 1e20,
      status: 'running',
      runtime: 'cloud',
    }]
    const badDateSdk: CursorDiscoverySdk = {
      authStatus: vi.fn(async () => ({ status: 'logged-in' as const })),
      listCloudAgents: vi.fn(async () => ({ items: badDateItems })),
    }
    const okResult = await new CursorCloudDiscoveryAdapter({ loadSdk: async () => badDateSdk, hasApiKey: () => true }).discover(new AbortController().signal)
    expect(okResult.source.status).toBe('ok')
    expect(okResult.agents).toEqual([{
      id: 'bc-huge-date',
      provider: 'cursor',
      title: 'Huge timestamp',
      status: 'running',
      url: 'https://cursor.com/agents?selectedBcId=bc-huge-date',
      canOpenAsChat: true,
    }])
  })
})

describe('CodexCloudDiscoveryAdapter', () => {
  it('parses { tasks: [...] }, { items: [...] }, and bare array JSON shapes', async () => {
    const payloadTasks = JSON.stringify({
      tasks: [{
        id: 'task_abc123',
        title: 'Fix login bug',
        status: 'ready',
        environment_label: 'acme/app',
        branch: 'fix/login',
        url: 'https://chatgpt.com/codex/tasks/task_abc123',
        pr_url: 'https://github.com/acme/app/pull/9',
        updated_at: '2026-11-24T11:30:00Z',
      }],
    })
    const runner = vi.fn(async (_req: CloudCliRequest) => cliResult(payloadTasks))
    const adapter = new CodexCloudDiscoveryAdapter({ runner, executable: '/usr/local/bin/codex' })
    const first = await adapter.discover(new AbortController().signal)

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      executable: '/usr/local/bin/codex',
      args: ['cloud', 'list', '--json'],
    }))
    expect(first.source).toEqual({ provider: 'codex', status: 'ok' })
    expect(first.agents).toEqual([{
      id: 'task_abc123',
      provider: 'codex',
      title: 'Fix login bug',
      status: 'completed',
      repo: 'acme/app',
      branch: 'fix/login',
      url: 'https://chatgpt.com/codex/tasks/task_abc123',
      prUrl: 'https://github.com/acme/app/pull/9',
      updatedAt: '2026-11-24T11:30:00.000Z',
      canOpenAsChat: false,
    }])

    runner.mockResolvedValueOnce(cliResult(JSON.stringify({
      items: [{ id: 'task_item_1', status: 'pending', url: 'javascript:alert(1)' }],
    })))
    const second = await adapter.discover(new AbortController().signal)
    expect(second.agents).toEqual([{
      id: 'task_item_1',
      provider: 'codex',
      title: 'task_item_1',
      status: 'running',
      url: 'https://chatgpt.com/codex/tasks/task_item_1',
      canOpenAsChat: false,
    }])

    runner.mockResolvedValueOnce(cliResult(JSON.stringify([
      { id: 'task_arr_1', title: 'Bare array item', status: 'error' },
    ])))
    const third = await adapter.discover(new AbortController().signal)
    expect(third.agents).toEqual([{
      id: 'task_arr_1',
      provider: 'codex',
      title: 'Bare array item',
      status: 'failed',
      url: 'https://chatgpt.com/codex/tasks/task_arr_1',
      canOpenAsChat: false,
    }])
  })

  it('handles missing CLI, auth failure, invalid JSON, and timeouts without throwing', async () => {
    const runner = vi.fn<(_req: CloudCliRequest) => Promise<CloudCliResult>>()
    const adapter = new CodexCloudDiscoveryAdapter({ runner })

    runner.mockResolvedValueOnce(cliResult('', { spawned: false }))
    expect((await adapter.discover(new AbortController().signal)).source.status).toBe('unavailable')

    runner.mockResolvedValueOnce(cliResult('', { exitCode: 1, stderr: 'Error: not logged in' }))
    expect((await adapter.discover(new AbortController().signal)).source.status).toBe('unauthenticated')

    runner.mockResolvedValueOnce(cliResult('not valid json'))
    expect((await adapter.discover(new AbortController().signal)).source.status).toBe('error')

    runner.mockResolvedValueOnce(cliResult('', { timedOut: true }))
    expect((await adapter.discover(new AbortController().signal)).source.status).toBe('error')
  })
})

describe('ClaudeAgentsDiscoveryAdapter', () => {
  it('parses claude agents --json output into discovered agents', async () => {
    const runner = vi.fn(async (_req: CloudCliRequest) => cliResult(JSON.stringify({
      agents: [{
        session_id: 'session_01ABCDEF',
        title: 'Audit auth middleware',
        status: 'running',
        repository: 'acme/api',
        branch: 'audit/auth',
        cwd: '/Users/dev/api',
        updated_at: '2026-11-24T12:15:00Z',
      }],
    })))
    const adapter = new ClaudeAgentsDiscoveryAdapter({ runner, executable: '/usr/local/bin/claude' })
    const result = await adapter.discover(new AbortController().signal)

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      executable: '/usr/local/bin/claude',
      args: ['agents', '--json'],
    }))
    expect(result.source).toEqual({ provider: 'claude', status: 'ok' })
    expect(result.agents).toEqual([{
      id: 'session_01ABCDEF',
      provider: 'claude',
      title: 'Audit auth middleware',
      status: 'running',
      repo: 'acme/api',
      branch: 'audit/auth',
      cwd: '/Users/dev/api',
      url: 'https://claude.ai/code/session_01ABCDEF',
      updatedAt: '2026-11-24T12:15:00.000Z',
      canOpenAsChat: false,
    }])
  })

  it('treats non-zero exit / unsupported flag cleanly as unavailable and auth errors as unauthenticated', async () => {
    const runner = vi.fn<(_req: CloudCliRequest) => Promise<CloudCliResult>>()
    const adapter = new ClaudeAgentsDiscoveryAdapter({ runner })

    runner.mockResolvedValueOnce(cliResult('', { exitCode: 2, stderr: "error: unknown option '--json'" }))
    expect((await adapter.discover(new AbortController().signal)).source.status).toBe('unavailable')

    runner.mockResolvedValueOnce(cliResult('', { exitCode: 1, stderr: 'Authentication required. Please sign in.' }))
    expect((await adapter.discover(new AbortController().signal)).source.status).toBe('unauthenticated')

    runner.mockResolvedValueOnce(cliResult('', { spawned: false }))
    expect((await adapter.discover(new AbortController().signal)).source.status).toBe('unavailable')
  })
})

describe('CloudDiscoveryService', () => {
  it('merges adapters concurrently, isolates failures/timeouts, dedupes, and marks alreadyTracked', async () => {
    const cursorAdapter: CloudDiscoveryAdapter = {
      provider: 'cursor',
      discover: async () => ({
        source: { provider: 'cursor', status: 'ok' },
        agents: [
          { id: 'bc-open-chat', provider: 'cursor', title: 'Open in Commando', status: 'running', updatedAt: '2026-11-24T12:05:00.000Z', canOpenAsChat: true },
          { id: 'bc-untracked', provider: 'cursor', title: 'Started on web', status: 'completed', updatedAt: '2026-11-24T12:10:00.000Z', canOpenAsChat: true },
          { id: 'bc-untracked', provider: 'cursor', title: 'Duplicate ignored', status: 'completed', updatedAt: '2026-11-24T12:00:00.000Z', canOpenAsChat: true },
        ],
      }),
    }
    const codexAdapter: CloudDiscoveryAdapter = {
      provider: 'codex',
      discover: async () => ({
        source: { provider: 'codex', status: 'ok' },
        agents: [
          { id: 'task_tracked_1', provider: 'codex', title: 'Already linked', status: 'running', updatedAt: '2026-11-24T12:08:00.000Z', canOpenAsChat: false },
          { id: 'task_new_2', provider: 'codex', title: 'Started in Codex web', status: 'completed', updatedAt: '2026-11-24T12:09:00.000Z', canOpenAsChat: false },
        ],
      }),
    }
    const explodingClaudeAdapter: CloudDiscoveryAdapter = {
      provider: 'claude',
      discover: async () => { throw new Error('unexpected crash') },
    }

    const service = new CloudDiscoveryService({
      adapters: [cursorAdapter, codexAdapter, explodingClaudeAdapter],
      listTrackedTasks: () => [trackedTask({ provider: 'codex', providerTaskId: 'task_tracked_1' })],
      listOpenChats: () => [{ provider: 'cursor-chat', sessionId: 'bc-open-chat' }],
      now: () => Date.parse('2026-11-24T15:00:00.000Z'),
    })

    const response = await service.discover()
    expect(response.discoveredAt).toBe('2026-11-24T15:00:00.000Z')
    expect(response.sources).toEqual([
      { provider: 'cursor', status: 'ok' },
      { provider: 'codex', status: 'ok' },
      { provider: 'claude', status: 'error', message: 'Discovery failed for claude.' },
    ])
    expect(response.agents.map((a) => ({ id: a.id, alreadyTracked: a.alreadyTracked }))).toEqual([
      { id: 'bc-untracked', alreadyTracked: false },
      { id: 'task_new_2', alreadyTracked: false },
      { id: 'task_tracked_1', alreadyTracked: true },
      { id: 'bc-open-chat', alreadyTracked: true },
    ])
  })

  it('bounds slow adapters with a timeout without blocking fast ones', async () => {
    const fast: CloudDiscoveryAdapter = {
      provider: 'codex',
      discover: async () => ({
        source: { provider: 'codex', status: 'ok' },
        agents: [{ id: 'task_fast', provider: 'codex', title: 'Fast task', status: 'running', canOpenAsChat: false }],
      }),
    }
    let aborted = false
    const slow: CloudDiscoveryAdapter = {
      provider: 'cursor',
      discover: (signal) => new Promise((_resolve) => {
        signal.addEventListener('abort', () => { aborted = true }, { once: true })
      }),
    }

    const service = new CloudDiscoveryService({ adapters: [fast, slow], timeoutMs: 25 })
    const response = await service.discover()
    expect(aborted).toBe(true)
    expect(response.agents).toHaveLength(1)
    expect(response.agents[0].id).toBe('task_fast')
    expect(response.sources).toEqual([
      { provider: 'codex', status: 'ok' },
      { provider: 'cursor', status: 'error', message: 'Discovery timed out for cursor.' },
    ])
  })
})

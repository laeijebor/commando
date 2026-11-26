import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudDiscoveryResponse, CloudImportDiscoveredResponse, CloudTaskAction, CloudTaskDetail } from '../shared/cloud-tasks.js'
import { CloudDiscoveryService, type CloudDiscoveryAdapter } from './cloud-discovery.js'
import type { CloudDispatchResult } from './cloud-provider.js'
import { CloudTaskService } from './cloud-task-service.js'
import { handleCloudTasksApi } from './cloud-tasks-api.js'
import { FakeCloudRepository, deferred, fakeProvider } from './cloud-test-fixtures/fakes.js'

const resources: { server: Server; service: CloudTaskService }[] = []
const confirmation = { credentialContextId: 'fixture-context', accountConfirmed: true }
const input = { provider: 'codex', prompt: 'Private synthetic prompt', source: { environmentId: 'env_fixture', branch: 'main' }, ...confirmation }
const jsonHeaders = { 'Content-Type': 'application/json', 'Idempotency-Key': 'intent_one' }
async function startApi(store = new FakeCloudRepository(), discovery?: CloudDiscoveryService) {
  const provider = fakeProvider()
  const service = new CloudTaskService({ store, providers: [provider.adapter] })
  const server = createServer((request, response) => {
    // Simulate a response lost after durable recording, without cancelling the service.
    if (request.headers['x-drop-response'] === '1') response.end = (() => { response.destroy(); return response }) as typeof response.end
    void handleCloudTasksApi(request, response, new URL(request.url ?? '/', 'http://localhost'), service, discovery).then((handled) => {
      if (!handled) { response.writeHead(418); response.end() }
    })
  })
  resources.push({ server, service })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, service, store, ...provider }
}
afterEach(async () => {
  for (const { server, service } of resources.splice(0)) {
    await service.stop()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

describe('cloud API routing (outer daemon authorization is an integrator responsibility)', () => {
  it('returns provider installation identity and does not consume unrelated routes', async () => {
    const { base, store } = await startApi()
    const providers = await fetch(`${base}/api/cloud-providers`)
    expect(providers.headers.get('cache-control')).toBe('no-store')
    expect(providers.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await providers.json()).toMatchObject({ installationId: store.installationId, providers: [{ id: 'codex' }] })
    expect((await fetch(`${base}/api/cloud-tasks-other`)).status).toBe(418)
    expect((await fetch(`${base}/api/cloud-providers/unknown`)).status).toBe(404)
    const wrongMethod = await fetch(`${base}/api/cloud-providers`, { method: 'POST' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('GET')
  })

  it('records a 202, exposes summaries/detail/operations, sends a message, refreshes and returns text diffs', async () => {
    const { base } = await startApi()
    const response = await fetch(`${base}/api/cloud-tasks`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) })
    expect(response.status).toBe(202)
    const action = await response.json() as CloudTaskAction
    expect(action.operation.state).toBe('prepared')
    expect(action.task.prompt).toBe(input.prompt)
    const summaries = await (await fetch(`${base}/api/cloud-tasks`)).json() as { tasks: unknown[] }
    expect(summaries.tasks).toHaveLength(1)
    expect(summaries.tasks[0]).not.toHaveProperty('prompt')
    expect(await (await fetch(`${base}/api/cloud-operations/${action.operation.id}`)).json()).toMatchObject({ operation: { id: action.operation.id } })
    expect(await (await fetch(`${base}/api/cloud-operations/by-key/intent_one`)).json()).toMatchObject({ operation: { id: action.operation.id } })
    expect(await (await fetch(`${base}/api/cloud-tasks/${action.task.id}`)).json()).toMatchObject({ task: { prompt: input.prompt }, operations: [{ id: action.operation.id }] })
    const message = await fetch(`${base}/api/cloud-tasks/${action.task.id}/messages`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'message_one' }, body: JSON.stringify({ message: 'Follow up', ...confirmation }) })
    expect(message.status).toBe(202)
    expect(await message.json()).toMatchObject({ operation: { kind: 'message' } })
    const refresh = await fetch(`${base}/api/cloud-tasks/${action.task.id}/refresh`, { method: 'POST' })
    expect(refresh.status).toBe(200)
    expect(await refresh.json()).toMatchObject({ task: { remoteState: 'running' }, operations: expect.any(Array) })
    const diff = await fetch(`${base}/api/cloud-tasks/${action.task.id}/diff`)
    expect(diff.status).toBe(200)
    expect(await diff.json()).toEqual({ text: '+synthetic change\n', truncated: false })
  })

  it('recovers a lost HTTP response before capability changes without cancelling or redispatching', async () => {
    const { base, adapter, info, receipt } = await startApi()
    const pending = deferred<CloudDispatchResult>()
    adapter.create.mockReturnValue(pending.promise)
    await expect(fetch(`${base}/api/cloud-tasks`, { method: 'POST', headers: { ...jsonHeaders, 'x-drop-response': '1' }, body: JSON.stringify(input) })).rejects.toThrow()
    const original = await (await fetch(`${base}/api/cloud-operations/by-key/intent_one`)).json() as { operation: { id: string } }
    info.capabilities.create = false
    const replay = await fetch(`${base}/api/cloud-tasks`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) })
    expect(replay.status).toBe(202)
    expect(await replay.json()).toMatchObject({ reused: true, operation: { id: original.operation.id } })
    expect(adapter.create).toHaveBeenCalledTimes(1)
    expect(adapter.create.mock.calls[0][1]?.aborted).toBe(false)
    pending.resolve(receipt())
  })

  it('supports local archive/unarchive patch payloads used by the UI and lists archived records after reload', async () => {
    const { base } = await startApi()
    const action = await (await fetch(`${base}/api/cloud-tasks/link`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ provider: 'codex', providerTaskId: 'task_linked', ...confirmation }) })).json() as CloudTaskAction
    const path = `${base}/api/cloud-tasks/${action.task.id}`
    const patch = async (value: unknown) => fetch(path, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(value) })
    const archived = await (await patch({ title: 'Local title', archivedAt: '2026-09-13T00:00:00.000Z' })).json() as CloudTaskDetail
    expect(archived.task).toMatchObject({ title: 'Local title', archivedAt: '2026-09-13T00:00:00.000Z' })
    expect(await (await fetch(`${base}/api/cloud-tasks?includeArchived=0`)).json()).toEqual({ tasks: [] })
    expect(await (await fetch(`${base}/api/cloud-tasks`)).json()).toMatchObject({ tasks: [{ id: action.task.id }] })
    expect(await (await patch({ archived: false })).json()).toMatchObject({ task: { archivedAt: null } })
    expect((await patch({ providerUrl: 'https://evil.test' })).status).toBe(400)
  })

  it('recovers only uncertain creation, with user_link evidence', async () => {
    const { base, adapter } = await startApi()
    adapter.create.mockRejectedValue(new Error('ambiguous CLI exit'))
    const action = await (await fetch(`${base}/api/cloud-tasks`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) })).json() as CloudTaskAction
    const linked = await fetch(`${base}/api/cloud-tasks/${action.task.id}/link`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'recover' }, body: JSON.stringify({ provider: 'codex', providerTaskId: 'task_recovered', ...confirmation }) })
    expect(linked.status).toBe(202)
    const detail = await (await fetch(`${base}/api/cloud-tasks/${action.task.id}`)).json() as CloudTaskDetail
    expect(detail.task.identityEvidence).toBe('user_link')
    expect(detail.operations[0].state).toBe('delivery_unknown')
    expect(detail.operations[1].receipt?.evidence).toBe('user_link')
  })

  it('explicitly dispatches an existing prepared operation after restart, with a bound confirmation body', async () => {
    const original = await startApi()
    const action = await original.service.createTask(input, 'prepared')
    await original.service.stop()
    const next = await startApi(original.store)
    const path = `${next.base}/api/cloud-operations/${action.operation.id}/dispatch`
    const post = (body: unknown) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await fetch(path)).status).toBe(405)
    expect((await post({ accountConfirmed: true })).status).toBe(400)
    expect((await post({ ...confirmation, credentialContextId: 'wrong' })).status).toBe(409)
    expect((await post({ ...confirmation, source: { branch: 'replacement' } })).status).toBe(400)
    expect(next.adapter.create).not.toHaveBeenCalled()
    const response = await post(confirmation)
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ reused: true, operation: { id: action.operation.id, state: 'prepared' } })
    const detail = await (await fetch(`${next.base}/api/cloud-tasks/${action.task.id}`)).json() as CloudTaskDetail
    expect(detail.operations).toHaveLength(1)
    expect(detail.operations[0].state).toBe('accepted')
    expect((await post(confirmation)).status).toBe(409)
    const reused = await fetch(`${next.base}/api/cloud-tasks`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'prepared' }, body: JSON.stringify(input) })
    expect(reused.status).toBe(202)
    expect(await reused.json()).toMatchObject({ reused: true, operation: { id: action.operation.id } })
    expect(next.adapter.create).toHaveBeenCalledTimes(1)
  })

  it('preserves by-key lookup when the intent key is dispatch', async () => {
    const { base, service } = await startApi()
    const action = await service.createTask(input, 'dispatch')
    const response = await fetch(`${base}/api/cloud-operations/by-key/dispatch`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ operation: { id: action.operation.id } })
  })

  it.each([
    ['/api/cloud-tasks', 'POST', {}, JSON.stringify(input), 400],
    ['/api/cloud-tasks', 'POST', { 'Idempotency-Key': 'intent' }, JSON.stringify(input), 415],
    ['/api/cloud-tasks', 'POST', jsonHeaders, '{', 400],
    ['/api/cloud-tasks', 'POST', jsonHeaders, '[]', 400],
    ['/api/cloud-tasks', 'POST', jsonHeaders, JSON.stringify({ ...input, credentialContextId: undefined }), 400],
    ['/api/cloud-tasks', 'POST', jsonHeaders, JSON.stringify({ ...input, credentialContextId: 'not-the-reviewed-context' }), 409],
    ['/api/cloud-tasks', 'POST', jsonHeaders, JSON.stringify({ ...input, prompt: 'x'.repeat(16385) }), 400],
    ['/api/cloud-tasks', 'POST', jsonHeaders, JSON.stringify({ ...input, prompt: 'x'.repeat(70_000) }), 413],
    ['/api/cloud-tasks', 'POST', jsonHeaders, JSON.stringify({ ...input, executable: '/bin/sh' }), 400],
    ['/api/cloud-tasks', 'POST', { ...jsonHeaders, 'Idempotency-Key': '--bad/key' }, JSON.stringify(input), 400],
    ['/api/cloud-tasks/link', 'POST', jsonHeaders, JSON.stringify({ provider: 'codex', providerTaskId: 'https://evil.test', ...confirmation }), 400],
    ['/api/cloud-tasks/%ZZ', 'GET', {}, undefined, 400],
    ['/api/cloud-tasks/a%2Fb', 'GET', {}, undefined, 400],
    ['/api/cloud-tasks?includeArchived=maybe', 'GET', {}, undefined, 400],
    ['/api/cloud-tasks?includeArchived=1&includeArchived=0', 'GET', {}, undefined, 400],
    ['/api/cloud-tasks?url=https://evil.test', 'GET', {}, undefined, 400],
    ['/api/cloud-tasks/missing/refresh', 'POST', jsonHeaders, JSON.stringify({ env: { TOKEN: 'no' } }), 400],
    ['/api/cloud-tasks/missing', 'GET', {}, undefined, 404],
    ['/api/cloud-operations/by-key/missing', 'GET', {}, undefined, 404],
  ] as const)('rejects invalid request %#', async (path, method, headers, body, status) => {
    const { base, adapter } = await startApi()
    const response = await fetch(`${base}${path}`, { method, headers, body })
    expect(response.status).toBe(status)
    expect(adapter.create).not.toHaveBeenCalled()
  })

  it('serves discovered external agents and imports Codex/Cursor agents cleanly', async () => {
    let listTasks: () => ReturnType<CloudTaskService['listTasks']> = () => []
    const adapters: CloudDiscoveryAdapter[] = [
      {
        provider: 'cursor',
        discover: async () => ({
          source: { provider: 'cursor', status: 'ok' },
          agents: [{
            id: 'bc-cursor-1',
            provider: 'cursor',
            title: 'Cursor cloud PR',
            status: 'running',
            repo: 'acme/repo',
            url: 'https://cursor.com/agents?selectedBcId=bc-cursor-1',
            updatedAt: '2026-11-24T12:00:00.000Z',
            canOpenAsChat: true,
          }],
        }),
      },
      {
        provider: 'codex',
        discover: async () => ({
          source: { provider: 'codex', status: 'ok' },
          agents: [{
            id: 'task_discovered_1',
            provider: 'codex',
            title: 'Codex cloud fix',
            status: 'completed',
            repo: 'acme/repo',
            branch: 'fix/one',
            url: 'https://chatgpt.com/codex/tasks/task_discovered_1',
            updatedAt: '2026-11-24T11:00:00.000Z',
            canOpenAsChat: false,
          }],
        }),
      },
    ]
    const discovery = new CloudDiscoveryService({
      adapters,
      listTrackedTasks: () => listTasks(),
      now: () => Date.parse('2026-11-24T12:30:00.000Z'),
    })
    const { base, service } = await startApi(new FakeCloudRepository(), discovery)
    listTasks = () => service.listTasks(true)

    const discoveredRes = await fetch(`${base}/api/cloud/discovered`)
    expect(discoveredRes.status).toBe(200)
    expect(discoveredRes.headers.get('cache-control')).toBe('no-store')
    const discovered = await discoveredRes.json() as CloudDiscoveryResponse
    expect(discovered.agents.map((a) => ({ id: a.id, alreadyTracked: a.alreadyTracked }))).toEqual([
      { id: 'bc-cursor-1', alreadyTracked: false },
      { id: 'task_discovered_1', alreadyTracked: false },
    ])

    // Import Cursor agent -> chat launch payload (relative cwd is omitted safely)
    const cursorImportRes = await fetch(`${base}/api/cloud/discovered/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'cursor',
        id: 'bc-cursor-1',
        title: 'Cursor cloud PR',
        cwd: 'relative/path',
        url: 'https://cursor.com/agents?selectedBcId=bc-cursor-1',
      }),
    })
    expect(cursorImportRes.status).toBe(200)
    expect(await cursorImportRes.json()).toEqual({
      kind: 'chat',
      launch: {
        provider: 'cursor-chat',
        resume: 'bc-cursor-1',
        title: 'Cursor cloud PR',
        url: 'https://cursor.com/agents?selectedBcId=bc-cursor-1',
      },
    } satisfies CloudImportDiscoveredResponse)

    // Import Codex agent -> links via CloudTaskService.linkTask
    const codexImportRes = await fetch(`${base}/api/cloud/discovered/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'import_codex_1' },
      body: JSON.stringify({
        provider: 'codex',
        id: 'task_discovered_1',
        title: 'Codex cloud fix',
        repo: 'acme/repo',
        branch: 'fix/one',
      }),
    })
    expect(codexImportRes.status).toBe(202)
    const imported = await codexImportRes.json() as CloudImportDiscoveredResponse
    expect(imported.kind).toBe('linked')
    if (imported.kind === 'linked') {
      expect(imported.operation.kind).toBe('link')
      expect(imported.task.title).toBe('Codex cloud fix')
      expect(imported.task.source).toEqual({ repository: 'acme/repo', branch: 'fix/one' })
    }

    // Wait for link dispatch to complete so providerTaskId is recorded, then re-discover
    await new Promise((resolve) => setTimeout(resolve, 20))
    const rediscovered = await (await fetch(`${base}/api/cloud/discovered`)).json() as CloudDiscoveryResponse
    expect(rediscovered.agents.find((a) => a.id === 'task_discovered_1')?.alreadyTracked).toBe(true)

    // Method & validation checks
    expect((await fetch(`${base}/api/cloud/discovered`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}/api/cloud/discovered/import`, { method: 'GET' })).status).toBe(405)
    expect((await fetch(`${base}/api/cloud/discovered/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'codex', id: 'not-a-valid-task-id' }),
    })).status).toBe(400)
    expect((await fetch(`${base}/api/cloud/discovered/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'cursor', id: 'bc-1', url: 'javascript:alert(1)' }),
    })).status).toBe(400)
  })

  it('returns 503 when discovery service is not configured', async () => {
    const { base } = await startApi()
    const response = await fetch(`${base}/api/cloud/discovered`)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'discovery_unavailable' })
  })
})

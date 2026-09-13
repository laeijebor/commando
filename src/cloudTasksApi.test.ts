import { describe, expect, it, vi } from 'vitest'
import { CloudTasksHttpError, createCloudTasksApi } from './cloudTasksApi'

describe('cloud task HTTP client', () => {
  it('accepts a 202 prepared-operation resume receipt with the confirmed context', async () => {
    const action = { task: { id: 'task' }, operation: { id: 'op', state: 'prepared' }, reused: true }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(action), { status: 202 }))
    expect(await createCloudTasksApi('owner', fetcher).resumeOperation('op', { credentialContextId: 'confirmed-context', accountConfirmed: true })).toEqual(action)
    expect(fetcher).toHaveBeenCalledWith('/api/cloud-operations/op/dispatch', expect.objectContaining({ method: 'POST', body: '{"credentialContextId":"confirmed-context","accountConfirmed":true}' }))
  })
  it('uses exact envelopes, routes, encoded IDs, owner auth, and idempotency headers', async () => {
    const bodies = [
      { installationId: 'install', providers: [] }, { tasks: [{ id: 'task' }] }, { task: {}, operations: [] },
      { task: {}, operation: {}, reused: false }, { task: {}, operation: {}, reused: true },
      { task: {}, operation: {}, reused: false }, { task: {}, operation: {}, reused: false },
      { task: {}, operations: [] }, { text: '+diff', truncated: false }, { task: {}, operations: [] },
      { operation: { id: 'operation' } }, { operation: { id: 'recovered' } },
      { task: {}, operation: { state: 'dispatching' }, reused: true },
    ]
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(bodies.shift()), { status: 200 }))
    const api = createCloudTasksApi('owner-secret', fetcher)
    expect(await api.providers()).toEqual({ installationId: 'install', providers: [] })
    expect(await api.list()).toEqual([{ id: 'task' }])
    expect(await api.get('local/id')).toEqual({ task: {}, operations: [] })
    const input = { provider: 'codex' as const, credentialContextId: 'ctx', prompt: 'private prompt', source: { environmentId: 'env', branch: 'main' }, accountConfirmed: true }
    await api.create(input, 'create-key')
    const link = { provider: 'codex' as const, credentialContextId: 'ctx', providerTaskId: 'task_known', accountConfirmed: true }
    await api.link(link, 'link-key')
    await api.link(link, 'recovery-key', 'local/id')
    await api.message('local/id', { credentialContextId: 'ctx', message: 'follow-up', accountConfirmed: true }, 'message-key')
    expect(await api.refresh('local/id')).toEqual({ task: {}, operations: [] })
    expect(await api.diff('local/id')).toEqual({ text: '+diff', truncated: false })
    expect(await api.patch('local/id', { archivedAt: null })).toEqual({ task: {}, operations: [] })
    expect(await api.operation('op/id')).toEqual({ id: 'operation' })
    expect(await api.byKey('key/id')).toEqual({ id: 'recovered' })
    expect(await api.resumeOperation('op/id', { credentialContextId: 'ctx', accountConfirmed: true })).toEqual({ task: {}, operation: { state: 'dispatching' }, reused: true })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/cloud-providers', '/api/cloud-tasks', '/api/cloud-tasks/local%2Fid', '/api/cloud-tasks',
      '/api/cloud-tasks/link', '/api/cloud-tasks/local%2Fid/link', '/api/cloud-tasks/local%2Fid/messages',
      '/api/cloud-tasks/local%2Fid/refresh', '/api/cloud-tasks/local%2Fid/diff', '/api/cloud-tasks/local%2Fid',
      '/api/cloud-operations/op%2Fid', '/api/cloud-operations/by-key/key%2Fid',
      '/api/cloud-operations/op%2Fid/dispatch',
    ])
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ credentials: 'same-origin', headers: { Authorization: 'Bearer owner-secret' } })
    expect(fetcher.mock.calls[1][1]?.body).toBeUndefined()
    expect(fetcher.mock.calls[3][1]).toMatchObject({ method: 'POST', headers: { 'Idempotency-Key': 'create-key' }, body: JSON.stringify(input) })
    expect(fetcher.mock.calls[4][1]).toMatchObject({ headers: { 'Idempotency-Key': 'link-key' } })
    expect(fetcher.mock.calls[5][1]).toMatchObject({ headers: { 'Idempotency-Key': 'recovery-key' } })
    expect(fetcher.mock.calls[6][1]).toMatchObject({ headers: { 'Idempotency-Key': 'message-key' } })
    expect(fetcher.mock.calls[9][1]).toMatchObject({ method: 'PATCH', body: '{"archivedAt":null}' })
    expect(fetcher.mock.calls[12][1]).toMatchObject({ method: 'POST', body: '{"credentialContextId":"ctx","accountConfirmed":true}' })
  })

  it('distinguishes missing recovery from failed recovery and never reflects raw diagnostics', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '<script>secret</script>', code: 'denied' }), { status: 401 }))
      .mockResolvedValueOnce(new Response('not JSON', { status: 202 }))
    const api = createCloudTasksApi('', fetcher)
    expect(await api.byKey('missing')).toBeNull()
    await expect(api.byKey('denied')).rejects.toMatchObject({ status: 401, code: 'denied' })
    await expect(api.create({ provider: 'claude', credentialContextId: 'ctx', prompt: 'x', source: {}, accountConfirmed: true }, 'key')).rejects.toThrow()
    expect(new CloudTasksHttpError(401, '', 'safe').message).toBe('safe')
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization')
  })
})

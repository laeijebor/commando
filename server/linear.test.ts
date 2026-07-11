import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinearAccountStore, LinearGraphqlClient, LinearService, LinearServiceError } from './linear.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Linear account storage', () => {
  it('keeps credentials private and never returns them from account listings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-linear-'))
    directories.push(directory)
    const path = join(directory, 'private', 'accounts.json')
    const store = new LinearAccountStore(path)
    const account = await store.add({
      label: 'Work',
      apiKey: 'lin_api_1234567890123456',
      workspaceName: 'Workspace',
      viewerName: 'Ada',
    })
    expect(account).not.toHaveProperty('apiKey')
    expect((await store.list())[0]).not.toHaveProperty('apiKey')
    expect(await store.credential(account.id)).toHaveProperty('apiKey', 'lin_api_1234567890123456')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).toContain('lin_api_1234567890123456')
  })
})

describe('Linear GraphQL client and service', () => {
  it('authenticates personal API keys without a Bearer prefix and connects an account', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commando-linear-'))
    directories.push(directory)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      data: { viewer: { id: 'viewer', name: 'Ada' }, organization: { id: 'org', name: 'Workspace' } },
    }))
    const service = new LinearService(new LinearAccountStore(join(directory, 'accounts.json')), fetcher)
    const account = await service.connectAccount('Work', 'lin_api_1234567890123456')
    expect(account).toMatchObject({ label: 'Work', viewerName: 'Ada', workspaceName: 'Workspace' })
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'lin_api_1234567890123456' })
  })

  it('maps authentication and GraphQL errors to sanitized service errors', async () => {
    const unauthorized = new LinearGraphqlClient('lin_api_1234567890123456', vi.fn<typeof fetch>().mockResolvedValue(response({}, 401)))
    await expect(unauthorized.request('{ viewer { id } }')).rejects.toMatchObject({
      status: 401,
      code: 'linear_unauthorized',
    })
    const failed = new LinearGraphqlClient(
      'lin_api_1234567890123456',
      vi.fn<typeof fetch>().mockImplementation(async () =>
        response({ errors: [{ message: 'secret upstream detail' }] }),
      ),
    )
    await expect(failed.request('{ viewer { id } }')).rejects.toBeInstanceOf(LinearServiceError)
    await expect(failed.request('{ viewer { id } }')).rejects.toThrow('Linear request failed')
  })
})

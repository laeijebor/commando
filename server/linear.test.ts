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

describe('Linear issue lookup for chat links', () => {
  async function service(fetcher: typeof fetch, now = () => 1_000) {
    const directory = await mkdtemp(join(tmpdir(), 'commando-linear-'))
    directories.push(directory)
    const store = new LinearAccountStore(join(directory, 'accounts.json'))
    await store.add({ label: 'Work', apiKey: 'lin_api_1234567890123456', workspaceName: 'Acme', viewerName: 'Ada' })
    return new LinearService(store, fetcher, now)
  }
  const issue = { identifier: 'ENG-42', title: 'Fix the login loop', url: 'https://linear.app/acme/issue/ENG-42/fix-the-login-loop', assignee: { name: 'Ada' }, state: { name: 'In Progress', color: '#f2c94c', type: 'started' } }
  const graphql = (handler: (query: string, variables: Record<string, unknown>) => unknown) => vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> }
    return response({ data: handler(body.query, body.variables) })
  })

  it('looks up the issue from the account whose workspace the link names, and caches it', async () => {
    let now = 1_000
    const fetcher = graphql((query, variables) => query.includes('urlKey') ? { organization: { urlKey: 'acme' } } : { issue: { ...issue, identifier: variables.issueId } })
    const linear = await service(fetcher, () => now)
    const url = 'https://linear.app/acme/issue/eng-42/fix-the-login-loop'
    expect(await linear.lookUpIssue(url)).toEqual({
      identifier: 'ENG-42', title: 'Fix the login loop', url: issue.url,
      state: { name: 'In Progress', color: '#f2c94c', type: 'started' }, assignee: 'Ada',
    })
    await linear.lookUpIssue(url)
    expect(fetcher).toHaveBeenCalledTimes(2)
    now += 3 * 60_000
    await linear.lookUpIssue(url)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('answers null for another workspace or a missing issue, and rejects other links', async () => {
    const fetcher = graphql((query) => query.includes('urlKey') ? { organization: { urlKey: 'acme' } } : { issue: null })
    const linear = await service(fetcher)
    expect(await linear.lookUpIssue('https://linear.app/other/issue/ENG-42')).toBeNull()
    expect(await linear.lookUpIssue('https://linear.app/acme/issue/ENG-404')).toBeNull()
    await expect(linear.lookUpIssue('ENG-42')).rejects.toMatchObject({ status: 400 })
    await expect(linear.lookUpIssue('https://linear.app.evil.com/acme/issue/ENG-42')).rejects.toMatchObject({ status: 400 })
  })

  it('does not cache a failed lookup', async () => {
    let fail = true
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query
      if (query.includes('urlKey')) return response({ data: { organization: { urlKey: 'acme' } } })
      return fail ? response({}, 500) : response({ data: { issue } })
    })
    const linear = await service(fetcher)
    await expect(linear.lookUpIssue(issue.url)).rejects.toMatchObject({ code: 'linear_error' })
    fail = false
    expect(await linear.lookUpIssue(issue.url)).toMatchObject({ identifier: 'ENG-42' })
  })
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrService, PrServiceError, PrPreferencesStore, validateRepo, validateStateFilter } from './prs.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryPrefsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-prs-'))
  directories.push(directory)
  return join(directory, 'nested', 'prs.json')
}

function pullRequestNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: 'feat: add thing',
    url: 'https://github.com/acme/widgets/pull/12',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'leo' },
    additions: 100,
    deletions: 25,
    changedFiles: 4,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    updatedAt: '2026-08-05T12:00:00Z',
    headRefName: 'leo/thing',
    reviewThreads: { totalCount: 0, nodes: [] },
    reviewRequests: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...overrides,
  }
}

function graphqlPayload(nodes: Array<Record<string, unknown>>, totalCount = nodes.length, viewer = 'leo'): string {
  return JSON.stringify({
    data: {
      viewer: { login: viewer },
      repository: { pullRequests: { totalCount, nodes } },
    },
  })
}

function serviceWith(output: string | Error, options?: ConstructorParameters<typeof PrService>[0]) {
  const runner = vi.fn(async (_args: string[]) => {
    if (output instanceof Error) throw output
    return output
  })
  const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json', ...options })
  return { service, runner }
}

describe('input validation', () => {
  it('accepts owner/name repos and rejects everything else', () => {
    expect(validateRepo('Save-All/Save-All')).toBe('Save-All/Save-All')
    expect(validateRepo('laeijebor/viviFIT')).toBe('laeijebor/viviFIT')
    for (const bad of [null, '', 'no-slash', 'a/b/c', 'owner/', '/name', 'owner/na me', 'owner/$(rm -rf)', '-lead/x']) {
      expect(() => validateRepo(bad)).toThrow(PrServiceError)
    }
  })

  it('defaults the state filter to open and rejects unknown values', () => {
    expect(validateStateFilter(undefined)).toBe('open')
    expect(validateStateFilter('')).toBe('open')
    expect(validateStateFilter('closed')).toBe('closed')
    expect(validateStateFilter('all')).toBe('all')
    expect(() => validateStateFilter('merged')).toThrow(PrServiceError)
  })
})

describe('pull request listing', () => {
  it('runs a single gh graphql call and normalizes the summary fields', async () => {
    const { service, runner } = serviceWith(graphqlPayload([pullRequestNode()]))
    const list = await service.listPullRequests('acme/widgets', 'open')
    expect(runner).toHaveBeenCalledTimes(1)
    const args = runner.mock.calls[0][0]
    expect(args.slice(0, 2)).toEqual(['api', 'graphql'])
    expect(args.join(' ')).toContain('owner=acme')
    expect(args.join(' ')).toContain('name=widgets')
    expect(args.join(' ')).toContain('states: [OPEN]')
    expect(list.viewer).toBe('leo')
    expect(list.pullRequests[0]).toMatchObject({
      number: 12,
      state: 'open',
      author: 'leo',
      additions: 100,
      deletions: 25,
      unresolvedThreads: 0,
      conflicting: false,
      checks: null,
      viewerIsAuthor: true,
      viewerReviewRequested: false,
    })
  })

  it('omits the states argument for the all filter and maps closed to CLOSED+MERGED', async () => {
    const { service, runner } = serviceWith(graphqlPayload([]))
    await service.listPullRequests('acme/widgets', 'all')
    expect(runner.mock.calls[0][0].join(' ')).not.toContain('states:')
    const closed = serviceWith(graphqlPayload([]))
    await closed.service.listPullRequests('acme/widgets', 'closed')
    expect(closed.runner.mock.calls[0][0].join(' ')).toContain('states: [CLOSED, MERGED]')
  })

  it('counts unresolved review threads and flags thread truncation', async () => {
    const { service } = serviceWith(graphqlPayload([
      pullRequestNode({
        reviewThreads: {
          totalCount: 60,
          nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }],
        },
      }),
    ]))
    const list = await service.listPullRequests('acme/widgets', 'open')
    expect(list.pullRequests[0].unresolvedThreads).toBe(2)
    expect(list.pullRequests[0].threadsTruncated).toBe(true)
  })

  it('normalizes the checks rollup, letting a passing rerun win over a failed attempt', async () => {
    const { service } = serviceWith(graphqlPayload([
      pullRequestNode({
        commits: { nodes: [{ commit: { statusCheckRollup: {
          state: 'FAILURE',
          contexts: { totalCount: 6, nodes: [
            { __typename: 'CheckRun', name: 'Validate PR title', status: 'COMPLETED', conclusion: 'FAILURE' },
            { __typename: 'CheckRun', name: 'Validate PR title', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'Lint', status: 'COMPLETED', conclusion: 'FAILURE' },
            { __typename: 'CheckRun', name: 'Build', status: 'IN_PROGRESS', conclusion: null },
            { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS' },
          ] },
        } } }] },
      }),
    ]))
    const checks = (await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].checks
    expect(checks).not.toBeNull()
    expect(checks?.state).toBe('fail')
    expect(checks?.total).toBe(4)
    expect(checks?.failed).toBe(1)
    expect(checks?.pending).toBe(1)
    expect(checks?.runs.find((run) => run.name === 'Validate PR title')?.state).toBe('pass')
    expect(checks?.truncated).toBe(true)
  })

  it('maps review decisions, conflicts, drafts, and review requests for the viewer', async () => {
    const { service } = serviceWith(graphqlPayload([
      pullRequestNode({
        number: 7,
        isDraft: true,
        author: { login: 'someone-else' },
        reviewDecision: 'CHANGES_REQUESTED',
        mergeable: 'CONFLICTING',
        reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'leo' } }] },
      }),
    ]))
    const pr = (await service.listPullRequests('acme/widgets', 'open')).pullRequests[0]
    expect(pr).toMatchObject({
      isDraft: true,
      reviewDecision: 'changes_requested',
      conflicting: true,
      viewerIsAuthor: false,
      viewerReviewRequested: true,
    })
  })

  it('reports truncation against the repo totalCount', async () => {
    const { service } = serviceWith(graphqlPayload([pullRequestNode()], 394))
    const list = await service.listPullRequests('acme/widgets', 'open')
    expect(list.totalCount).toBe(394)
    expect(list.truncated).toBe(true)
  })

  it('serves repeated calls from cache inside the TTL and refetches after it lapses', async () => {
    let clock = 0
    const runner = vi.fn(async () => graphqlPayload([pullRequestNode()]))
    const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json', listTtlMs: 1_000, now: () => clock })
    await service.listPullRequests('acme/widgets', 'open')
    await service.listPullRequests('acme/widgets', 'open')
    expect(runner).toHaveBeenCalledTimes(1)
    await service.listPullRequests('acme/widgets', 'closed')
    expect(runner).toHaveBeenCalledTimes(2)
    clock = 1_500
    await service.listPullRequests('acme/widgets', 'open')
    expect(runner).toHaveBeenCalledTimes(3)
  })

  it('does not cache failures', async () => {
    const runner = vi.fn(async () => {
      throw new PrServiceError(502, 'github_failed', 'boom')
    })
    const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json' })
    await expect(service.listPullRequests('acme/widgets', 'open')).rejects.toMatchObject({ code: 'github_failed' })
    await expect(service.listPullRequests('acme/widgets', 'open')).rejects.toMatchObject({ code: 'github_failed' })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('maps a missing repository to repo_not_found and bad JSON to an invalid-response error', async () => {
    const missing = serviceWith(JSON.stringify({ data: { viewer: { login: 'leo' }, repository: null } }))
    await expect(missing.service.listPullRequests('acme/widgets', 'open')).rejects.toMatchObject({
      status: 404,
      code: 'repo_not_found',
    })
    const garbled = serviceWith('not json at all')
    await expect(garbled.service.listPullRequests('acme/widgets', 'open')).rejects.toMatchObject({
      status: 502,
      code: 'github_invalid_response',
    })
  })
})

describe('repo options', () => {
  it('merges pinned repos with deduplicated suggestions from gh search', async () => {
    const path = await temporaryPrefsPath()
    const store = new PrPreferencesStore(path)
    await store.update({ pinnedRepos: ['laeijebor/viviFIT'] })
    const runner = vi.fn(async (args: string[]) => {
      expect(args[0]).toBe('search')
      return JSON.stringify([
        { repository: { nameWithOwner: 'Save-All/Save-All' } },
        { repository: { nameWithOwner: 'laeijebor/viviFIT' } },
        { repository: { nameWithOwner: 'Save-All/Save-All' } },
      ])
    })
    const service = new PrService({ runner, preferencesPath: path })
    expect(await service.listRepos()).toEqual([
      { nameWithOwner: 'laeijebor/viviFIT', pinned: true },
      { nameWithOwner: 'Save-All/Save-All', pinned: false },
    ])
  })

  it('falls back to pinned repos alone when suggestions fail', async () => {
    const path = await temporaryPrefsPath()
    await new PrPreferencesStore(path).update({ pinnedRepos: ['laeijebor/viviFIT'] })
    const runner = vi.fn(async () => {
      throw new PrServiceError(401, 'auth_required', 'not logged in')
    })
    const service = new PrService({ runner, preferencesPath: path })
    expect(await service.listRepos()).toEqual([{ nameWithOwner: 'laeijebor/viviFIT', pinned: true }])
  })
})

describe('preferences store', () => {
  it('returns defaults when no file exists and round-trips partial updates atomically', async () => {
    const path = await temporaryPrefsPath()
    const store = new PrPreferencesStore(path)
    expect(await store.read()).toEqual({
      version: 1,
      pinnedRepos: [],
      lastRepo: null,
      lastFilter: 'open',
      lastScope: 'mine',
    })
    await store.update({ lastRepo: 'Save-All/Save-All', lastScope: 'everyone' })
    const updated = await store.update({ pinnedRepos: ['laeijebor/viviFIT', 'laeijebor/viviFIT'] })
    expect(updated).toEqual({
      version: 1,
      pinnedRepos: ['laeijebor/viviFIT'],
      lastRepo: 'Save-All/Save-All',
      lastFilter: 'open',
      lastScope: 'everyone',
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(updated)
    expect(await new PrPreferencesStore(path).read()).toEqual(updated)
  })

  it('rejects invalid preference patches', async () => {
    const store = new PrPreferencesStore(await temporaryPrefsPath())
    await expect(store.update({ pinnedRepos: ['not a repo'] })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(store.update({ lastFilter: 'merged' })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(store.update({ lastScope: 'nobody' })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(store.update('nope')).rejects.toMatchObject({ code: 'invalid_request' })
  })
})

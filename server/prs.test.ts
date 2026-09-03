import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PrService,
  PrServiceError,
  PrPreferencesStore,
  repoFromGithubRemote,
  validateRepo,
  validatePaneTargetId,
  validateStateFilter,
} from './prs.js'

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
    body: 'Adds the thing behind a flag.',
    additions: 100,
    deletions: 25,
    changedFiles: 4,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    createdAt: '2026-08-01T09:00:00Z',
    updatedAt: '2026-08-05T12:00:00Z',
    headRefName: 'leo/thing',
    baseRefName: 'main',
    headRefOid: '2222222222222222222222222222222222222222',
    baseRefOid: '1111111111111111111111111111111111111111',
    reviewThreads: { totalCount: 0, nodes: [] },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { totalCount: 3, nodes: [{ commit: { statusCheckRollup: null } }] },
    ...overrides,
  }
}

type SearchPayload = { nodes?: Array<Record<string, unknown>>; issueCount?: number }

function graphqlPayload(
  nodes: Array<Record<string, unknown>>,
  totalCount = nodes.length,
  viewer = 'leo',
  searches: { authored?: SearchPayload; reviewRequested?: SearchPayload } = {},
): string {
  const connection = (search: SearchPayload = {}) => ({
    issueCount: search.issueCount ?? search.nodes?.length ?? 0,
    nodes: search.nodes ?? [],
  })
  return JSON.stringify({
    data: {
      viewer: { login: viewer },
      repository: { pullRequests: { totalCount, nodes } },
      authored: connection(searches.authored),
      reviewRequested: connection(searches.reviewRequested),
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

  it('accepts only durable Commando pane target ids', () => {
    expect(validatePaneTargetId('123e4567-e89b-42d3-a456-426614174000')).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(() => validatePaneTargetId('not-a-target')).toThrow(PrServiceError)
  })
})

describe('pane pull request history', () => {
  const targetId = '123e4567-e89b-42d3-a456-426614174000'
  const marker = `<!-- commando:v1 target=${targetId} relation=created -->`

  it('returns every exact marker match across repositories and states', async () => {
    const output = JSON.stringify({
      data: {
        linked: {
          issueCount: 4,
          nodes: [
            {
              number: 12,
              title: 'First pane PR',
              url: 'https://github.com/acme/widgets/pull/12',
              state: 'MERGED',
              isDraft: false,
              body: `Ships widgets.\n\n${marker}`,
              createdAt: '2026-08-19T09:00:00Z',
              updatedAt: '2026-08-20T09:00:00Z',
              repository: { nameWithOwner: 'acme/widgets' },
            },
            {
              number: 44,
              title: 'Second pane PR',
              url: 'https://github.com/acme/gadgets/pull/44',
              state: 'OPEN',
              isDraft: true,
              body: `Ships gadgets.\n\n${marker}`,
              createdAt: '2026-08-21T09:00:00Z',
              updatedAt: '2026-08-21T10:00:00Z',
              repository: { nameWithOwner: 'acme/gadgets' },
            },
            {
              number: 99,
              title: 'Search false positive',
              url: 'https://github.com/acme/widgets/pull/99',
              state: 'CLOSED',
              isDraft: false,
              body: `Mentions ${targetId} without the canonical marker.`,
              createdAt: '2026-08-21T11:00:00Z',
              updatedAt: '2026-08-21T11:00:00Z',
              repository: { nameWithOwner: 'acme/widgets' },
            },
          ],
        },
      },
    })
    const { service, runner } = serviceWith(output)

    await expect(service.listPanePullRequests(targetId)).resolves.toMatchObject({
      targetId,
      totalCount: 4,
      truncated: true,
      pullRequests: [
        { repo: 'acme/gadgets', number: 44, state: 'open', isDraft: true },
        { repo: 'acme/widgets', number: 12, state: 'merged', isDraft: false },
      ],
    })
    expect(runner).toHaveBeenCalledWith(expect.arrayContaining([
      '-f', `targetQuery=is:pr in:body ${targetId} sort:created-desc`,
    ]))
  })
})

describe('pane repository resolution', () => {
  it('parses common GitHub remote URL formats', () => {
    expect(repoFromGithubRemote('https://github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromGithubRemote('git@github.com:acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromGithubRemote('ssh://git@github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(repoFromGithubRemote('git://github.com/acme/widgets')).toBe('acme/widgets')
    expect(repoFromGithubRemote('https://gitlab.com/acme/widgets.git')).toBeNull()
    expect(repoFromGithubRemote('/local/acme/widgets')).toBeNull()
  })

  it('resolves the current branch tracking remote and caches it briefly', async () => {
    const gitRunner = vi.fn(async (args: string[], cwd: string) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') {
        expect(cwd).toBe('/workspace/packages/app')
        return '/workspace\n'
      }
      if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
        expect(cwd).toBe('/workspace')
        return 'feature/pane-aware\n'
      }
      if (args[0] === 'for-each-ref') {
        expect(args[2]).toBe('refs/heads/feature/pane-aware')
        return 'upstream\n'
      }
      if (args.join(' ') === 'remote get-url upstream') return 'git@github.com:acme/widgets.git\n'
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })
    const service = new PrService({
      runner: vi.fn(),
      gitRunner,
      preferencesPath: '/nonexistent/prs.json',
      repoContextTtlMs: 1_000,
      now: () => 0,
    })
    await expect(service.repoForPath('/workspace/packages/app')).resolves.toBe('acme/widgets')
    await expect(service.repoForPath('/workspace/packages/app')).resolves.toBe('acme/widgets')
    expect(gitRunner).toHaveBeenCalledTimes(4)
  })

  it('returns no repo for detached, untracked, and non-GitHub branches', async () => {
    const outputs = new Map<string, string>([
      ['rev-parse --show-toplevel', '/workspace\n'],
      ['rev-parse --abbrev-ref HEAD', 'feature\n'],
      ['for-each-ref --format=%(upstream:remotename) refs/heads/feature', 'origin\n'],
      ['remote get-url origin', 'git@gitlab.com:acme/widgets.git\n'],
    ])
    const gitRunner = vi.fn(async (args: string[]) => outputs.get(args.join(' ')) ?? '')
    const service = new PrService({ runner: vi.fn(), gitRunner, preferencesPath: '/nonexistent/prs.json' })
    await expect(service.repoForPath('/workspace')).resolves.toBeNull()

    outputs.set('for-each-ref --format=%(upstream:remotename) refs/heads/feature', '')
    const untracked = new PrService({ runner: vi.fn(), gitRunner, preferencesPath: '/nonexistent/prs.json' })
    await expect(untracked.repoForPath('/workspace')).resolves.toBeNull()

    outputs.set('rev-parse --abbrev-ref HEAD', 'HEAD\n')
    const detached = new PrService({ runner: vi.fn(), gitRunner, preferencesPath: '/nonexistent/prs.json' })
    await expect(detached.repoForPath('/workspace')).resolves.toBeNull()
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
      headRefOid: '2222222222222222222222222222222222222222',
      baseRefOid: '1111111111111111111111111111111111111111',
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

  it('uses deduplicated checks when successful reruns leave the complete GitHub rollup failed', async () => {
    const { service, runner } = serviceWith(graphqlPayload([
      pullRequestNode({
        commits: { nodes: [{ commit: { statusCheckRollup: {
          state: 'FAILURE',
          contexts: { totalCount: 4, nodes: [
            { __typename: 'CheckRun', name: 'Validate PR title', status: 'COMPLETED', conclusion: 'CANCELLED' },
            { __typename: 'CheckRun', name: 'Validate PR title', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'Linear ticket', status: 'COMPLETED', conclusion: 'CANCELLED' },
            { __typename: 'CheckRun', name: 'Linear ticket', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ] },
        } } }] },
      }),
    ]))

    const checks = (await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].checks
    expect(runner.mock.calls[0][0].join(' ')).toContain('contexts(first: 100)')
    expect(checks).toEqual({
      state: 'pass',
      runs: [
        { name: 'Validate PR title', state: 'pass' },
        { name: 'Linear ticket', state: 'pass' },
      ],
      failed: 0,
      pending: 0,
      total: 2,
      truncated: false,
    })
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

  it('merges authored and review-requested search results the repo page missed, deduped and sorted by PR number descending', async () => {
    const { service, runner } = serviceWith(graphqlPayload(
      [pullRequestNode({ number: 12, author: { login: 'someone-else' }, updatedAt: '2026-08-06T09:00:00Z' })],
      394,
      'leo',
      {
        authored: { nodes: [
          pullRequestNode({ number: 77, updatedAt: '2026-08-01T08:00:00Z' }),
          pullRequestNode({ number: 12, author: { login: 'someone-else' }, updatedAt: '2026-08-06T09:00:00Z' }),
        ] },
        reviewRequested: { nodes: [
          pullRequestNode({
            number: 41,
            author: { login: 'someone-else' },
            updatedAt: '2026-08-03T08:00:00Z',
            reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'leo' } }] },
          }),
        ] },
      },
    ))
    const list = await service.listPullRequests('acme/widgets', 'open')
    expect(runner).toHaveBeenCalledTimes(1)
    const args = runner.mock.calls[0][0].join(' ')
    expect(args).toContain('author:@me')
    expect(args).toContain('review-requested:@me')
    expect(args).toContain('repo:acme/widgets')
    expect(list.pullRequests.map((pr) => pr.number)).toEqual([77, 41, 12])
    expect(list.pullRequests[0].viewerIsAuthor).toBe(true)
    expect(list.pullRequests[1].viewerReviewRequested).toBe(true)
    expect(list.mineTruncated).toBe(false)
  })

  it('parses the popover detail fields: body excerpt, refs, ages, counts, reviews', async () => {
    const { service, runner } = serviceWith(graphqlPayload([
      pullRequestNode({
        body: `x${'y'.repeat(500)}`,
        baseRefName: 'release/2.0',
        createdAt: '2026-07-30T10:00:00Z',
        commits: { totalCount: 7, nodes: [{ commit: { statusCheckRollup: null } }] },
        latestReviews: { nodes: [
          { author: { login: 'timgent' }, state: 'APPROVED' },
          { author: { login: 'andrii' }, state: 'CHANGES_REQUESTED' },
          { author: { login: 'lurker' }, state: 'COMMENTED' },
        ] },
        reviewRequests: { nodes: [
          { requestedReviewer: { __typename: 'User', login: 'dana' } },
          { requestedReviewer: { __typename: 'Team', name: 'core' } },
        ] },
      }),
    ]))
    const pr = (await service.listPullRequests('acme/widgets', 'open')).pullRequests[0]
    expect(runner.mock.calls[0][0].join(' ')).toContain('latestReviews')
    expect(pr.bodyExcerpt.length).toBe(280)
    expect(pr.bodyExcerpt.startsWith('xy')).toBe(true)
    expect(pr.baseRefName).toBe('release/2.0')
    expect(pr.createdAt).toBe('2026-07-30T10:00:00Z')
    expect(pr.commitCount).toBe(7)
    expect(pr.reviews).toEqual([
      { login: 'timgent', state: 'approved' },
      { login: 'andrii', state: 'changes_requested' },
    ])
    expect(pr.requestedReviewers).toEqual(['dana'])
  })

  it('parses a canonical Commando marker and removes it from the visible excerpt', async () => {
    const targetId = '550e8400-e29b-41d4-a716-446655440000'
    const marker = `<!-- commando:v1 target=${targetId} relation=created -->`
    const { service } = serviceWith(graphqlPayload([
      pullRequestNode({ body: `Ships pane linking.\n\n${marker}` }),
    ]))

    const pr = (await service.listPullRequests('acme/widgets', 'open')).pullRequests[0]
    expect(pr.commandoMarker).toEqual({ version: 1, targetId, relation: 'created' })
    expect(pr.bodyExcerpt).toBe('Ships pane linking.')
  })

  it('fails closed when a PR body contains conflicting Commando markers', async () => {
    const body = [
      '<!-- commando:v1 target=550e8400-e29b-41d4-a716-446655440000 relation=created -->',
      '<!-- commando:v1 target=6ba7b810-9dad-41d1-80b4-00c04fd430c8 relation=created -->',
    ].join('\n')
    const { service } = serviceWith(graphqlPayload([pullRequestNode({ body })]))

    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].commandoMarker).toBeNull()
  })

  it('maps the state filter onto the search queries', async () => {
    const open = serviceWith(graphqlPayload([]))
    await open.service.listPullRequests('acme/widgets', 'open')
    expect(open.runner.mock.calls[0][0].join(' ')).toContain('author:@me is:open')
    const closed = serviceWith(graphqlPayload([]))
    await closed.service.listPullRequests('acme/widgets', 'closed')
    expect(closed.runner.mock.calls[0][0].join(' ')).toContain('review-requested:@me is:closed')
    const all = serviceWith(graphqlPayload([]))
    await all.service.listPullRequests('acme/widgets', 'all')
    const authoredArg = all.runner.mock.calls[0][0].find((arg) => arg.startsWith('authoredQuery='))
    expect(authoredArg).toBe('authoredQuery=repo:acme/widgets is:pr author:@me')
  })

  it('flags mineTruncated when a scoped search has more results than one page', async () => {
    const { service } = serviceWith(graphqlPayload([], 0, 'leo', {
      authored: { nodes: [pullRequestNode({ number: 77 })], issueCount: 45 },
    }))
    const list = await service.listPullRequests('acme/widgets', 'open')
    expect(list.mineTruncated).toBe(true)
    expect(list.pullRequests.map((pr) => pr.number)).toEqual([77])
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

  it('force refreshes inside the TTL and shares the awaited refresh', async () => {
    let finishRefresh: ((value: string) => void) | undefined
    const runner = vi.fn(async () => {
      if (runner.mock.calls.length === 1) {
        return graphqlPayload([pullRequestNode({ title: 'cached title' })])
      }
      return new Promise<string>((resolve) => { finishRefresh = resolve })
    })
    const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json', listTtlMs: 60_000 })
    await service.listPullRequests('acme/widgets', 'open')

    const first = service.listPullRequests('acme/widgets', 'open', { refresh: true })
    const second = service.listPullRequests('acme/widgets', 'open', { refresh: true })
    expect(runner).toHaveBeenCalledTimes(2)

    finishRefresh?.(graphqlPayload([pullRequestNode({ title: 'refreshed title' })]))
    expect((await first).pullRequests[0].title).toBe('refreshed title')
    expect((await second).pullRequests[0].title).toBe('refreshed title')
  })

  it('returns stale data while one background refresh updates the cache', async () => {
    let clock = 0
    let finishRefresh: ((value: string) => void) | undefined
    const runner = vi.fn(async () => {
      if (runner.mock.calls.length === 1) {
        return graphqlPayload([pullRequestNode({ title: 'cached title' })])
      }
      return new Promise<string>((resolve) => { finishRefresh = resolve })
    })
    const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json', listTtlMs: 1_000, now: () => clock })
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].title).toBe('cached title')

    clock = 1_500
    const stale = await service.listPullRequests('acme/widgets', 'open')
    const staleAgain = await service.listPullRequests('acme/widgets', 'open')
    expect(stale.pullRequests[0].title).toBe('cached title')
    expect(staleAgain.pullRequests[0].title).toBe('cached title')
    expect(runner).toHaveBeenCalledTimes(2)

    finishRefresh?.(graphqlPayload([pullRequestNode({ title: 'refreshed title' })]))
    await vi.waitFor(async () => {
      expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].title).toBe('refreshed title')
    })
  })

  it('retains stale data when a background refresh fails', async () => {
    let clock = 0
    const runner = vi.fn(async () => {
      if (runner.mock.calls.length === 1) return graphqlPayload([pullRequestNode({ title: 'cached title' })])
      throw new PrServiceError(502, 'github_failed', 'boom')
    })
    const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json', listTtlMs: 1_000, now: () => clock })
    await service.listPullRequests('acme/widgets', 'open')
    clock = 1_500
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].title).toBe('cached title')
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2))
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].title).toBe('cached title')
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

describe('unresolved thread excerpts', () => {
  function threadsPayload(threadNodes: Array<Record<string, unknown>>, totalCount = threadNodes.length): string {
    return JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { totalCount, nodes: threadNodes } } } },
    })
  }

  it('returns unresolved threads with author, path, and a capped excerpt', async () => {
    const { service, runner } = serviceWith(threadsPayload([
      { isResolved: false, path: 'src/SocialFeed.tsx', comments: { nodes: [{ author: { login: 'timgent' }, body: `should   this\ncache ${'x'.repeat(200)}` }] } },
      { isResolved: true, path: 'src/Other.tsx', comments: { nodes: [{ author: { login: 'andrii' }, body: 'resolved talk' }] } },
      { isResolved: false, path: null, comments: { nodes: [] } },
    ], 60))
    const result = await service.listUnresolvedThreads('acme/widgets', 12)
    const args = runner.mock.calls[0][0]
    expect(args.join(' ')).toContain('reviewThreads')
    expect(args).toContain('number=12')
    expect(result.threads).toHaveLength(2)
    expect(result.threads[0].author).toBe('timgent')
    expect(result.threads[0].path).toBe('src/SocialFeed.tsx')
    expect(result.threads[0].excerpt.startsWith('should this cache')).toBe(true)
    expect(result.threads[0].excerpt.length).toBeLessThanOrEqual(140)
    expect(result.truncated).toBe(true)
  })

  it('serves repeated thread lookups from cache inside the TTL', async () => {
    const runner = vi.fn(async () => JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } },
    }))
    const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json' })
    await service.listUnresolvedThreads('acme/widgets', 12)
    await service.listUnresolvedThreads('acme/widgets', 12)
    expect(runner).toHaveBeenCalledTimes(1)
    await service.listUnresolvedThreads('acme/widgets', 13)
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('maps a missing PR to pr_not_found and rejects bad numbers', async () => {
    const missing = serviceWith(JSON.stringify({ data: { repository: { pullRequest: null } } }))
    await expect(missing.service.listUnresolvedThreads('acme/widgets', 999)).rejects.toMatchObject({
      status: 404,
      code: 'pr_not_found',
    })
    const { service } = serviceWith('{}')
    await expect(service.listUnresolvedThreads('acme/widgets', 'nope')).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(service.listUnresolvedThreads('acme/widgets', -1)).rejects.toMatchObject({ code: 'invalid_request' })
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

  it('dedupes suggestions against pins case-insensitively', async () => {
    const path = await temporaryPrefsPath()
    await new PrPreferencesStore(path).update({ pinnedRepos: ['laeijebor/viviFIT'] })
    const runner = vi.fn(async () => JSON.stringify([{ repository: { nameWithOwner: 'laeijebor/vivifit' } }]))
    const service = new PrService({ runner, preferencesPath: path })
    expect(await service.listRepos()).toEqual([{ nameWithOwner: 'laeijebor/viviFIT', pinned: true }])
  })

  it('places recent repos after pins and before GitHub suggestions', async () => {
    const path = await temporaryPrefsPath()
    const store = new PrPreferencesStore(path)
    await store.update({ pinnedRepos: ['acme/pinned'] })
    await store.update({ lastRepo: 'acme/older' })
    await store.update({ lastRepo: 'acme/recent' })
    const runner = vi.fn(async () => JSON.stringify([
      { repository: { nameWithOwner: 'acme/suggested' } },
      { repository: { nameWithOwner: 'ACME/OLDER' } },
    ]))
    const service = new PrService({ runner, preferencesPath: path })
    expect(await service.listRepos()).toEqual([
      { nameWithOwner: 'acme/pinned', pinned: true },
      { nameWithOwner: 'acme/recent', pinned: false },
      { nameWithOwner: 'acme/older', pinned: false },
      { nameWithOwner: 'acme/suggested', pinned: false },
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
      recentRepos: [],
      lastRepo: null,
      lastFilter: 'open',
      lastScope: 'mine',
    })
    await store.update({ lastRepo: 'Save-All/Save-All', lastScope: 'everyone' })
    const updated = await store.update({ pinnedRepos: ['laeijebor/viviFIT', 'laeijebor/viviFIT'] })
    expect(updated).toEqual({
      version: 1,
      pinnedRepos: ['laeijebor/viviFIT'],
      recentRepos: ['Save-All/Save-All'],
      lastRepo: 'Save-All/Save-All',
      lastFilter: 'open',
      lastScope: 'everyone',
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(updated)
    expect(await new PrPreferencesStore(path).read()).toEqual(updated)
  })

  it('reads existing version 1 files without recentRepos', async () => {
    const path = await temporaryPrefsPath()
    const store = new PrPreferencesStore(path)
    await store.update({ lastRepo: 'acme/widgets' })
    const legacy = {
      version: 1,
      pinnedRepos: [],
      lastRepo: 'acme/widgets',
      lastFilter: 'open',
      lastScope: 'mine',
    }
    await writeFile(path, `${JSON.stringify(legacy)}\n`)
    expect(await new PrPreferencesStore(path).read()).toEqual({ ...legacy, recentRepos: [] })
  })

  it('maintains a case-insensitive bounded recent-repo list', async () => {
    const store = new PrPreferencesStore(await temporaryPrefsPath())
    for (let index = 0; index < 21; index += 1) {
      await store.update({ lastRepo: `acme/repo-${index}` })
    }
    await store.update({ lastRepo: 'ACME/REPO-10' })
    const preferences = await store.read()
    expect(preferences.recentRepos).toHaveLength(20)
    expect(preferences.recentRepos[0]).toBe('ACME/REPO-10')
    expect(preferences.recentRepos.filter((repo) => repo.toLowerCase() === 'acme/repo-10')).toHaveLength(1)
    expect(preferences.recentRepos).not.toContain('acme/repo-0')
  })

  it('rejects invalid preference patches', async () => {
    const store = new PrPreferencesStore(await temporaryPrefsPath())
    await expect(store.update({ pinnedRepos: ['not a repo'] })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(store.update({ lastFilter: 'merged' })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(store.update({ lastScope: 'nobody' })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(store.update('nope')).rejects.toMatchObject({ code: 'invalid_request' })
  })
})

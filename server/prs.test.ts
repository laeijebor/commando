import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  githubDisabledReason,
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
    mergeStateStatus: 'CLEAN',
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

describe('GitHub access per daemon', () => {
  it('keeps test daemons off the shared GitHub budget unless enabled', () => {
    expect(githubDisabledReason({}, 4310, 4310)).toBeUndefined()
    expect(githubDisabledReason({}, 4424, 4310)).toMatch(/COMMANDO_GITHUB=on/)
    expect(githubDisabledReason({ COMMANDO_GITHUB: 'on' }, 4424, 4310)).toBeUndefined()
    expect(githubDisabledReason({ COMMANDO_GITHUB: 'off' }, 4310, 4310)).toMatch(/disabled/)
  })

  it('fails reads without spawning gh when disabled', async () => {
    const runner = vi.fn(async () => '{}')
    const service = new PrService({ runner, githubDisabledReason: 'off for tests' })
    await expect(service.listPanePullRequests('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 503, code: 'github_disabled' })
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('throttle gate for gh calls outside PrService', () => {
  it('pauses polled reads when an outside call reports primary GraphQL throttling', async () => {
    const runner = vi.fn(async () => '{}')
    const service = new PrService({ runner, now: () => 1_000 })
    expect(service.githubGate.pausedUntil('graphql')).toBe(0)
    service.githubGate.rateLimited('graphql', 'gh: API rate limit exceeded for user ID 1')
    expect(service.githubGate.pausedUntil('graphql')).toBe(61_000)
    expect(service.githubGate.pausedUntil('rest')).toBe(0)
    await expect(service.listPanePullRequests('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'rate_limited' })
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('merging pull requests', () => {
  it('hydrates native stack membership in the existing list query', async () => {
    const { service, runner } = serviceWith(graphqlPayload([pullRequestNode({ stackEntry: { position: 2, stack: { number: 7, size: 3, baseRefName: 'main' } } })]))
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].stack).toEqual({ number: 7, position: 2, size: 3, baseRefName: 'main' })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0].join(' ')).toContain('stackEntry { position stack { number size baseRefName } }')
  })
  const head = '2222222222222222222222222222222222222222'
  const ready = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: head }

  it('rejects a retargeted PR before sending any merge write', async () => {
    const runner = vi.fn().mockResolvedValueOnce(JSON.stringify({ ...ready, baseRefName: 'release' }))
    await expect(new PrService({ runner }).mergePullRequest('acme/widgets', 12, head, 'main')).rejects.toMatchObject({ status: 409, code: 'target_changed' })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0]).not.toContain('PUT')
  })

  it.each([
    [{ allow_merge_commit: true }, 'merge'],
    [{ allow_merge_commit: false, allow_squash_merge: true }, 'squash'],
    [{ allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true }, 'rebase'],
  ])('merges with an enabled repository method and the expected SHA', async (settings, method) => {
    const runner = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(ready))
      .mockResolvedValueOnce(JSON.stringify(settings))
      .mockResolvedValueOnce(JSON.stringify({ merged: true }))
    const service = new PrService({ runner })
    await expect(service.mergePullRequest('acme/widgets', 12, head)).resolves.toEqual({ merged: true })
    expect(runner).toHaveBeenNthCalledWith(1, ['pr', 'view', '12', '--repo', 'acme/widgets', '--json', 'state,isDraft,mergeable,mergeStateStatus,headRefOid'])
    expect(runner).toHaveBeenLastCalledWith(['api', '--method', 'PUT', 'repos/acme/widgets/pulls/12/merge', '-f', `sha=${head}`, '-f', `merge_method=${method}`])
  })

  it.each([
    { state: 'MERGED' }, { state: 'CLOSED' }, { isDraft: true },
    { mergeable: 'CONFLICTING' }, { mergeable: 'UNKNOWN' },
    { mergeStateStatus: 'BLOCKED' }, { mergeStateStatus: 'BEHIND' }, { mergeStateStatus: 'UNKNOWN' },
  ])('refuses a fresh non-mergeable status %j without writing to GitHub', async (overrides) => {
    const runner = vi.fn().mockResolvedValue(JSON.stringify({ ...ready, ...overrides }))
    const service = new PrService({ runner })
    await expect(service.mergePullRequest('acme/widgets', 12, head)).rejects.toMatchObject({ status: 409, code: 'not_mergeable' })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('rejects changed heads and malformed input', async () => {
    const runner = vi.fn().mockResolvedValue(JSON.stringify({ ...ready, headRefOid: '1'.repeat(40) }))
    const service = new PrService({ runner })
    await expect(service.mergePullRequest('acme/widgets', 12, head)).rejects.toMatchObject({ code: 'head_changed' })
    await expect(service.mergePullRequest('acme/widgets', 12, '--admin')).rejects.toMatchObject({ status: 400 })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('prevents duplicate concurrent merges', async () => {
    let finish!: (value: string) => void
    const runner = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
      .mockResolvedValueOnce(JSON.stringify({ allow_merge_commit: true }))
      .mockResolvedValueOnce(JSON.stringify({ merged: true }))
    const service = new PrService({ runner })
    const pending = service.mergePullRequest('acme/widgets', 12, head)
    await expect(service.mergePullRequest('ACME/Widgets', 12, head)).rejects.toMatchObject({ code: 'merge_in_progress' })
    finish(JSON.stringify(ready))
    await expect(pending).resolves.toEqual({ merged: true })
    expect(runner).toHaveBeenCalledTimes(3)
  })

  it.each(['null', '[]', 'not json'])('rejects malformed GitHub output %s', async (output) => {
    const { service, runner } = serviceWith(output)
    await expect(service.mergePullRequest('acme/widgets', 12, head)).rejects.toMatchObject({ status: 502, code: 'github_invalid_response' })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('does not write when the repository has no enabled merge methods', async () => {
    const runner = vi.fn().mockResolvedValueOnce(JSON.stringify(ready)).mockResolvedValueOnce('{}')
    await expect(new PrService({ runner }).mergePullRequest('acme/widgets', 12, head)).rejects.toMatchObject({ code: 'not_mergeable' })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('surfaces GitHub merge refusal and permits retry', async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(ready)
      if (args.includes('PUT')) return JSON.stringify({ merged: false, message: 'Required checks failed' })
      return JSON.stringify({ allow_merge_commit: true })
    })
    const service = new PrService({ runner })
    await expect(service.mergePullRequest('acme/widgets', 12, head)).rejects.toThrow('Required checks failed')
    await expect(service.mergePullRequest('acme/widgets', 12, head)).rejects.toThrow('Required checks failed')
    expect(runner).toHaveBeenCalledTimes(6)
  })

  it('invalidates cached lists after merging', async () => {
    let merged = false
    const runner = vi.fn(async (args: string[]) => {
      if (args[1] === 'graphql') return graphqlPayload(merged ? [] : [pullRequestNode()])
      if (args[0] === 'pr') return JSON.stringify(ready)
      if (args.includes('PUT')) { merged = true; return JSON.stringify({ merged: true }) }
      return JSON.stringify({ allow_merge_commit: true })
    })
    const service = new PrService({ runner })
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests).toHaveLength(1)
    await service.mergePullRequest('acme/widgets', 12, head)
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests).toHaveLength(0)
  })
})

describe('comment status cache invalidation', () => {
  it.each([false, true])('invalidates list and thread caches even when the write response fails: %s', async (ambiguous) => {
    let resolved = false
    const runner = vi.fn(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('node(id: $id)')) return JSON.stringify({ data: { node: {
        id: 'PRRT_123', isResolved: false, viewerCanResolve: true,
        pullRequest: { number: 12, repository: { nameWithOwner: 'acme/widgets' } },
      } } })
      if (query.includes('mutation(')) {
        resolved = true
        if (ambiguous) throw new PrServiceError(504, 'github_timeout', 'GitHub request timed out')
        return JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_123', isResolved: true } } } })
      }
      if (query.includes('comments(first: 1)')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        totalCount: 1, nodes: resolved ? [] : [{ isResolved: false, path: 'a.ts', comments: { nodes: [{ body: 'Finding', author: { login: 'reviewer' } }] } }],
      } } } } })
      return graphqlPayload([pullRequestNode({ reviewThreads: { totalCount: 1, nodes: [{ isResolved: resolved, comments: { totalCount: 1 } }] } })])
    })
    const service = new PrService({ runner })
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].unresolvedThreads).toBe(1)
    expect((await service.listUnresolvedThreads('acme/widgets', 12)).threads).toHaveLength(1)
    const action = service.actOnReviewThread('acme/widgets', 12, 'PRRT_123', 'resolve')
    if (ambiguous) await expect(action).rejects.toThrow('timed out')
    else await action
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].unresolvedThreads).toBe(0)
    expect((await service.listUnresolvedThreads('acme/widgets', 12)).threads).toHaveLength(0)
  })
})

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

  it('allows explicit refresh to bypass the pane cache after a revision mismatch', async () => {
    const { service, runner } = serviceWith(JSON.stringify({ data: { linked: { issueCount: 0, nodes: [] } } }))
    await service.listPanePullRequests(targetId)
    await service.listPanePullRequests(targetId)
    expect(runner).toHaveBeenCalledTimes(1)
    await service.listPanePullRequests(targetId, { refresh: true })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('returns every exact marker match across repositories and states', async () => {
    const output = JSON.stringify({
      data: {
        linked: {
          issueCount: 4,
          nodes: [
            {
              ...pullRequestNode(),
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
              ...pullRequestNode(),
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

describe('recorded pane PRs', () => {
  const targetId = '123e4567-e89b-42d3-a456-426614174000'
  const marked = (number: number, body = `<!-- commando:v1 target=${targetId} relation=created -->`) =>
    pullRequestNode({ number, body, url: `https://github.com/acme/widgets/pull/${number}`, repository: { nameWithOwner: 'acme/widgets' } })
  const search = (...nodes: Array<Record<string, unknown>>) =>
    JSON.stringify({ data: { viewer: { login: 'leo' }, linked: { issueCount: nodes.length, nodes } } })
  const lookup = (...results: Array<Record<string, unknown> | null>) =>
    JSON.stringify({ data: { viewer: { login: 'leo' }, ...Object.fromEntries(results.map((node, index) => [`r${index}`, { pullRequest: node }])) } })
  const isLookup = (args: string[]) => args.some((arg) => arg.startsWith('query=query { viewer'))

  it('keeps showing a PR when the search later misses it, looking it up by number', async () => {
    let searchResult = search(marked(12))
    const runner = vi.fn(async (args: string[]) => isLookup(args) ? lookup(marked(12)) : searchResult)
    const service = new PrService({ runner, paneBatchWindowMs: 0, listTtlMs: 0 })
    expect((await service.listPanePullRequests(targetId)).pullRequests.map((pr) => pr.number)).toEqual([12])
    expect(runner).toHaveBeenCalledOnce()

    searchResult = search()
    const list = await service.listPanePullRequests(targetId)
    expect(list.pullRequests.map((pr) => pr.number)).toEqual([12])
    expect(list.totalCount).toBe(1)
    expect(runner).toHaveBeenCalledTimes(3)
    expect(runner.mock.calls[2][0].find((arg) => arg.startsWith('query='))).toContain(
      'r0: repository(owner: "acme", name: "widgets") { pullRequest(number: 12) {')
  })

  it('records search hits newest first, so the cap keeps the newest', async () => {
    let searchResult = search(marked(3), marked(2), marked(1))
    const runner = vi.fn(async (args: string[]) => isLookup(args) ? lookup(marked(3), marked(2), marked(1)) : searchResult)
    const service = new PrService({ runner, paneBatchWindowMs: 0, listTtlMs: 0 })
    await service.listPanePullRequests(targetId)
    searchResult = search()
    await service.listPanePullRequests(targetId)
    const query = runner.mock.calls.find(([args]) => isLookup(args))![0].find((arg) => arg.startsWith('query='))!
    expect([...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((match) => Number(match[1]))).toEqual([3, 2, 1])
  })

  it('shows a PR its agent reported before the search finds it', async () => {
    const runner = vi.fn(async (args: string[]) => isLookup(args) ? lookup(marked(30)) : search())
    const service = new PrService({ runner, paneBatchWindowMs: 0 })
    expect((await service.listPanePullRequests(targetId)).pullRequests).toEqual([])
    await service.recordPanePullRequests(targetId, [{ repo: 'acme/widgets', number: 30 }])
    // Recording drops the cached empty list instead of waiting out its TTL.
    expect((await service.listPanePullRequests(targetId)).pullRequests.map((pr) => pr.number)).toEqual([30])
  })

  it('drops a record whose PR lost the marker, was moved, or no longer exists, after a grace period', async () => {
    const other = '550e8400-e29b-41d4-a716-446655440000'
    let now = 1_000
    // gh exits non-zero on any GraphQL error but still prints the lookups that worked.
    const partial = Object.assign(new PrServiceError(502, 'github_failed', 'GitHub request failed: Could not resolve'), {
      output: JSON.stringify({ data: { viewer: { login: 'leo' }, r0: { pullRequest: marked(1, 'No marker any more') },
        r1: { pullRequest: marked(2, `<!-- commando:v1 target=${other} relation=created -->`) }, r2: { pullRequest: null }, r3: { pullRequest: marked(4) } },
      errors: [{ type: 'NOT_FOUND', path: ['r2', 'pullRequest'], message: 'Could not resolve' }] }),
    })
    const runner = vi.fn(async (args: string[]) => {
      if (isLookup(args)) throw partial
      return search()
    })
    const service = new PrService({ runner, paneBatchWindowMs: 0, listTtlMs: 0, now: () => now })
    await service.recordPanePullRequests(targetId, [1, 2, 3, 4].map((number) => ({ repo: 'acme/widgets', number })))
    expect((await service.listPanePullRequests(targetId)).pullRequests.map((pr) => pr.number)).toEqual([4])
    now += 10 * 60_000 + 1
    expect((await service.listPanePullRequests(targetId)).pullRequests.map((pr) => pr.number)).toEqual([4])
    expect(runner.mock.calls.filter(([args]) => isLookup(args))).toHaveLength(2)
    expect(runner.mock.calls.at(-1)![0].find((arg) => arg.startsWith('query='))).toContain('pullRequest(number: 4)')
    await service.listPanePullRequests(targetId)
    const last = runner.mock.calls.at(-1)![0].find((arg) => arg.startsWith('query='))!
    expect(last).toContain('pullRequest(number: 4)')
    expect(last).not.toMatch(/number: [123]\)/)
  })

  it('fails the read when the lookup cannot reach GitHub, and flags a list it could not fully check', async () => {
    let lookupResult: () => Promise<string> = async () => { throw new PrServiceError(502, 'github_failed', 'GitHub request failed') }
    const runner = vi.fn(async (args: string[]) => isLookup(args) ? lookupResult() : search(marked(9)))
    const service = new PrService({ runner, paneBatchWindowMs: 0, listTtlMs: 0 })
    await service.recordPanePullRequests(targetId, [{ repo: 'acme/widgets', number: 5 }])
    await expect(service.listPanePullRequests(targetId)).rejects.toMatchObject({ code: 'github_failed' })
    lookupResult = async () => JSON.stringify({ data: { viewer: { login: 'leo' }, r0: null },
      errors: [{ type: 'INTERNAL', path: ['r0'], message: 'Something went wrong' }] })
    const list = await service.listPanePullRequests(targetId)
    expect(list.pullRequests.map((pr) => pr.number)).toEqual([9])
    expect(list.truncated).toBe(true)
    // Not evidence the PR is gone, so its record stays.
    lookupResult = async () => lookup(marked(5))
    expect((await service.listPanePullRequests(targetId)).pullRequests.map((pr) => pr.number)).toEqual([9, 5])
  })

  it('on a truncated page, looks up only PRs recorded after the page begins', async () => {
    let now = Date.parse('2026-07-01T00:00:00Z')
    const page = JSON.stringify({ data: { viewer: { login: 'leo' }, linked: { issueCount: 25, nodes: [marked(30)] } } })
    const runner = vi.fn(async (args: string[]) => isLookup(args) ? lookup({ ...marked(40), createdAt: '2026-09-01T00:00:00Z' }) : page)
    const service = new PrService({ runner, paneBatchWindowMs: 0, listTtlMs: 0, now: () => now })
    await service.recordPanePullRequests(targetId, [{ repo: 'acme/widgets', number: 1 }])
    expect(await service.listPanePullRequests(targetId)).toMatchObject({ totalCount: 25, truncated: true })
    expect(runner.mock.calls.filter(([args]) => isLookup(args))).toHaveLength(0)

    now = Date.parse('2026-09-01T00:00:00Z')
    await service.recordPanePullRequests(targetId, [{ repo: 'acme/widgets', number: 40 }])
    const list = await service.listPanePullRequests(targetId)
    expect(list.pullRequests.map((pr) => pr.number)).toEqual([40, 30])
    expect(list.totalCount).toBe(26)
    const lookups = runner.mock.calls.filter(([args]) => isLookup(args))
    expect(lookups).toHaveLength(1)
    expect(lookups[0][0].find((arg) => arg.startsWith('query='))).not.toContain('pullRequest(number: 1)')
  })

  it('splits a large lookup into queries of 15', async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (!isLookup(args)) return search()
      const numbers = [...args.find((arg) => arg.startsWith('query='))!.matchAll(/pullRequest\(number: (\d+)\)/g)].map((match) => Number(match[1]))
      return lookup(...numbers.map((number) => marked(number)))
    })
    const service = new PrService({ runner, paneBatchWindowMs: 0 })
    await service.recordPanePullRequests(targetId, Array.from({ length: 20 }, (_, index) => ({ repo: 'acme/widgets', number: index + 1 })))
    expect((await service.listPanePullRequests(targetId)).pullRequests).toHaveLength(20)
    expect(runner.mock.calls.filter(([args]) => isLookup(args))).toHaveLength(2)
  })

  it('lets auto-fix check its PR directly when the search misses it', async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (isLookup(args)) return lookup(marked(12))
      if (args.some((arg) => arg.startsWith('targetQuery='))) return search()
      return '[[]]'
    })
    const service = new PrService({ runner, paneBatchWindowMs: 0 })
    expect(await service.autofixSnapshot('acme/widgets', 12, targetId)).toMatchObject({ state: 'open', headSha: '2222222222222222222222222222222222222222' })
  })

  it('tells auto-fix a PR is missing only once GitHub confirms it', async () => {
    const runner = vi.fn(async (args: string[]) => isLookup(args)
      ? JSON.stringify({ data: { viewer: { login: 'leo' }, r0: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', path: ['r0', 'pullRequest'], message: 'Could not resolve' }] })
      : search())
    const service = new PrService({ runner, paneBatchWindowMs: 0 })
    expect(await service.autofixSnapshot('acme/widgets', 12, targetId)).toMatchObject({ state: 'missing' })
  })

  it('follows a renamed repo without listing its PR twice', async () => {
    const renamed = { ...marked(12), url: 'https://github.com/acme/gizmos/pull/12', repository: { nameWithOwner: 'acme/gizmos' } }
    let searchResult = search()
    const runner = vi.fn(async (args: string[]) => isLookup(args) ? lookup(renamed) : searchResult)
    const service = new PrService({ runner, paneBatchWindowMs: 0, listTtlMs: 0 })
    await service.recordPanePullRequests(targetId, [{ repo: 'acme/widgets', number: 12 }])
    expect((await service.listPanePullRequests(targetId)).pullRequests.map((pr) => `${pr.repo}#${pr.number}`)).toEqual(['acme/gizmos#12'])
    searchResult = search(renamed)
    const list = await service.listPanePullRequests(targetId)
    expect(list.pullRequests.map((pr) => `${pr.repo}#${pr.number}`)).toEqual(['acme/gizmos#12'])
    expect(list.totalCount).toBe(1)
    expect(runner.mock.calls.filter(([args]) => isLookup(args))).toHaveLength(1)
  })

  it('looks recorded PRs up for every pane of a shared search in one query', async () => {
    const other = '550e8400-e29b-41d4-a716-446655440000'
    const runner = vi.fn(async (args: string[]) => isLookup(args)
      ? lookup(marked(1), marked(2, `<!-- commando:v1 target=${other} relation=created -->`))
      : search())
    const service = new PrService({ runner, now: () => 1 })
    await service.recordPanePullRequests(targetId, [{ repo: 'acme/widgets', number: 1 }])
    await service.recordPanePullRequests(other, [{ repo: 'acme/widgets', number: 2 }])
    const [mine, theirs] = await Promise.all([service.listPanePullRequests(targetId), service.listPanePullRequests(other)])
    expect(mine.pullRequests.map((pr) => pr.number)).toEqual([1])
    expect(theirs.pullRequests.map((pr) => pr.number)).toEqual([2])
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('keeps recorded PRs across daemon restarts', async () => {
    const path = await temporaryPrefsPath()
    const first = new PrService({ runner: vi.fn(async () => search(marked(12))), paneBatchWindowMs: 0, panePrRecordsPath: path })
    await first.listPanePullRequests(targetId)
    await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toContain('"number":12'))
    const runner = vi.fn(async (args: string[]) => isLookup(args) ? lookup(marked(12)) : search())
    const second = new PrService({ runner, paneBatchWindowMs: 0, panePrRecordsPath: path })
    expect((await second.listPanePullRequests(targetId)).pullRequests.map((pr) => pr.number)).toEqual([12])
  })
})

describe('pane PR status', () => {
  const targetId = '123e4567-e89b-42d3-a456-426614174000'
  function linkedPayload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ data: { viewer: { login: 'leo' }, linked: { issueCount: 1, nodes: [pullRequestNode({
      body: `<!-- commando:v1 target=${targetId} relation=created -->`, repository: { nameWithOwner: 'acme/widgets' }, ...overrides,
    })] } } })
  }

  it('reuses pane snapshots and caches opted-in comment reads behind the shared rate limit gate', async () => {
    let now = 1
    const runner = vi.fn(async (args: string[]) => {
      if (args.includes('graphql')) return linkedPayload({ commits: { nodes: [{ commit: { statusCheckRollup: {
        contexts: { nodes: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }], totalCount: 1 },
      } } }] } })
      if (args[1]?.includes('/reviews?')) return JSON.stringify([[{ id: 1, state: 'CHANGES_REQUESTED', body: 'Fix this', user: { login: 'reviewer' }, html_url: 'https://github.com/review/1' }, { id: 2, state: 'APPROVED', user: { login: 'reviewer' } }]])
      if (args[1]?.includes('/comments?')) return JSON.stringify([[{ id: 3, body: 'A comment', user: { login: 'leo' }, html_url: 'https://github.com/comment/3' }]])
      throw new Error('Unexpected command')
    })
    const service = new PrService({ runner, now: () => now })
    await service.listPanePullRequests(targetId)
    const first = await service.autofixSnapshot('acme/widgets', 12, targetId)
    expect(first).toMatchObject({ state: 'open', viewer: 'leo', headSha: '2222222222222222222222222222222222222222', failingChecks: ['lint'] })
    expect(first.comments.map((comment) => comment.id)).toEqual(['0:3', '1:1', '2:3'])
    expect(first.comments[1]).toMatchObject({ author: 'reviewer', body: 'Fix this', url: 'https://github.com/review/1' })
    expect(runner).toHaveBeenCalledTimes(4)
    expect(await service.autofixSnapshot('acme/widgets', 12, targetId)).toEqual(first)
    expect(runner).toHaveBeenCalledTimes(4)
    now = 60_002
    await service.autofixSnapshot('acme/widgets', 12, targetId)
    expect(runner).toHaveBeenCalledTimes(8)
  })

  it('shares full comment pages between conversation and auto-fix without shortening UI bodies', async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (args.includes('graphql')) {
        if (args.some((arg) => arg.startsWith('targetQuery='))) return linkedPayload()
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
          nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
        } } } } })
      }
      if (args[1].endsWith('/pulls/12')) return JSON.stringify({ head: { sha: '2'.repeat(40) }, base: { ref: pullRequestNode().baseRefName, sha: pullRequestNode().baseRefOid }, body: 'Description' })
      if (args[1].includes('/check-runs')) return JSON.stringify([{ check_runs: [] }])
      if (args[1].includes('/statuses')) return JSON.stringify([[]])
      return JSON.stringify([[{ id: 1, state: 'CHANGES_REQUESTED', body: 'x'.repeat(900), user: { login: 'reviewer' } }]])
    })
    const service = new PrService({ runner })
    const details = await service.pullRequestDetails('acme/widgets', 12)
    const autofix = await service.autofixSnapshot('ACME/Widgets', 12, targetId)
    expect(runner).toHaveBeenCalledTimes(8)
    expect(details.conversation.every((entry) => entry.body.length === 900)).toBe(true)
    expect(autofix.comments.every((comment) => comment.body.length === 500)).toBe(true)
  })

  it('drops hidden bot state from auto-fix comments before shortening them', async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (args.includes('graphql')) return linkedPayload()
      if (args[1].endsWith('/pulls/12')) return JSON.stringify({ head: { sha: '2'.repeat(40) } })
      if (args[1].includes('/check-runs')) return JSON.stringify([{ check_runs: [] }])
      if (args[1].includes('/statuses')) return JSON.stringify([[]])
      return JSON.stringify([[
        { id: 1, state: 'CHANGES_REQUESTED', body: `<!-- state ${'s'.repeat(900)} -->\n\nVisible feedback`, user: { login: 'coderabbitai[bot]' } },
        { id: 2, state: 'COMMENTED', body: '<!-- only hidden state -->', user: { login: 'coderabbitai[bot]' } },
        { id: 3, state: 'COMMENTED', body: 'Escape the `<!--` in header.html', user: { login: 'reviewer' } },
      ]])
    })
    const service = new PrService({ runner })
    const autofix = await service.autofixSnapshot('acme/widgets', 12, targetId)
    const bodies = (kind: number) => autofix.comments.filter((comment) => comment.id.startsWith(`${kind}:`)).map((comment) => comment.body)
    // Issue comments: hidden state stripped before the cut, a hidden-only comment skipped, an unclosed marker kept.
    expect(bodies(0)).toEqual(['Visible feedback', 'Escape the `<!--` in header.html'])
    expect(bodies(1)).toEqual(['Visible feedback'])
  })

  it('invalidates long-lived metadata when pane discovery reports a new head', async () => {
    let currentHead = '2'.repeat(40)
    const runner = vi.fn(async (args: string[]) => {
      if (args.includes('graphql')) {
        if (args.some((arg) => arg.startsWith('targetQuery='))) return linkedPayload({ headRefOid: currentHead })
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
          nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
        } } } } })
      }
      if (args[1].endsWith('/pulls/12')) return JSON.stringify({ head: { sha: currentHead } })
      if (args[1].includes('/check-runs')) return JSON.stringify([{ check_runs: [] }])
      return JSON.stringify([[]])
    })
    const service = new PrService({ runner })
    expect((await service.pullRequestDetails('acme/widgets', 12)).headOid).toBe(currentHead)
    currentHead = '4'.repeat(40)
    await service.listPanePullRequests(targetId)
    expect((await service.pullRequestDetails('acme/widgets', 12)).headOid).toBe(currentHead)
    expect(runner.mock.calls.filter(([args]) => args[1].endsWith('/pulls/12'))).toHaveLength(2)
  })

  it.each(['MERGED', 'CLOSED'])('does not fetch comments for a %s PR', async (state) => {
    const { service, runner } = serviceWith(linkedPayload({ state }))
    expect((await service.autofixSnapshot('acme/widgets', 12, targetId)).state).toBe(state.toLowerCase())
    expect(runner).toHaveBeenCalledOnce()
  })

  it('does not mistake truncated pane membership for a missing PR', async () => {
    const { service } = serviceWith(JSON.stringify({ data: { linked: { issueCount: 101, nodes: [] } } }))
    await expect(service.autofixSnapshot('acme/widgets', 12, targetId)).rejects.toMatchObject({ code: 'pr_list_truncated' })
  })

  it('finds an older open PR that fell off the truncated pane page', async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (args.some((arg) => arg.includes('is:open'))) return linkedPayload({ state: 'MERGED' })
      if (args.some((arg) => arg.startsWith('targetQuery='))) return JSON.stringify({ data: { viewer: { login: 'leo' }, linked: { issueCount: 21, nodes: [] } } })
      return JSON.stringify([[]])
    })
    const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json' })
    expect((await service.autofixSnapshot('acme/widgets', 12, targetId)).state).toBe('merged')
    expect(runner.mock.calls.filter(([args]) => args.some((arg) => arg.includes('is:open')))).toHaveLength(1)
  })

  it('hydrates cached pane status and previews from a repo refresh without another pane query', async () => {
    let now = 1
    const runner = vi.fn().mockResolvedValueOnce(linkedPayload())
      .mockResolvedValueOnce(graphqlPayload([pullRequestNode({ mergeable: 'CONFLICTING', reviewThreads: {
        totalCount: 2, nodes: [{ isResolved: false, comments: { totalCount: 1 } }, { isResolved: false, comments: { totalCount: 2 } }],
      } })]))
    const service = new PrService({ runner, now: () => now })
    await service.listPanePullRequests(targetId)
    now = 2
    await service.listPullRequests('ACME/Widgets', 'open', { refresh: true })
    const cached = await service.listPanePullRequests(targetId)
    expect(cached.pullRequests[0]).toMatchObject({ conflicting: true, unresolvedThreads: 2, unansweredThreads: 1,
      statusFetchedAt: 2, preview: { conflicting: true, unresolvedThreads: 2, unansweredThreads: 1 } })
    expect(cached.fetchedAt).toBe(1)
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('hydrates repo scopes from a pane refresh and removes merged PRs only from open views', async () => {
    let now = 1
    const runner = vi.fn().mockResolvedValueOnce(graphqlPayload([pullRequestNode()]))
      .mockResolvedValueOnce(graphqlPayload([pullRequestNode()]))
      .mockResolvedValueOnce(linkedPayload({ state: 'MERGED' }))
    const service = new PrService({ runner, now: () => now })
    await service.listPullRequests('acme/widgets', 'open')
    await service.listPullRequests('acme/widgets', 'all')
    now = 2
    await service.listPanePullRequests(targetId)
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests).toEqual([])
    expect((await service.listPullRequests('acme/widgets', 'all')).pullRequests[0]).toMatchObject({ state: 'merged' })
    expect(runner).toHaveBeenCalledTimes(3)
  })

  it('shares one search between panes read together and splits results by marker', async () => {
    const other = '550e8400-e29b-41d4-a716-446655440000'
    const node = (target: string, number: number) => pullRequestNode({ number,
      body: `<!-- commando:v1 target=${target} relation=created -->`, repository: { nameWithOwner: 'acme/widgets' } })
    const runner = vi.fn(async (_args: string[]) => JSON.stringify({ data: { viewer: { login: 'leo' },
      linked: { issueCount: 3, nodes: [node(targetId, 12), node(other, 13), node(other, 14)] } } }))
    const service = new PrService({ runner, now: () => 1 })
    const [mine, theirs] = await Promise.all([service.listPanePullRequests(targetId), service.listPanePullRequests(other)])
    expect(runner).toHaveBeenCalledOnce()
    expect(runner.mock.calls[0][0]).toContain(`targetQuery=is:pr in:body ${targetId} OR ${other} sort:created-desc`)
    expect(mine.pullRequests.map((pr) => pr.number)).toEqual([12])
    expect(theirs.pullRequests.map((pr) => pr.number).sort()).toEqual([13, 14])
    expect(theirs).toMatchObject({ totalCount: 2, truncated: false })
  })

  it('lets background reads wait for the next wave but never holds up a foreground read', async () => {
    const other = '550e8400-e29b-41d4-a716-446655440000'
    const runner = vi.fn(async (_args: string[]) => linkedPayload())
    const service = new PrService({ runner, now: () => 1 })
    const first = service.listPanePullRequests(targetId, { background: true })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(runner).not.toHaveBeenCalled()
    const started = Date.now()
    await Promise.all([first, service.listPanePullRequests(other)])
    expect(Date.now() - started).toBeLessThan(500)
    expect(runner).toHaveBeenCalledOnce()
    expect(runner.mock.calls[0][0]).toContain(`targetQuery=is:pr in:body ${targetId} OR ${other} sort:created-desc`)
  })

  it('speeds up a background batch when a foreground read wants the same pane', async () => {
    const runner = vi.fn(async (_args: string[]) => linkedPayload())
    const service = new PrService({ runner, now: () => 1 })
    const background = service.listPanePullRequests(targetId, { background: true })
    const started = Date.now()
    await Promise.all([background, service.listPanePullRequests(targetId, { refresh: true })])
    expect(Date.now() - started).toBeLessThan(500)
    expect(runner).toHaveBeenCalledOnce()
  })

  it('does not let a failed refresh make a kept pane list look fresh', async () => {
    let now = 1
    const runner = vi.fn().mockResolvedValueOnce(linkedPayload()).mockRejectedValueOnce(new PrServiceError(502, 'github_failed', 'GitHub request failed'))
      .mockResolvedValue(linkedPayload({ title: 'Newer' }))
    const service = new PrService({ runner, now: () => now, paneBatchWindowMs: 0 })
    await service.listPanePullRequests(targetId)
    now = 6 * 60_000
    await expect(service.listPanePullRequests(targetId)).rejects.toMatchObject({ code: 'github_failed' })
    expect((await service.listPanePullRequests(targetId, { background: true })).pullRequests[0].title).toBe('Newer')
  })

  it('searches panes separately when a shared search is truncated', async () => {
    const other = '550e8400-e29b-41d4-a716-446655440000'
    const runner = vi.fn(async (args: string[]) => args.some((arg) => arg.includes(' OR '))
      ? JSON.stringify({ data: { viewer: { login: 'leo' }, linked: { issueCount: 99, nodes: [] } } })
      : linkedPayload())
    const service = new PrService({ runner, now: () => 1 })
    const [mine] = await Promise.all([service.listPanePullRequests(targetId), service.listPanePullRequests(other)])
    expect(runner).toHaveBeenCalledTimes(3)
    expect(mine.pullRequests.map((pr) => pr.number)).toEqual([12])
  })

  it('deduplicates forced pane reads and ignores their older result after a newer repository query', async () => {
    let finish!: (output: string) => void
    const runner = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
      .mockResolvedValueOnce(graphqlPayload([pullRequestNode({ title: 'Latest', mergeable: 'CONFLICTING' })]))
    const service = new PrService({ runner, now: () => 1, paneBatchWindowMs: 0 })
    const first = service.listPanePullRequests(targetId, { refresh: true })
    const second = service.listPanePullRequests(targetId, { refresh: true })
    await service.listPullRequests('acme/widgets', 'open')
    finish(linkedPayload({ title: 'Old' }))
    for (const result of await Promise.all([first, second])) {
      expect(result.pullRequests[0]).toMatchObject({ title: 'Latest', conflicting: true })
    }
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].title).toBe('Latest')
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('matches HUD parsing for conflicts, truncated threads, reviews, and rerun checks', async () => {
    const targetId = '123e4567-e89b-42d3-a456-426614174000'
    const node = pullRequestNode({
      body: `<!-- commando:v1 target=${targetId} relation=created -->`,
      repository: { nameWithOwner: 'acme/widgets' },
      additions: 1234, deletions: 56, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED',
      reviewThreads: { totalCount: 60, nodes: [
        { isResolved: false, comments: { totalCount: 1 } },
        { isResolved: true, comments: { totalCount: 1 } },
        { isResolved: false, comments: { totalCount: 2 } },
      ] },
      commits: { totalCount: 3, nodes: [{ commit: { statusCheckRollup: {
        state: 'FAILURE', contexts: { totalCount: 4, nodes: [
          { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
          { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { __typename: 'StatusContext', context: 'lint', state: 'FAILURE' },
          { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null },
        ] },
      } } }] },
    })
    const { service } = serviceWith(JSON.stringify({ data: { viewer: { login: 'leo' }, linked: { issueCount: 1, nodes: [node] } } }), { now: () => 1 })
    const panePr = (await service.listPanePullRequests(targetId)).pullRequests[0]
    const { service: hudService } = serviceWith(graphqlPayload([node]), { now: () => 1 })
    const hudPr = (await hudService.listPullRequests('acme/widgets', 'open')).pullRequests[0]
    expect(panePr.preview).toEqual(hudPr)
    for (const field of ['additions', 'deletions', 'checks', 'conflicting', 'unresolvedThreads', 'unansweredThreads', 'threadsTruncated', 'reviewDecision'] as const) {
      expect(panePr[field]).toEqual(hudPr[field])
    }
    expect(panePr).toMatchObject({
      additions: 1234, deletions: 56, conflicting: true, unresolvedThreads: 2, unansweredThreads: 1,
      threadsTruncated: true, reviewDecision: 'changes_requested',
      checks: { state: 'fail', failed: 1, pending: 1, total: 3 },
    })
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
  it('fetches only authored and review-requested details for mine, with independent scope caches', async () => {
    const runner = vi.fn(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query='))!
      const repoFields = query.split('authored: search')[0]
      const mine = !repoFields.includes('nodes { ...PrFields }')
      const payload = JSON.parse(graphqlPayload(mine ? [] : [pullRequestNode({ number: 99, author: { login: 'other' } })], 733, 'leo', {
        authored: { nodes: [pullRequestNode()] },
        reviewRequested: { nodes: [pullRequestNode({ number: 13, author: { login: 'other' } })] },
      }))
      if (mine) delete payload.data.repository.pullRequests.nodes
      return JSON.stringify(payload)
    })
    const service = new PrService({ runner })
    const mine = await service.listPullRequests('acme/widgets', 'open', { scope: 'mine' })
    expect(mine.pullRequests.map((pr) => pr.number)).toEqual([13, 12])
    expect(mine.pullRequests[0].viewerReviewRequested).toBe(true)
    expect(mine.totalCount).toBe(733)
    const everyone = await service.listPullRequests('acme/widgets', 'open', { scope: 'everyone' })
    expect(everyone.pullRequests.map((pr) => pr.number)).toEqual([99, 13, 12])
    expect((await service.listPullRequests('acme/widgets', 'open', { scope: 'mine' })).pullRequests.map((pr) => pr.number)).toEqual([13, 12])
    expect(runner).toHaveBeenCalledTimes(2)
    await expect(service.listPullRequests('acme/widgets', 'open', { scope: 'bad' as 'mine' })).rejects.toMatchObject({ status: 400 })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it.each([
    new PrServiceError(502, 'github_failed', 'GitHub request failed: gh: HTTP 502'),
    new PrServiceError(502, 'github_failed', 'GitHub request failed: gh: upstream timeout (HTTP 504)'),
    new PrServiceError(504, 'github_timeout', 'GitHub request timed out'),
  ])('hydrates full pages in bounded batches after upstream timeout: %s', async (failure) => {
    const records = Array.from({ length: 32 }, (_, index) => pullRequestNode({ id: `PR_${index}`, number: index + 1 }))
    const discovery = graphqlPayload(records.slice(0, 30).map(({ id }) => ({ id })), 733, 'leo', {
      authored: { nodes: [records[0], records[30]].map(({ id }) => ({ id })), issueCount: 2 },
      reviewRequested: { nodes: [records[31]].map(({ id }) => ({ id })), issueCount: 40 },
    })
    let active = 0
    let maxActive = 0
    const runner = vi.fn(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query='))!
      if (query.includes('fragment PrFields on PullRequest { id }')) return discovery
      if (query.includes('repository(owner:')) throw failure
      const ids = JSON.parse(query.match(/nodes\(ids: (\[[^\]]*\])/)![1]) as string[]
      expect(ids.length).toBeLessThanOrEqual(15)
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return JSON.stringify({ data: { nodes: records.filter((record) => ids.includes(record.id as string)) } })
    })
    const service = new PrService({ runner })
    const list = await service.listPullRequests('acme/widgets', 'open')
    expect(list.totalCount).toBe(733)
    expect(list.pullRequests).toHaveLength(32)
    expect(list.pullRequests[0]).toMatchObject({ number: 32, additions: 100, commitCount: 3 })
    expect(list.truncated).toBe(true)
    expect(list.mineTruncated).toBe(true)
    expect(maxActive).toBe(3)
    expect(runner).toHaveBeenCalledTimes(5) // failed query + discovery + three unique detail batches
    // A list longer than one batch goes straight to discovery next time.
    await service.listPullRequests('acme/widgets', 'open', { refresh: true })
    expect(runner.mock.calls.filter(([args]) => args.some((arg) => arg.includes('repository(owner:') && !arg.includes('fragment PrFields on PullRequest { id }')))).toHaveLength(1)
    expect(runner).toHaveBeenCalledTimes(9)
  })

  it.each([
    { errors: [{ message: 'detail query failed' }], data: { nodes: [] } },
    { data: { nodes: [] } },
    { data: { nodes: [null] } },
  ])('does not return or cache incomplete batched details: %j', async (details) => {
    const runner = vi.fn()
      .mockRejectedValueOnce(new PrServiceError(502, 'github_failed', 'gh: HTTP 502'))
      .mockResolvedValueOnce(graphqlPayload([{ id: 'PR_12' }]))
      .mockResolvedValueOnce(JSON.stringify(details))
      .mockResolvedValueOnce(graphqlPayload([pullRequestNode()]))
    const service = new PrService({ runner })
    await expect(service.listPullRequests('acme/widgets', 'open')).rejects.toMatchObject({ status: 502 })
    expect((await service.listPullRequests('acme/widgets', 'open')).pullRequests).toHaveLength(1)
    expect(runner).toHaveBeenCalledTimes(4)
  })

  it('reads a short list in one query and a long one in batches, switching as it changes size', async () => {
    let records = Array.from({ length: 20 }, (_, index) => pullRequestNode({ id: `PR_${index}`, number: index + 1 }))
    const runner = vi.fn(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query='))!
      if (query.includes('fragment PrFields on PullRequest { id }')) return graphqlPayload(records.map(({ id }) => ({ id })), records.length, 'leo')
      if (query.includes('repository(owner:')) return graphqlPayload(records, records.length, 'leo')
      const ids = JSON.parse(query.match(/nodes\(ids: (\[[^\]]*\])/)![1]) as string[]
      return JSON.stringify({ data: { nodes: records.filter((record) => ids.includes(record.id as string)) } })
    })
    const service = new PrService({ runner, paneBatchWindowMs: 0 })
    const single = () => runner.mock.calls.filter(([args]) => args.some((arg) => arg.includes('repository(owner:') && !arg.includes('fragment PrFields on PullRequest { id }'))).length
    const list = (refresh = true) => service.listPullRequests('acme/widgets', 'open', { scope: 'everyone', refresh })
    expect((await list(false)).pullRequests).toHaveLength(20)
    expect(single()).toBe(1)
    expect((await list()).pullRequests).toHaveLength(20)
    expect(single()).toBe(1)
    expect(runner).toHaveBeenCalledTimes(1 + 1 + 2) // single, then discovery + two batches of 15
    records = records.slice(0, 10)
    await list()
    await list()
    expect(single()).toBe(2)
  })

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

  it('splits unanswered and replied open threads, excludes resolved threads, and flags truncation', async () => {
    const { service, runner } = serviceWith(graphqlPayload([
      pullRequestNode({
        reviewThreads: {
          totalCount: 60,
          nodes: [
            { isResolved: false, comments: { totalCount: 1 } },
            { isResolved: false, comments: { totalCount: 2 } },
            { isResolved: false, comments: { totalCount: 8 } },
            { isResolved: true, comments: { totalCount: 1 } },
            { isResolved: true, comments: { totalCount: 3 } },
          ],
        },
      }),
    ]))
    const list = await service.listPullRequests('acme/widgets', 'open')
    expect(list.pullRequests[0].unresolvedThreads).toBe(3)
    expect(list.pullRequests[0].unansweredThreads).toBe(1)
    expect(list.pullRequests[0].threadsTruncated).toBe(true)
    expect(runner.mock.calls[0][0].join(' ')).toContain('isResolved comments { totalCount }')
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

  it('counts skipped and neutral separately while preserving pass and total semantics', async () => {
    const { service } = serviceWith(graphqlPayload([pullRequestNode({ commits: { nodes: [{ commit: { statusCheckRollup: {
      contexts: { totalCount: 4, nodes: [
        { __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { __typename: 'CheckRun', name: 'report', status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
      ] },
    } } }] } })]))
    const checks = (await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].checks
    expect(checks).toMatchObject({ state: 'pending', failed: 0, pending: 1, skipped: 2, total: 4 })
    expect(checks?.runs.filter((run) => run.skipped)).toEqual([{ name: 'optional', state: 'pass', skipped: true }, { name: 'report', state: 'pass', skipped: true }])
  })

  it('uses deduplicated checks when successful reruns leave the GitHub rollup failed', async () => {
    const { service } = serviceWith(graphqlPayload([
      pullRequestNode({
        commits: { nodes: [{ commit: { statusCheckRollup: {
          state: 'FAILURE',
          contexts: { totalCount: 74, nodes: [
            { __typename: 'CheckRun', name: 'Validate PR title', status: 'COMPLETED', conclusion: 'CANCELLED' },
            { __typename: 'CheckRun', name: 'Validate PR title', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'Linear ticket', status: 'COMPLETED', conclusion: 'CANCELLED' },
            { __typename: 'CheckRun', name: 'Linear ticket', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ] },
        } } }] },
      }),
    ]))

    const checks = (await service.listPullRequests('acme/widgets', 'open')).pullRequests[0].checks
    expect(checks).toEqual({
      state: 'pass',
      runs: [
        { name: 'Validate PR title', state: 'pass' },
        { name: 'Linear ticket', state: 'pass' },
      ],
      failed: 0,
      pending: 0,
      total: 2,
      truncated: true,
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

describe('GitHub rate limit backpressure', () => {
  const rateLimitError = () => new PrServiceError(429, 'rate_limited', 'GitHub rate limit reached')

  it('pauses polled reads after a rate limit and doubles the backoff', async () => {
    let now = 1_000_000
    const runner = vi.fn().mockRejectedValue(rateLimitError())
    const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json', now: () => now })

    await expect(service.listPullRequests('acme/widgets', 'open')).rejects.toMatchObject({ code: 'rate_limited', retryAt: now + 60_000 })
    now += 30_000
    await expect(service.listPanePullRequests('123e4567-e89b-42d3-a456-426614174000')).rejects.toMatchObject({ code: 'rate_limited' })
    expect(runner).toHaveBeenCalledTimes(1)

    now += 30_000
    await expect(service.listPanePullRequests('123e4567-e89b-42d3-a456-426614174000')).rejects.toMatchObject({ code: 'rate_limited', retryAt: now + 120_000 })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('keeps REST reads available when only the protective GraphQL reserve is reached', async () => {
    const now = Date.parse('2026-10-03T10:00:00Z')
    const payload = JSON.parse(graphqlPayload([pullRequestNode()]))
    payload.data.rateLimit = { remaining: 120, resetAt: '2026-10-03T10:20:00Z' }
    const runner = vi.fn().mockResolvedValueOnce(JSON.stringify(payload))
      .mockResolvedValueOnce(JSON.stringify({ state: 'closed', head: { ref: 'feature', sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) } }))
    const service = new PrService({ runner, now: () => now })
    await service.listPullRequests('acme/widgets', 'open')
    await expect(service.pullRequestConflicts('acme/widgets', 12)).resolves.toMatchObject({ state: 'not-open' })
    expect(runner).toHaveBeenCalledTimes(2)
    await expect(service.listPanePullRequests('123e4567-e89b-42d3-a456-426614174000')).rejects.toMatchObject({ code: 'rate_limited' })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('scopes identified primary throttling to the API that rejected the request', async () => {
    const runner = vi.fn().mockRejectedValueOnce(new PrServiceError(429, 'rate_limited', 'Primary limit', undefined, 'primary'))
      .mockResolvedValueOnce(JSON.stringify({ state: 'closed', head: { ref: 'feature', sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) } }))
    const service = new PrService({ runner, now: () => 1_000_000 })
    await expect(service.listPullRequests('acme/widgets', 'open')).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(service.pullRequestConflicts('acme/widgets', 12)).resolves.toMatchObject({ state: 'not-open' })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('treats a RATE_LIMITED GraphQL error as a rate limit', async () => {
    const { service, runner } = serviceWith(JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }))
    await expect(service.listPullRequests('acme/widgets', 'open')).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(service.listPullRequests('acme/widgets', 'closed')).rejects.toMatchObject({ code: 'rate_limited' })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('stops polling until the reset when the remaining budget is low', async () => {
    let now = Date.parse('2026-10-03T10:00:00Z')
    const payload = JSON.parse(graphqlPayload([pullRequestNode()]))
    payload.data.rateLimit = { remaining: 120, resetAt: '2026-10-03T10:20:00Z' }
    const runner = vi.fn().mockResolvedValue(JSON.stringify(payload))
    const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json', now: () => now })

    await expect(service.listPullRequests('acme/widgets', 'open')).resolves.toMatchObject({ totalCount: 1 })
    await expect(service.listPullRequests('acme/widgets', 'open', { refresh: true }))
      .rejects.toMatchObject({ code: 'rate_limited', retryAt: Date.parse('2026-10-03T10:20:00Z') })
    expect(runner).toHaveBeenCalledTimes(1)

    now = Date.parse('2026-10-03T10:20:00Z')
    await service.listPullRequests('acme/widgets', 'open', { refresh: true })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('pauses batched detail hydration once the budget runs low', async () => {
    const now = Date.parse('2026-10-03T10:00:00Z')
    const records = Array.from({ length: 60 }, (_, index) => pullRequestNode({ id: `PR_${index}`, number: index + 1 }))
    const discovery = graphqlPayload(records.map(({ id }) => ({ id })), 733)
    const runner = vi.fn(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query='))!
      if (query.includes('fragment PrFields on PullRequest { id }')) return discovery
      if (query.includes('repository(owner:')) throw new PrServiceError(504, 'github_timeout', 'GitHub request timed out')
      expect(query).toContain('rateLimit { remaining resetAt cost limit }')
      const ids = JSON.parse(/nodes\(ids: (\[[^\]]*\])/.exec(query)![1]!) as string[]
      return JSON.stringify({ data: {
        rateLimit: { remaining: 100, resetAt: '2026-10-03T10:20:00Z' },
        nodes: ids.map((id) => records.find((record) => record.id === id)),
      } })
    })
    const service = new PrService({ runner, preferencesPath: '/nonexistent/prs.json', now: () => now })

    await expect(service.listPullRequests('acme/widgets', 'open', { scope: 'everyone' })).rejects.toMatchObject({ code: 'rate_limited' })
    // Discovery, the timed-out full query, and one detail batch per worker before the pause.
    expect(runner.mock.calls.length).toBe(2 + 3)
  })

  it('asks GitHub for the remaining budget in polled list queries', async () => {
    const { service, runner } = serviceWith(graphqlPayload([pullRequestNode()]))
    await service.listPullRequests('acme/widgets', 'open')
    expect(runner.mock.calls[0]![0].find((arg) => arg.startsWith('query='))).toContain('rateLimit { remaining resetAt cost limit }')
  })
})

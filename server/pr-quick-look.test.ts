import { describe, expect, it, vi } from 'vitest'
import { PrService, PrServiceError } from './prs.js'

const head = '2'.repeat(40)
const main = '3'.repeat(40)

describe('PR quick look data', () => {
  it('paginates thread metadata and attaches actions only to each original inline comment', async () => {
    let threadPages = 0
    const runner = vi.fn(async (args: string[]) => {
      const endpoint = args[1]
      if (endpoint === 'graphql') {
        threadPages++
        const id = threadPages === 1 ? 10 : 20
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
          pageInfo: { hasNextPage: threadPages === 1, endCursor: threadPages === 1 ? 'next-page' : null },
          nodes: [{ id: `PRRT_${id}`, isResolved: id === 20, viewerCanReply: true, viewerCanResolve: id === 10, viewerCanUnresolve: id === 20,
            comments: { nodes: [{ databaseId: id }] } }],
        } } } } })
      }
      if (endpoint.endsWith('/pulls/12')) return JSON.stringify({ head: { sha: head } })
      if (endpoint.includes('/check-runs')) return JSON.stringify([{ check_runs: [] }])
      if (endpoint.includes('/pulls/12/comments')) return JSON.stringify([[{ id: 10 }, { id: 20 }, { id: 30, in_reply_to_id: 10 }]])
      return JSON.stringify([[]])
    })
    const details = await new PrService({ runner }).pullRequestDetails('acme/widgets', 12)
    expect(threadPages).toBe(2)
    expect(runner.mock.calls.some(([args]) => args.includes('cursor=next-page'))).toBe(true)
    expect(details.conversation[0].thread).toMatchObject({ id: 'PRRT_10', isResolved: false, viewerCanResolve: true })
    expect(details.conversation[1].thread).toMatchObject({ id: 'PRRT_20', isResolved: true, viewerCanUnresolve: true })
    expect(details.conversation[2].thread).toBeUndefined()
    expect(details.unresolvedThreads).toBe(1)
  })

  it('marks outdated threads and keeps the code context of each thread root', async () => {
    const hunk = ['@@ -1,10 +1,10 @@', ...Array.from({ length: 10 }, (_, index) => ` line ${index}`)].join('\n')
    const runner = vi.fn(async (args: string[]) => {
      const endpoint = args[1]
      if (endpoint === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ id: 'PRRT_10', isResolved: false, isOutdated: true, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: false,
          comments: { nodes: [{ databaseId: 10 }] } }],
      } } } } })
      if (endpoint.endsWith('/pulls/12')) return JSON.stringify({ head: { sha: head } })
      if (endpoint.includes('/check-runs')) return JSON.stringify([{ check_runs: [] }])
      if (endpoint.includes('/pulls/12/comments')) return JSON.stringify([[
        { id: 10, path: 'a.ts', line: null, original_line: 7, diff_hunk: hunk, created_at: '2026-01-01' },
        { id: 11, path: 'a.ts', line: null, original_line: 7, diff_hunk: hunk, in_reply_to_id: 10, created_at: '2026-01-02' },
      ]])
      return JSON.stringify([[]])
    })
    const details = await new PrService({ runner }).pullRequestDetails('acme/widgets', 12)
    expect(details.conversation[0]).toMatchObject({ originalLine: 7, thread: { isOutdated: true } })
    expect(details.conversation[0].line).toBeUndefined()
    expect(details.conversation[0].diffHunk?.split('\n')).toEqual(Array.from({ length: 8 }, (_, index) => ` line ${index + 2}`))
    expect(details.conversation[1].diffHunk).toBeUndefined()
  })

  it('loads every conversation page and full bodies, sorting reviews and replies chronologically', async () => {
    const runner = vi.fn(async (args: string[]) => {
      const endpoint = args[1]
      if (endpoint === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      } } } })
      if (endpoint.endsWith('/pulls/12'))
        return JSON.stringify({ body: 'Full description '.repeat(100), head: { sha: head } })
      if (endpoint.includes('/check-runs'))
        return JSON.stringify([
          {
            check_runs: [
              { id: 1, name: 'build', status: 'completed', conclusion: 'failure' },
              { id: 2, name: 'build', status: 'completed', conclusion: 'success' },
            ],
          },
        ])
      if (endpoint.includes('/statuses')) return JSON.stringify([[{ context: 'deploy', state: 'pending' }]])
      if (endpoint.includes('/issues/'))
        return JSON.stringify([
          [{ id: 1, body: 'Comment '.repeat(100), created_at: '2026-01-02', user: { login: 'author' } }],
          [{ id: 2, body: 'Second page', created_at: '2026-01-04' }],
        ])
      if (endpoint.includes('/reviews'))
        return JSON.stringify([[{ id: 3, body: 'Review', state: 'APPROVED', submitted_at: '2026-01-01' }]])
      return JSON.stringify([
        [{ id: 4, body: 'Reply', created_at: '2026-01-03', path: 'a.ts', line: 10, in_reply_to_id: 9, pull_request_review_id: 3 }],
      ])
    })
    const result = await new PrService({ runner }).pullRequestDetails('acme/widgets', 12)
    expect(result.body.length).toBeGreaterThan(280)
    expect(result.headOid).toBe(head)
    expect(result.conversation.map((entry) => entry.body.slice(0, 12))).toEqual([
      'Review',
      'Comment Comm',
      'Reply',
      'Second page',
    ])
    expect(result.conversation[2]).toMatchObject({ path: 'a.ts', line: 10, replyTo: 9, commentId: 4, reviewId: 3 })
    expect(result.conversation[0]).toMatchObject({ kind: 'approved', reviewId: 3 })
    expect(result.checks).toEqual([
      { name: 'build', state: 'pass', url: '' },
      { name: 'deploy', state: 'pending', url: '' },
    ])
    expect(runner.mock.calls.filter(([args]) => args.includes('--paginate'))).toHaveLength(5)
  })

  it('compares the immutable remote-main commit with the PR head, rather than the PR base branch', async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ head: { sha: head }, base: { ref: 'release' } }))
      .mockResolvedValueOnce(JSON.stringify({ sha: main }))
      .mockResolvedValueOnce(
        JSON.stringify({
          files: [
            { filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@\n-old\n+new' },
            { filename: 'image.png', status: 'added', additions: 0, deletions: 0 },
          ],
        }),
      )
    const result = await new PrService({ runner }).pullRequestDiff('acme/widgets', 12)
    expect(runner).toHaveBeenNthCalledWith(2, ['api', 'repos/acme/widgets/commits/main'])
    expect(runner).toHaveBeenNthCalledWith(3, ['api', `repos/acme/widgets/compare/${main}...${head}`])
    expect(result).toMatchObject({ base: main, head, truncated: false })
    expect(result.files[1].patch).toBeNull()
  })

  it('lists the PR\'s own files against its base when asked, so a merged PR still has a diff', async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ head: { sha: head }, base: { ref: 'main', sha: main } }))
      .mockResolvedValueOnce(JSON.stringify([
        [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@\n-old\n+new' }],
        [{ filename: 'b.png', status: 'added', additions: 0, deletions: 0 }],
      ]))
    const result = await new PrService({ runner }).pullRequestDiff('acme/widgets', 12, 'pr')
    expect(runner).toHaveBeenNthCalledWith(2, ['api', 'repos/acme/widgets/pulls/12/files?per_page=100', '--paginate', '--slurp'])
    expect(result).toMatchObject({ base: main, head, truncated: false })
    expect(result.files.map((file) => [file.path, file.patch])).toEqual([['a.ts', '@@\n-old\n+new'], ['b.png', null]])
  })

  it('rejects invalid input before sending requests', async () => {
    const runner = vi.fn()
    const service = new PrService({ runner })
    await expect(service.pullRequestDetails('../bad', 12)).rejects.toMatchObject({ status: 400 })
    await expect(service.pullRequestDiff('acme/widgets', '-1')).rejects.toMatchObject({ status: 400 })
    expect(runner).not.toHaveBeenCalled()
  })
})


function cachedDetailsFixture() {
  let now = 1_000_000
  let body = 'Cached description'
  const runner = vi.fn(async (args: string[]) => {
    const endpoint = args[1]
    if (endpoint === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } } })
    if (endpoint.endsWith('/pulls/12')) return JSON.stringify({ body, head: { sha: head }, base: { ref: 'main', sha: main } })
    if (endpoint.includes('/check-runs')) return JSON.stringify([{ check_runs: [] }])
    if (endpoint.includes('/issues/')) return JSON.stringify([[{ id: 1, body: 'Full comment', user: { login: 'reviewer' } }]])
    return JSON.stringify([[]])
  })
  const service = new PrService({ runner, now: () => now })
  return { service, runner, advance: (ms: number) => { now += ms }, setBody: (value: string) => { body = value } }
}

describe('shared PR resource caches', () => {
  it('deduplicates concurrent detail reads across repository casing and reuses all fresh resources', async () => {
    const { service, runner } = cachedDetailsFixture()
    const [first, second] = await Promise.all([
      service.pullRequestDetails('acme/widgets', 12), service.pullRequestDetails('ACME/Widgets', 12),
    ])
    expect(first).toEqual(second)
    expect(runner).toHaveBeenCalledTimes(7)
    await service.pullRequestDetails('acme/widgets', 12)
    expect(runner).toHaveBeenCalledTimes(7)
  })

  it('expires checks and conversation independently while retaining description and metadata for five minutes', async () => {
    const { service, runner, advance, setBody } = cachedDetailsFixture()
    await service.pullRequestDetails('acme/widgets', 12)
    runner.mockClear()
    setBody('Changed on GitHub')
    advance(30_000)
    expect((await service.pullRequestDetails('acme/widgets', 12)).body).toBe('Cached description')
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls.every(([args]) => args[1].includes('/commits/'))).toBe(true)
    runner.mockClear()
    advance(30_000)
    await service.pullRequestDetails('acme/widgets', 12)
    expect(runner).toHaveBeenCalledTimes(6)
    expect(runner.mock.calls.some(([args]) => args[1].endsWith('/pulls/12'))).toBe(false)
    advance(240_000)
    expect((await service.pullRequestDetails('acme/widgets', 12)).body).toBe('Changed on GitHub')
  })

  it('manual refresh bypasses every TTL and concurrent refreshes still share requests', async () => {
    const { service, runner, setBody } = cachedDetailsFixture()
    await service.pullRequestDetails('acme/widgets', 12)
    runner.mockClear()
    setBody('Fresh description')
    const values = await Promise.all([service.pullRequestDetails('acme/widgets', 12, { refresh: true }),
      service.pullRequestDetails('acme/widgets', 12, { refresh: true })])
    expect(values.every((value) => value.body === 'Fresh description')).toBe(true)
    expect(runner).toHaveBeenCalledTimes(7)
  })

  it('retains cached content with original timestamps and retryAt during shared upstream throttling', async () => {
    const { service, runner } = cachedDetailsFixture()
    const previous = await service.pullRequestDetails('acme/widgets', 12)
    runner.mockRejectedValue(new PrServiceError(429, 'rate_limited', 'GitHub rate limit reached'))
    const paused = await service.pullRequestDetails('acme/widgets', 12, { refresh: true })
    expect(paused).toMatchObject({ body: previous.body, conversation: previous.conversation, stale: true,
      retryAt: 1_060_000, fetchedAt: previous.fetchedAt })
  })

  it('can display REST details without thread actions when the GraphQL budget is exhausted', async () => {
    const { service, runner } = cachedDetailsFixture()
    const original = runner.getMockImplementation()!
    runner.mockImplementation(async (args) => {
      if (args[1] === 'graphql') throw new PrServiceError(429, 'rate_limited', 'Primary GraphQL limit', undefined, 'primary')
      return original(args)
    })
    const result = await service.pullRequestDetails('acme/widgets', 12)
    expect(result).toMatchObject({ body: 'Cached description', stale: true, retryAt: 1_060_000 })
    expect(result.conversation).toHaveLength(1)
    expect(result.conversation[0].thread).toBeUndefined()
    expect(result.unresolvedThreads).toBeUndefined()
    expect(result.fetchedAt?.conversation).toBe(1_000_000)
  })

  it('does not hide permission failures behind stale content', async () => {
    const { service, runner } = cachedDetailsFixture()
    await service.pullRequestDetails('acme/widgets', 12)
    runner.mockRejectedValue(new PrServiceError(401, 'auth_required', 'Log in again'))
    await expect(service.pullRequestDetails('acme/widgets', 12, { refresh: true })).rejects.toMatchObject({ code: 'auth_required' })
  })

  it('invalidates resources after a thread write, including a read already in flight', async () => {
    const { service, runner, setBody } = cachedDetailsFixture()
    await service.pullRequestDetails('acme/widgets', 12)
    const original = runner.getMockImplementation()!
    let finishOld!: (value: string) => void
    runner.mockImplementation(async (args) => args[1].endsWith('/pulls/12')
      ? new Promise<string>((resolve) => { finishOld = resolve }) : original(args))
    const oldRead = service.pullRequestDetails('acme/widgets', 12, { refresh: true })
    await vi.waitFor(() => expect(finishOld).toBeDefined())
    runner.mockResolvedValueOnce(JSON.stringify({ data: { node: { id: 'PRRT_1', isResolved: true,
      pullRequest: { number: 12, repository: { nameWithOwner: 'acme/widgets' } } } } }))
    await service.actOnReviewThread('acme/widgets', 12, 'PRRT_1', 'resolve')
    runner.mockImplementation(original)
    setBody('After write')
    expect((await service.pullRequestDetails('acme/widgets', 12)).body).toBe('After write')
    finishOld(JSON.stringify({ body: 'Before write', head: { sha: head }, base: { ref: 'main', sha: main } }))
    await oldRead
    expect((await service.pullRequestDetails('acme/widgets', 12)).body).toBe('After write')
  })
})

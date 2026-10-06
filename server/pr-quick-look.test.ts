import { describe, expect, it, vi } from 'vitest'
import { PrService } from './prs.js'

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

  it('rejects invalid input before sending requests', async () => {
    const runner = vi.fn()
    const service = new PrService({ runner })
    await expect(service.pullRequestDetails('../bad', 12)).rejects.toMatchObject({ status: 400 })
    await expect(service.pullRequestDiff('acme/widgets', '-1')).rejects.toMatchObject({ status: 400 })
    expect(runner).not.toHaveBeenCalled()
  })
})

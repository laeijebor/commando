import { describe, expect, it, vi } from 'vitest'
import { PrService } from './prs.js'

const head = '2'.repeat(40)
const main = '3'.repeat(40)

describe('PR quick look data', () => {
  it('loads every conversation page and full bodies, sorting reviews and replies chronologically', async () => {
    const runner = vi.fn(async (args: string[]) => {
      const endpoint = args[1]
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
        [{ id: 4, body: 'Reply', created_at: '2026-01-03', path: 'a.ts', line: 10, in_reply_to_id: 9 }],
      ])
    })
    const result = await new PrService({ runner }).pullRequestDetails('acme/widgets', 12)
    expect(result.body.length).toBeGreaterThan(280)
    expect(result.conversation.map((entry) => entry.body.slice(0, 12))).toEqual([
      'Review',
      'Comment Comm',
      'Reply',
      'Second page',
    ])
    expect(result.conversation[2]).toMatchObject({ path: 'a.ts', line: 10, replyTo: 9 })
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

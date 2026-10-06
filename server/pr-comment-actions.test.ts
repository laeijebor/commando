import { describe, expect, it, vi } from 'vitest'
import { PrService } from './prs.js'

const thread = {
  id: 'PRRT_123', isResolved: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true,
  pullRequest: { number: 12, repository: { nameWithOwner: 'acme/widgets' } },
}
const current = (patch: Record<string, unknown> = {}) => JSON.stringify({ data: { node: { ...thread, ...patch } } })

describe('PR review thread actions', () => {
  it('posts a Markdown reply using variables and preserves its exact body', async () => {
    const runner = vi.fn().mockResolvedValueOnce(current()).mockResolvedValueOnce(JSON.stringify({ data: {
      addPullRequestReviewThreadReply: { comment: { id: 'PRRC_456' } },
    } }))
    const body = '**Fixed**\n\nSee `a.ts`.\n$variables "quotes" & punctuation'
    await expect(new PrService({ runner }).actOnReviewThread('acme/widgets', 12, thread.id, 'reply', body)).resolves.toEqual({ ok: true })
    expect(runner.mock.calls[1][0]).toEqual(expect.arrayContaining(['-f', `id=${thread.id}`, '-f', `body=${body}`]))
    expect(runner.mock.calls[1][0].join(' ')).toContain('pullRequestReviewThreadId: $id')
  })

  it.each(['resolve', 'reopen'] as const)('uses the %s mutation and verifies the resulting state', async (action) => {
    const resolved = action === 'resolve'
    const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
    const runner = vi.fn().mockResolvedValueOnce(current({ isResolved: !resolved })).mockResolvedValueOnce(JSON.stringify({ data: {
      [field]: { thread: { id: thread.id, isResolved: resolved } },
    } }))
    await expect(new PrService({ runner }).actOnReviewThread('ACME/Widgets', 12, thread.id, action)).resolves.toEqual({ ok: true })
    expect(runner.mock.calls[1][0].join(' ')).toContain(`${field}(input: {threadId: $id})`)
  })

  it.each(['reply', 'resolve', 'reopen'] as const)('checks current permissions before %s', async (action) => {
    const runner = vi.fn().mockResolvedValue(current({ isResolved: action === 'reopen', viewerCanReply: false, viewerCanResolve: false, viewerCanUnresolve: false }))
    await expect(new PrService({ runner }).actOnReviewThread('acme/widgets', 12, thread.id, action, 'Reply')).rejects.toMatchObject({ status: 403, code: 'thread_action_forbidden' })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it.each([
    { pullRequest: { number: 13, repository: { nameWithOwner: 'acme/widgets' } } },
    { pullRequest: { number: 12, repository: { nameWithOwner: 'other/repo' } } },
  ])('rejects a thread belonging to another PR or repository', async (patch) => {
    const runner = vi.fn().mockResolvedValue(current(patch))
    await expect(new PrService({ runner }).actOnReviewThread('acme/widgets', 12, thread.id, 'reply', 'Reply')).rejects.toMatchObject({ status: 404 })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('treats an already resolved thread as success without a second write', async () => {
    const runner = vi.fn().mockResolvedValue(current({ isResolved: true, viewerCanResolve: false }))
    await expect(new PrService({ runner }).actOnReviewThread('acme/widgets', 12, thread.id, 'resolve')).resolves.toEqual({ ok: true })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('rejects empty/oversized replies, invalid ids, and unknown actions before GitHub', async () => {
    const runner = vi.fn()
    const service = new PrService({ runner })
    for (const body of ['', ' \n ', 'a'.repeat(60_001), null]) {
      await expect(service.actOnReviewThread('acme/widgets', 12, thread.id, 'reply', body)).rejects.toMatchObject({ status: 400 })
    }
    await expect(service.actOnReviewThread('acme/widgets', 12, '../bad', 'resolve')).rejects.toMatchObject({ status: 400 })
    await expect(service.actOnReviewThread('acme/widgets', 12, thread.id, 'unknown')).rejects.toMatchObject({ status: 400 })
    expect(runner).not.toHaveBeenCalled()
  })

  it('surfaces GraphQL write errors instead of claiming the reply was sent', async () => {
    const runner = vi.fn().mockResolvedValueOnce(current()).mockResolvedValueOnce(JSON.stringify({ data: { addPullRequestReviewThreadReply: null }, errors: [{ message: 'Thread is locked' }] }))
    await expect(new PrService({ runner }).actOnReviewThread('acme/widgets', 12, thread.id, 'reply', 'Reply')).rejects.toThrow('Thread is locked')
  })

  it('rejects a mutation response without a created reply', async () => {
    const runner = vi.fn().mockResolvedValueOnce(current()).mockResolvedValueOnce(JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: null } } }))
    await expect(new PrService({ runner }).actOnReviewThread('acme/widgets', 12, thread.id, 'reply', 'Reply')).rejects.toMatchObject({ code: 'github_invalid_response' })
  })
})

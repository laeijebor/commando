import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateTmuxSessionRequest, SessionCreation, SessionCreationProgress, TmuxCreateResponse } from '../shared/tmux-create.js'
import { SessionCreations } from './session-creations.js'

const RESPONSE: TmuxCreateResponse = {
  created: { kind: 'session', sessionId: '$7', sessionName: 'cd-failure', windowId: '@7', windowIndex: 0, windowName: 'main', paneId: '%7', paneIndex: 0, panePath: '/repo-worktrees/cd-failure' },
  worktree: { path: '/repo-worktrees/cd-failure', branch: 'cd-failure', base: 'origin/main', reusedBranch: false },
}
const REQUEST = { name: 'CD Failure', cwd: '/repo', worktree: { branch: 'cd-failure' }, groupId: 'group:abc' }

/** A create function the test drives step by step. */
function controlledCreate() {
  const calls: Array<{ input: CreateTmuxSessionRequest; progress: SessionCreationProgress; finish: (result: TmuxCreateResponse) => void; fail: (error: Error) => void }> = []
  const create = (input: CreateTmuxSessionRequest, progress: SessionCreationProgress) => new Promise<TmuxCreateResponse>((resolve, reject) => {
    calls.push({ input, progress, finish: resolve, fail: reject })
  })
  return { create, calls }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('SessionCreations', () => {
  afterEach(() => vi.useRealTimers())

  it('answers with the finished creation, never listing it, when nothing slow happens', async () => {
    const changes: SessionCreation[][] = []
    const creations = new SessionCreations(async () => RESPONSE, (list) => changes.push(list), () => 1000)
    const creation = await creations.start(REQUEST)
    expect(creation).toMatchObject({ name: 'CD Failure', cwd: '/repo', branch: 'cd-failure', groupId: 'group:abc', stage: 'done', result: RESPONSE, startedAt: 1000 })
    expect(creations.list()).toEqual([])
    expect(changes).toEqual([])
  })

  it('rejects an early failure so the form can show it, leaving nothing listed', async () => {
    const changes: SessionCreation[][] = []
    const creations = new SessionCreations(async () => { throw new Error('Branch x is already checked out at /elsewhere') }, (list) => changes.push(list))
    await expect(creations.start(REQUEST)).rejects.toThrow('already checked out')
    expect(creations.list()).toEqual([])
    expect(changes).toEqual([])
  })

  it('answers once the checkout starts, then reports its progress until it is done', async () => {
    vi.useFakeTimers()
    const { create, calls } = controlledCreate()
    const changes: SessionCreation[][] = []
    const creations = new SessionCreations(create, (list) => changes.push(list))
    const started = creations.start(REQUEST)
    expect(calls[0]!.input).toEqual({ name: 'CD Failure', cwd: '/repo', worktree: { branch: 'cd-failure' } })
    calls[0]!.progress('fetching')
    const creation = await started
    expect(creation.stage).toBe('fetching')

    calls[0]!.progress('checking-out')
    calls[0]!.progress('checking-out', 42)
    calls[0]!.progress('launching')
    calls[0]!.finish(RESPONSE)
    await vi.advanceTimersByTimeAsync(0)
    expect(changes.map((list) => [list[0]?.stage, list[0]?.percent])).toEqual([
      ['fetching', undefined],
      ['checking-out', undefined],
      ['checking-out', 42],
      ['launching', undefined],
      ['done', undefined],
    ])
    expect(creations.list()[0]).toMatchObject({ id: creation.id, stage: 'done', result: RESPONSE })

    // Kept for a while so the client that started it can finish it, even after reconnecting.
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(creations.list()).toEqual([])
  })

  it('keeps a background failure until it is retried with the same request or dismissed', async () => {
    const { create, calls } = controlledCreate()
    const creations = new SessionCreations(create, () => undefined)
    const started = creations.start(REQUEST)
    calls[0]!.progress('checking-out')
    const { id } = await started
    expect(creations.dismiss(id)).toBe(false)

    calls[0]!.fail(new Error('git worktree add failed: fatal: disk full'))
    await flush()
    expect(creations.list()).toEqual([expect.objectContaining({ id, stage: 'failed', error: 'git worktree add failed: fatal: disk full' })])

    expect(creations.retry(id)).toMatchObject({ id, stage: 'preparing' })
    expect(creations.list()[0]).not.toHaveProperty('error')
    expect(calls[1]!.input).toEqual(calls[0]!.input)
    expect(creations.retry(id)).toBeUndefined()

    calls[1]!.fail(new Error('still broken'))
    await flush()
    expect(creations.dismiss(id)).toBe(true)
    expect(creations.list()).toEqual([])
  })
})

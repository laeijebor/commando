// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardView } from '../shared/board'
import { createBoardsApi, publishBoardChange } from './boardsApi'
import { useBoard } from './useBoard'

const board = (rev: number): BoardView => ({ targetId: 'target', rev, items: [], groups: [], placements: {}, links: [] })
function deferred() {
  let resolve!: (value: BoardView) => void
  const promise = new Promise<BoardView>((done) => { resolve = done })
  return { promise, resolve }
}
function setup() {
  const first = deferred(), trailing = deferred()
  const get = vi.fn<ReturnType<typeof createBoardsApi>['get']>()
    .mockReturnValueOnce(first.promise).mockReturnValue(trailing.promise)
  const api = { ...createBoardsApi(''), get }
  const hook = renderHook(() => useBoard('target', 'local', true, api))
  return { ...hook, first, trailing, get }
}
const notify = (rev: number) => publishBoardChange({ targetId: 'target', host: 'local', rev })

afterEach(cleanup)

describe('useBoard revision coalescing', () => {
  it('coalesces 20 notifications into at most two reads without aborting the first', async () => {
    const { first, trailing, get, result } = setup()
    const signal = get.mock.calls[0][1]!
    act(() => { for (let rev = 1; rev <= 20; rev++) notify(rev) })
    expect(get).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(false)
    await act(async () => first.resolve(board(1)))
    expect(get).toHaveBeenCalledTimes(2)
    await act(async () => trailing.resolve(board(20)))
    expect(result.current.board?.rev).toBe(20)
    act(() => { for (let rev = 20; rev >= 1; rev--) notify(rev) })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('skips a trailing read when the in-flight result already includes the newest revision', async () => {
    const { first, get, result } = setup()
    act(() => { for (let rev = 1; rev <= 20; rev++) notify(rev) })
    await act(async () => first.resolve(board(20)))
    expect(result.current.board?.rev).toBe(20)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('ignores notifications at or below the current revision and for another board or host', async () => {
    const { first, get } = setup()
    await act(async () => first.resolve(board(20)))
    act(() => {
      notify(20); notify(19)
      publishBoardChange({ targetId: 'other', host: 'local', rev: 30 })
      publishBoardChange({ targetId: 'target', host: 'remote', rev: 30 })
    })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('rechecks a stale response even when no further notification arrives during its read', async () => {
    const { first, trailing, get, result } = setup()
    await act(async () => first.resolve(board(1)))
    act(() => notify(2))
    expect(get).toHaveBeenCalledTimes(2)
    get.mockResolvedValue(board(2))
    await act(async () => trailing.resolve(board(1)))
    expect(get).toHaveBeenCalledTimes(3)
    expect(result.current.board?.rev).toBe(2)
  })

  it('does not spin if the trailing response still lags, and can retry later', async () => {
    const { first, trailing, get, result } = setup()
    act(() => notify(20))
    await act(async () => first.resolve(board(1)))
    await act(async () => trailing.resolve(board(2)))
    expect(get).toHaveBeenCalledTimes(2)
    get.mockResolvedValue(board(20))
    await act(async () => result.current.retry())
    expect(get).toHaveBeenCalledTimes(3)
    expect(result.current.board?.rev).toBe(20)
  })
})

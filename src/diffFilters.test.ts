import { afterEach, expect, it } from 'vitest'
import { DEFAULT_DIFF_FILTERS, type DiffFilters } from '../shared/diff-filters'
import { currentDiffFilters, resetDiffFilters, setDiffFilters, setDiffFiltersSaver, updateDiffFilters } from './diffFilters'

afterEach(() => { setDiffFiltersSaver(null); resetDiffFilters() })

function deferredSaver() {
  const pending: Array<(filters: DiffFilters) => void> = []
  setDiffFiltersSaver(() => new Promise<DiffFilters>((resolve) => { pending.push(resolve) }))
  return pending
}

it('ignores its own save answer once another window has saved something newer', async () => {
  const pending = deferredSaver()
  const saving = updateDiffFilters({ hideTests: true })
  expect(currentDiffFilters().hideTests).toBe(true)
  // Window B turned it off after our save; its broadcast arrives before our PUT answer.
  setDiffFilters({ ...DEFAULT_DIFF_FILTERS, hideTests: false, revision: 2 })
  pending[0]!({ ...DEFAULT_DIFF_FILTERS, hideTests: true, revision: 1 })
  await saving
  expect(currentDiffFilters()).toEqual({ ...DEFAULT_DIFF_FILTERS, hideTests: false, revision: 2 })
})

it('applies the newest of overlapping own saves whatever order the answers come in', async () => {
  const pending = deferredSaver()
  const first = updateDiffFilters({ hideTests: true })
  const second = updateDiffFilters({ hideGenerated: true })
  pending[1]!({ ...DEFAULT_DIFF_FILTERS, hideTests: true, hideGenerated: true, revision: 2 })
  await second
  pending[0]!({ ...DEFAULT_DIFF_FILTERS, hideTests: true, revision: 1 })
  await first
  expect(currentDiffFilters()).toMatchObject({ hideTests: true, hideGenerated: true, revision: 2 })
})

it('drops a late answer from the daemon it switched away from, and undoes a failed flip', async () => {
  const pending = deferredSaver()
  const saving = updateDiffFilters({ hideTests: true })
  resetDiffFilters()
  pending[0]!({ ...DEFAULT_DIFF_FILTERS, hideTests: true, revision: 9 })
  await saving
  expect(currentDiffFilters()).toEqual(DEFAULT_DIFF_FILTERS)
  setDiffFiltersSaver(async () => { throw new Error('offline') })
  await expect(updateDiffFilters({ hideGenerated: true })).rejects.toThrow('offline')
  expect(currentDiffFilters().hideGenerated).toBe(false)
})

it('falls back to the confirmed state when overlapping saves both fail, in either order', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    resetDiffFilters()
    setDiffFilters({ ...DEFAULT_DIFF_FILTERS, revision: 3 })
    const rejects: Array<(error: Error) => void> = []
    setDiffFiltersSaver(() => new Promise<DiffFilters>((_resolve, reject) => { rejects.push(reject) }))
    const first = updateDiffFilters({ hideTests: true })
    const second = updateDiffFilters({ hideGenerated: true })
    expect(currentDiffFilters()).toMatchObject({ hideTests: true, hideGenerated: true })
    for (const index of order) rejects[index]!(new Error('disk full'))
    await expect(first).rejects.toThrow('disk full')
    await expect(second).rejects.toThrow('disk full')
    expect(currentDiffFilters()).toEqual({ ...DEFAULT_DIFF_FILTERS, revision: 3 })
  }
})

it('keeps a flip that is still saving on top of updates from other windows', async () => {
  const pending = deferredSaver()
  const saving = updateDiffFilters({ hideTests: true })
  setDiffFilters({ ...DEFAULT_DIFF_FILTERS, hideGenerated: true, revision: 1 })
  expect(currentDiffFilters()).toMatchObject({ hideTests: true, hideGenerated: true })
  pending[0]!({ ...DEFAULT_DIFF_FILTERS, hideTests: true, hideGenerated: true, revision: 2 })
  await saving
  expect(currentDiffFilters()).toEqual({ ...DEFAULT_DIFF_FILTERS, hideTests: true, hideGenerated: true, revision: 2 })
})

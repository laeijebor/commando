import { act, renderHook, waitFor } from '@testing-library/react-native'

import { PrResourceCache, usePrResource } from './cache'

it('shares one in-flight read, serves fresh copies and keeps the last value beside an error', async () => {
  const cache = new PrResourceCache()
  let calls = 0
  const fetcher = jest.fn(async () => ++calls)
  await Promise.all([cache.load('k', fetcher, { ttlMs: 60_000 }), cache.load('k', fetcher, { ttlMs: 60_000 })])
  expect(fetcher).toHaveBeenCalledTimes(1)
  await cache.load('k', fetcher, { ttlMs: 60_000 })
  expect(fetcher).toHaveBeenCalledTimes(1)
  await cache.load('k', async () => { throw new Error('rate limited') }, { ttlMs: 60_000, force: true })
  expect(cache.peek('k')).toMatchObject({ value: 1, error: 'rate limited', loading: false })
})

it('evicts the oldest unwatched entries past its bound', async () => {
  const cache = new PrResourceCache(2)
  const stop = cache.subscribe('a', () => undefined)
  for (const key of ['a', 'b', 'c']) await cache.load(key, async () => key, { ttlMs: 1 })
  expect(cache.peek('a')?.value).toBe('a')
  stop()
  await cache.load('d', async () => 'd', { ttlMs: 1 })
  expect(cache.size).toBe(2)
})

it('reads only while enabled and forces a read on refresh', async () => {
  const cache = new PrResourceCache()
  const fetcher = jest.fn(async (refresh: boolean) => (refresh ? 'forced' : 'cached'))
  const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => usePrResource('pr', fetcher, { enabled, ttlMs: 60_000, cache }), { initialProps: { enabled: false } })
  expect(fetcher).not.toHaveBeenCalled()
  rerender({ enabled: true })
  await waitFor(() => expect(result.current.data).toBe('cached'))
  await act(async () => { await result.current.refresh() })
  expect(result.current.data).toBe('forced')
  expect(fetcher).toHaveBeenLastCalledWith(true)
})

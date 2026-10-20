import { act, renderHook } from '@testing-library/react-native'
import { usePollingQuery } from './usePollingQuery'
import { useAppActive } from './useAppActive'
import { AppState, type AppStateStatus } from 'react-native'
beforeEach(() => jest.useFakeTimers())
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })
it('loads only while focused, deduplicates in flight, and stops after leaving', async () => {
  let finish!: (value: number) => void
  const load = jest.fn(() => new Promise<number>((resolve) => { finish = resolve }))
  const view = renderHook<{ data?: number; error?: unknown }, { active: boolean }>(({ active }) => usePollingQuery('focus-test', load, active, 1000), { initialProps: { active: false } })
  await act(async () => undefined)
  expect(load).not.toHaveBeenCalled()
  view.rerender({ active: true }); await act(async () => undefined)
  act(() => jest.advanceTimersByTime(5000))
  expect(load).toHaveBeenCalledTimes(1)
  view.rerender({ active: false }); view.rerender({ active: true })
  await act(async () => undefined)
  expect(load).toHaveBeenCalledTimes(1)
  await act(async () => finish(42))
  expect(view.result.current.data).toBe(42)
  view.rerender({ active: false })
  act(() => jest.advanceTimersByTime(5000))
  expect(load).toHaveBeenCalledTimes(1)
})
it('treats background AppState and loss of focus as inactive', () => {
  let change!: (state: AppStateStatus) => void
  const remove = jest.fn()
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => { change = listener; return { remove } })
  const view = renderHook<boolean, { focused: boolean }>(({ focused }) => useAppActive(focused), { initialProps: { focused: true } })
  act(() => change('background'))
  expect(view.result.current).toBe(false)
  act(() => change('active'))
  expect(view.result.current).toBe(true)
  view.rerender({ focused: false })
  expect(view.result.current).toBe(false)
  view.unmount(); expect(remove).toHaveBeenCalled()
})

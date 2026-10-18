import { fetchPanePrs } from '../daemon/paneApi'
import { PANE_PRS } from '../testing/fixtures'
import { PanePrCache } from './prCache'
const host = { id: 'pr-cache', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token' as const, token: 'secret' } }
jest.mock('../daemon/paneApi', () => ({ fetchPanePrs: jest.fn() }))
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks() })
afterEach(() => jest.useRealTimers())
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
it('shares a background request and timer, stops polling invisible rows and bounds stored results', async () => {
  ;(fetchPanePrs as jest.Mock).mockResolvedValue(PANE_PRS)
  const cache = new PanePrCache(2)
  const listener = jest.fn()
  const stop = cache.subscribe(host, '%14', listener)
  const stopOther = cache.subscribe(host, '%14', jest.fn())
  await flush()
  expect(fetchPanePrs).toHaveBeenCalledTimes(1)
  expect(fetchPanePrs).toHaveBeenCalledWith(host, '%14', { background: true })
  expect(listener).toHaveBeenCalledWith(PANE_PRS)
  stop(); stopOther()
  jest.advanceTimersByTime(180_000); await flush()
  expect(fetchPanePrs).toHaveBeenCalledTimes(1)
  const subscriptions = ['%15', '%16'].map((id) => cache.subscribe(host, id, jest.fn()))
  await flush()
  expect(cache.size).toBe(2)
  subscriptions.forEach((unsubscribe) => unsubscribe())
})
it('never overlaps a pending load even across polling ticks', async () => {
  let finish!: (value: typeof PANE_PRS) => void
  ;(fetchPanePrs as jest.Mock).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  const cache = new PanePrCache()
  const stop = cache.subscribe(host, '%14', jest.fn())
  await flush()
  jest.advanceTimersByTime(180_000); await flush()
  expect(fetchPanePrs).toHaveBeenCalledTimes(1)
  finish(PANE_PRS); await flush(); stop()
})

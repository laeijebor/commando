import type { FSWatcher, WatchListener, watch } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPane } from '../shared/protocol.js'
import { CanvasWatch } from './canvas-watch.js'

const pane = (artifactId: string): WebPane => ({ id: 'w-12345678', content: { kind: 'canvas', artifactId, manifest: 'canvas.json' }, url: '', sessionId: '$1', windowId: '@1', anchorPaneId: '%1', placement: 'right', engine: 'webkit', openedBy: 'agent', status: 'open', createdAt: 0 })
afterEach(() => vi.useRealTimers())
describe('canvas watch', () => {
  it('starts one recursive watcher per referenced artifact and debounces changed relative paths', () => {
    vi.useFakeTimers()
    const callbacks: WatchListener<string>[] = [], closes: ReturnType<typeof vi.fn>[] = []
    const factory = vi.fn((_dir, options, callback) => {
      expect(options).toEqual({ recursive: true })
      callbacks.push(callback)
      const close = vi.fn(); closes.push(close)
      return { close, on: vi.fn() } as unknown as FSWatcher
    })
    const notify = vi.fn(), directory = vi.fn((id: string) => `/tmp/${id}`)
    const watcher = new CanvasWatch({ directory }, notify, factory as unknown as typeof watch)
    watcher.sync([pane('one'), pane('one')]); watcher.sync([pane('one')])
    expect(factory).toHaveBeenCalledTimes(1)
    callbacks[0]('change', 'Settings.html'); vi.advanceTimersByTime(100)
    callbacks[0]('rename', 'assets/icon.svg'); callbacks[0]('change', 'Settings.html')
    vi.advanceTimersByTime(149); expect(notify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(notify).toHaveBeenCalledWith({ artifactId: 'one', changed: ['Settings.html', 'assets/icon.svg'] })
    callbacks[0]('change', null); vi.advanceTimersByTime(150)
    expect(notify).toHaveBeenLastCalledWith({ artifactId: 'one', changed: ['*'] })
    watcher.sync([pane('one'), pane('two')]); expect(factory).toHaveBeenCalledTimes(2)
    watcher.sync([pane('two')]); expect(closes[0]).toHaveBeenCalledOnce(); expect(closes[1]).not.toHaveBeenCalled()
    callbacks[1]('change', 'canvas.json'); watcher.close(); vi.advanceTimersByTime(150)
    expect(notify).toHaveBeenCalledTimes(2); expect(closes[1]).toHaveBeenCalledOnce()
  })
  it('ignores unregistered artifacts and closes watchers after unregistering', () => {
    const directory = vi.fn().mockReturnValue(null), close = vi.fn()
    const factory = vi.fn().mockReturnValue({ close, on: vi.fn() })
    const watcher = new CanvasWatch({ directory }, vi.fn(), factory as typeof watch)
    watcher.sync([pane('missing')]); expect(factory).not.toHaveBeenCalled()
    directory.mockReturnValue('/tmp/registered'); watcher.sync([pane('missing')])
    directory.mockReturnValue(null); watcher.sync([pane('missing')]); expect(close).toHaveBeenCalledOnce()
  })
})

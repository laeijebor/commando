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
    callbacks[0]('rename', '.commando-canvas-self-write.tmp'); callbacks[0]('change', 'nested/.commando-canvas-self-write.tmp')
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
  it('rebinds to a folder replaced in place and tells open tabs everything changed', () => {
    const closes: ReturnType<typeof vi.fn>[] = []
    const factory = vi.fn(() => { const close = vi.fn(); closes.push(close); return { close, on: vi.fn() } as unknown as FSWatcher })
    const notify = vi.fn()
    const watcher = new CanvasWatch({ directory: (id) => `/tmp/${id}` }, notify, factory as unknown as typeof watch)
    watcher.sync([pane('deck')])
    watcher.replaced('deck')
    expect(closes[0]).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith({ artifactId: 'deck', changed: ['*'] })
    // An artifact no tab shows is only announced, not watched.
    watcher.replaced('other')
    expect(factory).toHaveBeenCalledTimes(2)
    watcher.close()
  })
  it('keeps reporting edits after the watched folder is swapped for a new copy', async () => {
    const { mkdtemp, mkdir, rename, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'canvas-watch-swap-'))
    const live = join(root, 'deck')
    await mkdir(live)
    await writeFile(join(live, 'deck.html'), 'one')
    const notify = vi.fn()
    const watcher = new CanvasWatch({ directory: () => live }, notify)
    try {
      watcher.sync([pane('deck')])
      // Present again: a new copy is renamed into place over the watched folder.
      await mkdir(join(root, 'next'))
      await writeFile(join(root, 'next', 'deck.html'), 'two')
      await rename(live, join(root, 'old'))
      await rename(join(root, 'next'), live)
      await rm(join(root, 'old'), { recursive: true })
      watcher.replaced('deck')
      expect(notify).toHaveBeenLastCalledWith({ artifactId: 'deck', changed: ['*'] })
      notify.mockClear()
      await new Promise((resolve) => setTimeout(resolve, 200))
      await writeFile(join(live, 'deck.html'), 'three')
      await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ artifactId: 'deck', changed: expect.arrayContaining(['deck.html']) }), { timeout: 10_000 })
    } finally {
      watcher.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

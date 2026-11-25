import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardChangeNotifications, BoardTileTitles } from './boards-publish.js'
import type { WebPane } from '../shared/protocol.js'
const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const pane = { content: { kind: 'canvas', artifactId: 'a'.repeat(16), manifest: 'canvas.json' } } as WebPane

describe('Board publication', () => {
  it('coalesces each target to its latest revision and cancels timers on stop', async () => {
    vi.useFakeTimers()
    const changed = vi.fn(), notifications = new BoardChangeNotifications(changed)
    for (let rev = 1; rev <= 100; rev++) notifications.enqueue('a', rev)
    notifications.enqueue('b', 3)
    expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(249); expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(changed.mock.calls).toEqual([['a', 100], ['b', 3]])
    notifications.enqueue('a', 101); await vi.advanceTimersByTimeAsync(250)
    expect(changed).toHaveBeenLastCalledWith('a', 101)
    notifications.enqueue('a', 102); notifications.stop(); await vi.advanceTimersByTimeAsync(250)
    expect(changed).toHaveBeenCalledTimes(3)
  })
  it('only stats on publication, reads unchanged titles once and refreshes changed manifests asynchronously', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-titles-')); dirs.push(dir)
    const path = join(dir, 'canvas.json'); writeFileSync(path, '{"title":"First","frames":[]}')
    const read = vi.fn((file: string) => readFile(file, 'utf8')), changed = vi.fn()
    const cache = new BoardTileTitles({ artifacts: { resolve: () => path }, read, changed })
    expect(cache.title(pane)).toBeUndefined(); expect(read).not.toHaveBeenCalled()
    await cache.idle()
    for (let i = 0; i < 100; i++) expect(cache.title(pane)).toBe('First')
    expect(read).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledOnce()
    writeFileSync(path, '{"title":"Second","frames":[]}')
    // Explicit mtime change also covers equal-sized edits on coarse filesystems.
    const now = statSync(path); utimesSync(path, now.atime, new Date(now.mtimeMs + 1000))
    expect(cache.title(pane)).toBe('First'); await cache.idle()
    expect(cache.title(pane)).toBe('Second'); expect(read).toHaveBeenCalledTimes(2)
    expect(cache.title({ title: ' Page title ' } as WebPane)).toBe('Page title')
  })
  it('skips oversized manifests, bounds the cache and does not run reads evicted before starting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-titles-bound-')); dirs.push(dir)
    const path = join(dir, 'huge.json'); writeFileSync(path, ' '.repeat(2 * 1024 * 1024 + 1))
    const read = vi.fn(async () => '{"title":"Small"}')
    const cache = new BoardTileTitles({ artifacts: { resolve: (_id, file) => join(dir, file) }, read, changed: () => {} })
    cache.title({ ...pane, content: { kind: 'canvas', artifactId: 'a'.repeat(16), manifest: 'huge.json' } })
    await cache.idle(); expect(read).not.toHaveBeenCalled()
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(dir, `${i}.json`), '{}')
      cache.title({ ...pane, content: { kind: 'canvas', artifactId: 'a'.repeat(16), manifest: `${i}.json` } })
    }
    await cache.idle(); expect(read).toHaveBeenCalledTimes(256)
  })
})

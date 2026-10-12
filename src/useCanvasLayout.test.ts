// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCanvasManifest } from '../shared/canvas-manifest'
import { useCanvasLayout } from './useCanvasLayout'

const initial = parseCanvasManifest({ title: 'Board', frames: [{ id: 'a', title: 'A', src: 'a.html', x: 0, y: 0 }] })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('canvas layout writes', () => {
  it('coalesces watcher refreshes during a write and reloads the latest disk state afterwards', async () => {
    let finish!: (response: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { finish = resolve })))
    const reload = vi.fn(async () => {}), setResult = vi.fn()
    const { result } = renderHook(() => useCanvasLayout('first', 'canvas.json', '', setResult))
    let writing!: Promise<unknown>
    act(() => { result.current.reload.current = reload; writing = result.current.move({ id: 'a', x: 10, y: 20 }); result.current.reloadAfterWrite.current = true })
    expect(result.current.writing.current).toBe(true)
    await act(async () => { finish({ ok: true, json: async () => ({ ...initial, contentHash: 'b'.repeat(64) }) }); await writing })
    expect(reload).toHaveBeenCalledOnce(); expect(setResult).toHaveBeenCalledOnce()
    expect(result.current.writing.current).toBe(false); expect(result.current.reloadAfterWrite.current).toBe(false)
  })
  it('locks concurrent writes and ignores responses after changing artifacts', async () => {
    let finish!: (response: unknown) => void
    const fetcher = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const setResult = vi.fn()
    const { result, rerender } = renderHook(({ artifactId }) => useCanvasLayout(artifactId, 'canvas.json', 'owner', setResult), { initialProps: { artifactId: 'first' } })
    let sending!: Promise<unknown>
    act(() => { result.current.contentHash.current = 'a'.repeat(64); sending = result.current.move({ id: 'a', x: 10, y: 20 }) })
    await act(async () => { await result.current.move({ id: 'a', x: 30, y: 40 }) })
    expect(fetcher).toHaveBeenCalledTimes(1); expect(result.current.busy).toBe(true)
    rerender({ artifactId: 'second' })
    await act(async () => { finish({ ok: true, json: async () => ({ ...initial, contentHash: 'b'.repeat(64) }) }); await sending })
    expect(setResult).not.toHaveBeenCalled(); expect(result.current.contentHash.current).toBe(''); expect(result.current.busy).toBe(false)
  })
  it('clears previews and reloads conflicts without running status feedback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'stale manifest' }) })))
    const setResult = vi.fn(), after = vi.fn(), reload = vi.fn(async () => {})
    const { result } = renderHook(() => useCanvasLayout('first', 'canvas.json', '', setResult))
    act(() => { result.current.reload.current = reload; result.current.preview({ id: 'a', x: 20, y: 30 }) })
    expect(result.current.overlay.current).toEqual({ id: 'a', x: 20, y: 30 })
    await act(async () => { await result.current.status({ id: 's', title: 'Section', status: 'idea', frames: ['a'] }, 'shipped', after) })
    expect(result.current.error).toBe('stale manifest'); expect(reload).toHaveBeenCalledOnce(); expect(after).not.toHaveBeenCalled()
    expect(result.current.overlay.current).toBeNull(); expect(result.current.busy).toBe(false)
  })
})

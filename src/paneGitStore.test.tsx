// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GitDiffApiClient } from './gitApi'
import { usePaneGitSummary } from './paneGitStore'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('keeps the last good summary on errors and disconnects, but accepts successful empty results', async () => {
  vi.useFakeTimers()
  const summary = { isRepo: true, target: 'main', files: [{ path: 'a.ts' }] }
  const api = { summary: vi.fn().mockResolvedValue(summary) } as unknown as GitDiffApiClient
  const view = renderHook(({ connected, path }) => usePaneGitSummary('%12', path, api, connected), { initialProps: { connected: true, path: '/repo' } })
  await act(async () => { await Promise.resolve() })
  expect(view.result.current).toBe(summary)
  vi.mocked(api.summary).mockRejectedValue(new Error('Offline'))
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  expect(view.result.current).toBe(summary)
  view.rerender({ connected: false, path: '/repo' })
  expect(view.result.current).toBe(summary)
  vi.mocked(api.summary).mockResolvedValue({ isRepo: true, target: 'main', files: [] })
  view.rerender({ connected: true, path: '/repo' })
  await act(async () => { await Promise.resolve() })
  expect(view.result.current?.files).toEqual([])
  view.rerender({ connected: false, path: '/other' })
  expect(view.result.current).toBeNull()
})

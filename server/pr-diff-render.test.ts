import { describe, expect, it, vi } from 'vitest'
import { GitCommandFailure, renderDeltaPatch } from './git-diff.js'
import { MAX_PR_PATCH_BYTES, renderPrDiff } from './pr-diff-render.js'

describe('shared Delta patch renderer', () => {
  it('forces truecolor, disables paging, and preserves stdin + display mode', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: '\x1b[31mhighlighted', stderr: '' })
    expect(await renderDeltaPatch('patch', 140, 'side-by-side', execute, '/repo')).toContain('highlighted')
    expect(execute).toHaveBeenCalledWith('delta', ['--paging', 'never', '--dark', '--true-color', 'always', '--width', '140', '--side-by-side'], expect.objectContaining({ cwd: '/repo', shell: false, input: 'patch', allowExitCodes: [1] }))
  })

  it('does not launch Delta for an empty patch', async () => {
    const execute = vi.fn()
    expect(await renderDeltaPatch('', 120, 'inline', execute)).toBe('')
    expect(execute).not.toHaveBeenCalled()
  })
})

vi.mock('./git-diff.js', async (original) => {
  const actual = await original<typeof import('./git-diff.js')>()
  return { ...actual, renderDeltaPatch: vi.fn(actual.renderDeltaPatch) }
})

describe('remote PR Delta rendering', () => {
  it('adds filename metadata for syntax detection, including paths with spaces', async () => {
    vi.mocked(renderDeltaPatch).mockResolvedValueOnce('ansi')
    expect(await renderPrDiff('src/my app.ts', '@@ -1 +1 @@\n-old\n+new', 120)).toBe('ansi')
    expect(renderDeltaPatch).toHaveBeenLastCalledWith('diff --git "a/src/my app.ts" "b/src/my app.ts"\n--- "a/src/my app.ts"\n+++ "b/src/my app.ts"\n@@ -1 +1 @@\n-old\n+new\n', 120)
  })

  it('rejects invalid or unbounded input before launching a process', async () => {
    for (const [path, patch, width] of [['evil\n.ts', '+ok', 120], ['ok.ts', '+ok', 501], ['ok.ts', '+ok', 1.5], ['ok.ts', 'x'.repeat(MAX_PR_PATCH_BYTES + 1), 120]]) {
      await expect(renderPrDiff(path, patch, width)).rejects.toMatchObject({ status: 400 })
    }
  })

  it('reports a missing Delta binary with an actionable installation message', async () => {
    vi.mocked(renderDeltaPatch).mockRejectedValueOnce(new GitCommandFailure('delta failed', '', true))
    await expect(renderPrDiff('app.ts', '+ok', 120)).rejects.toMatchObject({ status: 503, code: 'tool_missing', message: expect.stringContaining('brew install git-delta') })
  })
})

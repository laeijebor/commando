// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useGitBlame } from './gitBlame'
import type { GitBlame, GitDiffApiClient, GitFileContents } from './gitApi'

const fileA: GitFileContents = { file: 'a.ts', old: null, new: { path: 'a.ts', contents: 'a\n', rev: 'worktree' } }
const fileB: GitFileContents = { file: 'b.ts', old: null, new: { path: 'b.ts', contents: 'b\n', rev: 'worktree' } }

function blameFor(file: string): GitBlame {
  return { file, rev: 'worktree', commits: {}, lines: ['0'.repeat(40)] }
}

describe('useGitBlame', () => {
  it('drops a worktree answer that lands after its file left the screen, so returning refetches', async () => {
    const pending: Array<(value: GitBlame) => void> = []
    const blame = vi.fn((_paneId: string, file: string) => (
      file === 'a.ts' ? new Promise<GitBlame>((resolve) => { pending.push(resolve) }) : Promise.resolve(blameFor(file))
    ))
    const api = { blame } as unknown as GitDiffApiClient
    const { result, rerender } = renderHook(({ contents }) => useGitBlame(api, '%1', contents, true), {
      initialProps: { contents: fileA },
    })
    expect(blame).toHaveBeenCalledTimes(1)

    rerender({ contents: fileB })
    await waitFor(() => expect(result.current.new?.file).toBe('b.ts'))
    await act(async () => { pending[0](blameFor('a.ts')) })

    rerender({ contents: fileA })
    expect(result.current.loading).toBe(true)
    expect(blame).toHaveBeenCalledTimes(3)
    await act(async () => { pending[1](blameFor('a.ts')) })
    expect(result.current.new?.file).toBe('a.ts')
  })
})

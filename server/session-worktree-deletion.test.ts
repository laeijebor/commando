import { describe, expect, it, vi } from 'vitest'
import type { GitWorktreeIdentity } from './git-worktree.js'
import { prepareSessionWorktreeDeletion } from './session-worktree-deletion.js'

const WORKTREE: GitWorktreeIdentity = {
  root: '/Users/dev/commando-worktrees/cleanup',
  mainRoot: '/Users/dev/commando',
  branch: 'cleanup',
  head: 'abc123',
}

function resolver(directory: string): Promise<GitWorktreeIdentity | undefined> {
  return Promise.resolve(directory.startsWith(WORKTREE.root) ? WORKTREE : undefined)
}

describe('prepareSessionWorktreeDeletion', () => {
  it('removes the single worktree linked to the target session', async () => {
    const removeWorktree = vi.fn().mockResolvedValue(undefined)
    const currentPanes = vi.fn().mockResolvedValue([
      { sessionId: '$1', path: `${WORKTREE.root}/apps/web` },
      { sessionId: '$1', path: WORKTREE.root },
      { sessionId: '$2', path: '/Users/dev/other' },
    ])

    const remove = await prepareSessionWorktreeDeletion('$1', {
      currentPanes,
      worktreeForDirectory: resolver,
      removeWorktree,
    })
    await remove()

    expect(currentPanes).toHaveBeenCalledTimes(2)
    expect(removeWorktree).toHaveBeenCalledWith(WORKTREE)
  })

  it('refuses to close the target session when another session already uses its worktree', async () => {
    const removeWorktree = vi.fn()

    await expect(prepareSessionWorktreeDeletion('$1', {
      currentPanes: async () => [
        { sessionId: '$1', path: WORKTREE.root },
        { sessionId: '$2', path: `${WORKTREE.root}/packages/shared` },
      ],
      worktreeForDirectory: resolver,
      removeWorktree,
    })).rejects.toThrow(/Another tmux session is using this worktree/i)
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('treats a pane in a nested repository as a user of the parent worktree', async () => {
    const removeWorktree = vi.fn()
    const worktreeForDirectory = vi.fn(async (directory: string) => (
      directory === WORKTREE.root ? WORKTREE : undefined
    ))

    await expect(prepareSessionWorktreeDeletion('$1', {
      currentPanes: async () => [
        { sessionId: '$1', path: WORKTREE.root },
        { sessionId: '$2', path: `${WORKTREE.root}/vendor/independent-repo` },
      ],
      worktreeForDirectory,
      removeWorktree,
    })).rejects.toThrow(/Another tmux session is using this worktree/i)
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('rechecks other sessions after the target session closes', async () => {
    const removeWorktree = vi.fn()
    const currentPanes = vi.fn()
      .mockResolvedValueOnce([{ sessionId: '$1', path: WORKTREE.root }])
      .mockResolvedValueOnce([{ sessionId: '$2', path: WORKTREE.root }])
    const remove = await prepareSessionWorktreeDeletion('$1', {
      currentPanes,
      worktreeForDirectory: resolver,
      removeWorktree,
    })

    await expect(remove()).rejects.toThrow(/Another tmux session is using this worktree/i)
    expect(removeWorktree).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { GitWorktreeIdentity } from './git-worktree.js'
import { prepareSessionWorktreeDeletion } from './session-worktree-deletion.js'
import { isAuxiliarySession } from '../shared/auxiliary-session.js'

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
      currentSessions: () => [{ id: '$1', name: 'cleanup' }, { id: '$2', name: 'elsewhere' }],
      worktreeForDirectory: resolver,
      removeWorktree,
    })
    expect(remove.auxiliarySessions).toEqual([])
    await remove.remove()

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
      currentSessions: () => [{ id: '$1', name: 'cleanup' }, { id: '$2', name: 'another-task' }],
      worktreeForDirectory: resolver,
      removeWorktree,
    })).rejects.toThrow(/Another tmux session.*is using this worktree/i)
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
      currentSessions: () => [{ id: '$1', name: 'cleanup' }, { id: '$2', name: 'another-task' }],
      worktreeForDirectory,
      removeWorktree,
    })).rejects.toThrow(/Another tmux session.*is using this worktree/i)
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('rechecks other sessions after the target session closes', async () => {
    const removeWorktree = vi.fn()
    const currentPanes = vi.fn()
      .mockResolvedValueOnce([{ sessionId: '$1', path: WORKTREE.root }])
      .mockResolvedValueOnce([{ sessionId: '$2', path: WORKTREE.root }])
    const remove = await prepareSessionWorktreeDeletion('$1', {
      currentPanes,
      currentSessions: () => [{ id: '$1', name: 'cleanup' }, { id: '$2', name: 'another-task' }],
      worktreeForDirectory: resolver,
      removeWorktree,
    })

    await expect(remove.remove()).rejects.toThrow(/Another tmux session/i)
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('recognizes only named helpers tied to the exact worktree, not arbitrary prefix matches', () => {
    expect(isAuxiliarySession('native_app-cleanup', WORKTREE.root)).toBe(true)
    expect(isAuxiliarySession('tilt-cleanup', WORKTREE.root)).toBe(true)
    expect(isAuxiliarySession('native_app-other', WORKTREE.root)).toBe(false)
    expect(isAuxiliarySession('my-tilt-cleanup', WORKTREE.root)).toBe(false)
  })

  it('plans to close named background sessions in this worktree before removal', async () => {
    const removeWorktree = vi.fn().mockResolvedValue(undefined)
    const currentPanes = vi.fn()
      .mockResolvedValueOnce([
        { sessionId: '$1', path: WORKTREE.root },
        { sessionId: '$2', path: `${WORKTREE.root}/app` },
        { sessionId: '$3', path: WORKTREE.root },
      ])
      .mockResolvedValueOnce([])
    const plan = await prepareSessionWorktreeDeletion('$1', {
      currentPanes,
      currentSessions: () => [
        { id: '$1', name: 'cleanup' },
        { id: '$2', name: 'native_app-cleanup' },
        { id: '$3', name: 'tilt-cleanup' },
      ],
      worktreeForDirectory: resolver,
      removeWorktree,
    })
    expect(plan.auxiliarySessions).toEqual([
      { id: '$2', name: 'native_app-cleanup' },
      { id: '$3', name: 'tilt-cleanup' },
    ])
    await plan.remove()
    expect(removeWorktree).toHaveBeenCalledWith(WORKTREE)
  })

  it('refuses a prefixed helper if any of its panes are outside the worktree', async () => {
    const removeWorktree = vi.fn()
    await expect(prepareSessionWorktreeDeletion('$1', {
      currentPanes: async () => [
        { sessionId: '$1', path: WORKTREE.root },
        { sessionId: '$2', path: WORKTREE.root },
        { sessionId: '$2', path: '/Users/dev/elsewhere' },
      ],
      currentSessions: () => [{ id: '$1', name: 'cleanup' }, { id: '$2', name: 'native_app-cleanup' }],
      worktreeForDirectory: resolver,
      removeWorktree,
    })).rejects.toThrow(/Another tmux session/i)
    expect(removeWorktree).not.toHaveBeenCalled()
  })
})

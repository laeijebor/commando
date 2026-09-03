import path from 'node:path'
import type { GitWorktreeIdentity } from './git-worktree.js'

type SessionPaneLocation = {
  sessionId: string
  path: string
}

export type SessionWorktreeDeletionDependencies = {
  currentPanes: () => Promise<readonly SessionPaneLocation[]>
  worktreeForDirectory: (directory: string) => Promise<GitWorktreeIdentity | undefined>
  removeWorktree: (worktree: GitWorktreeIdentity) => Promise<void>
}

export class SessionWorktreeConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionWorktreeConflictError'
  }
}

export async function prepareSessionWorktreeDeletion(
  sessionId: string,
  dependencies: SessionWorktreeDeletionDependencies,
): Promise<() => Promise<void>> {
  const worktreesForPanes = async (panes: readonly SessionPaneLocation[]) => {
    const directories = [...new Set(panes.map((pane) => pane.path))]
    const worktrees = await Promise.all(directories.map(dependencies.worktreeForDirectory))
    return new Map(worktrees.filter((worktree) => worktree !== undefined).map((worktree) => [worktree.root, worktree]))
  }
  const assertNotShared = async (worktreePath: string, panes: readonly SessionPaneLocation[]) => {
    const otherPanes = panes.filter((pane) => pane.sessionId !== sessionId)
    const pathIsInsideWorktree = otherPanes.some((pane) => {
      const relative = path.relative(worktreePath, pane.path)
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    })
    if (pathIsInsideWorktree) {
      throw new SessionWorktreeConflictError('Another tmux session is using this worktree; close it before deleting the worktree')
    }
    const otherWorktrees = await worktreesForPanes(otherPanes)
    if (otherWorktrees.has(worktreePath)) {
      throw new SessionWorktreeConflictError('Another tmux session is using this worktree; close it before deleting the worktree')
    }
  }

  const currentPanes = await dependencies.currentPanes()
  const worktrees = await worktreesForPanes(currentPanes.filter((pane) => pane.sessionId === sessionId))
  if (worktrees.size === 0) throw new SessionWorktreeConflictError('Tmux session is not tied to a git worktree')
  if (worktrees.size > 1) throw new SessionWorktreeConflictError('Tmux session spans multiple git worktrees; remove them manually')
  const [worktree] = worktrees.values()
  await assertNotShared(worktree.root, currentPanes)

  return async () => {
    await assertNotShared(worktree.root, await dependencies.currentPanes())
    await dependencies.removeWorktree(worktree)
  }
}

import path from 'node:path'
import type { GitWorktreeIdentity } from './git-worktree.js'
import { isAuxiliarySession } from '../shared/auxiliary-session.js'

type SessionPaneLocation = {
  sessionId: string
  path: string
}

export type SessionWorktreeDeletionDependencies = {
  currentPanes: () => Promise<readonly SessionPaneLocation[]>
  currentSessions: () => readonly { id: string; name: string }[]
  worktreeForDirectory: (directory: string) => Promise<GitWorktreeIdentity | undefined>
  removeWorktree: (worktree: GitWorktreeIdentity) => Promise<void>
}

export type SessionWorktreeDeletionPlan = {
  worktree: GitWorktreeIdentity
  auxiliarySessions: { id: string; name: string }[]
  /** Removes the worktree; pass its identity again if a commit has moved its head since planning. */
  remove: (current?: GitWorktreeIdentity) => Promise<void>
}

export class SessionWorktreeConflictError extends Error {
  /** `no-worktree`: the session simply isn't in a linked worktree, which is not a problem to report. */
  constructor(message: string, readonly reason: 'no-worktree' | 'conflict' = 'conflict') {
    super(message)
    this.name = 'SessionWorktreeConflictError'
  }
}

export async function prepareSessionWorktreeDeletion(
  sessionId: string,
  dependencies: SessionWorktreeDeletionDependencies,
): Promise<SessionWorktreeDeletionPlan> {
  return prepareWorktreeDeletion(sessionId, async (panes) => panes.filter((pane) => pane.sessionId === sessionId).map((pane) => pane.path), dependencies)
}

/** Plans removing the one worktree a paused session's saved pane directories sit in; no live session owns it. */
export async function prepareDirectoriesWorktreeDeletion(
  directories: readonly string[],
  dependencies: SessionWorktreeDeletionDependencies,
): Promise<SessionWorktreeDeletionPlan> {
  return prepareWorktreeDeletion(undefined, async () => [...directories], dependencies)
}

async function prepareWorktreeDeletion(
  sessionId: string | undefined,
  ownDirectories: (panes: readonly SessionPaneLocation[]) => Promise<string[]>,
  dependencies: SessionWorktreeDeletionDependencies,
): Promise<SessionWorktreeDeletionPlan> {
  const worktreesForDirectories = async (paths: readonly string[]) => {
    const directories = [...new Set(paths)]
    const worktrees = await Promise.all(directories.map(dependencies.worktreeForDirectory))
    return new Map(worktrees.filter((worktree) => worktree !== undefined).map((worktree) => [worktree.root, worktree]))
  }
  const classifyOtherSessions = async (worktreePath: string, panes: readonly SessionPaneLocation[]) => {
    const otherPanes = panes.filter((pane) => pane.sessionId !== sessionId)
    const insideWorktree = (pane: SessionPaneLocation) => {
      const relative = path.relative(worktreePath, pane.path)
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    }
    const resolved = await Promise.all(otherPanes.map((pane) => dependencies.worktreeForDirectory(pane.path)))
    const users = [...new Set(otherPanes.filter((pane, index) => insideWorktree(pane) ||
      resolved[index]?.root === worktreePath).map((pane) => pane.sessionId))]
    const sessions = dependencies.currentSessions()
    const auxiliarySessions: { id: string; name: string }[] = []
    for (const id of users) {
      const name = sessions.find((session) => session.id === id)?.name
      const panesForSession = otherPanes.filter((pane) => pane.sessionId === id)
      if (!name || !isAuxiliarySession(name, worktreePath) || panesForSession.some((pane) =>
        !insideWorktree(pane) || resolved[otherPanes.indexOf(pane)]?.root !== worktreePath)) {
        throw new SessionWorktreeConflictError(`Another tmux session${name ? ` (“${name}”)` : ''} is using this worktree; close it before deleting the worktree`)
      }
      auxiliarySessions.push({ id, name })
    }
    return auxiliarySessions
  }

  const currentPanes = await dependencies.currentPanes()
  const worktrees = await worktreesForDirectories(await ownDirectories(currentPanes))
  if (worktrees.size === 0) throw new SessionWorktreeConflictError('Tmux session is not tied to a git worktree', 'no-worktree')
  if (worktrees.size > 1) throw new SessionWorktreeConflictError('Tmux session spans multiple git worktrees; remove them manually')
  const [worktree] = worktrees.values()
  const auxiliarySessions = await classifyOtherSessions(worktree.root, currentPanes)

  return {
    worktree,
    auxiliarySessions,
    remove: async (current = worktree) => {
      const remaining = await classifyOtherSessions(worktree.root, await dependencies.currentPanes())
      if (remaining.length) throw new SessionWorktreeConflictError('Another tmux session is still using this worktree; close it before deleting the worktree')
      await dependencies.removeWorktree(current)
    },
  }
}

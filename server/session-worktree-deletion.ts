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
  auxiliarySessions: { id: string; name: string }[]
  remove: () => Promise<void>
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
): Promise<SessionWorktreeDeletionPlan> {
  const worktreesForPanes = async (panes: readonly SessionPaneLocation[]) => {
    const directories = [...new Set(panes.map((pane) => pane.path))]
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
  const worktrees = await worktreesForPanes(currentPanes.filter((pane) => pane.sessionId === sessionId))
  if (worktrees.size === 0) throw new SessionWorktreeConflictError('Tmux session is not tied to a git worktree')
  if (worktrees.size > 1) throw new SessionWorktreeConflictError('Tmux session spans multiple git worktrees; remove them manually')
  const [worktree] = worktrees.values()
  const auxiliarySessions = await classifyOtherSessions(worktree.root, currentPanes)

  return {
    auxiliarySessions,
    remove: async () => {
      const remaining = await classifyOtherSessions(worktree.root, await dependencies.currentPanes())
      if (remaining.length) throw new SessionWorktreeConflictError('Another tmux session is still using this worktree; close it before deleting the worktree')
      await dependencies.removeWorktree(worktree)
    },
  }
}

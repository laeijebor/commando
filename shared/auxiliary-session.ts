import type { TmuxPane, TmuxSession } from './protocol.js'

/** Generated tmux sessions whose name identifies the worktree they support. */
export function isAuxiliarySession(name: string, worktreeRoot: string): boolean {
  const match = /^(?:native_app|tilt)-(.+)$/u.exec(name)
  return Boolean(match && worktreeRoot.replace(/\/+$/u, '').split('/').at(-1) === match[1])
}

/**
 * Generated helper sessions living wholly inside another session's worktree.
 * They share its lifecycle, so they are never archived or deleted with their own worktree.
 */
export function auxiliarySessionIds(sessions: readonly TmuxSession[], panes: readonly TmuxPane[], commanderSessionId?: string): Set<string> {
  return new Set(sessions.filter((session) => {
    if (session.id === commanderSessionId) return false
    const root = panes.find((pane) => pane.sessionId === session.id && pane.repo?.worktreeRoot)?.repo?.worktreeRoot
    return Boolean(root && isAuxiliarySession(session.name, root) &&
      panes.filter((pane) => pane.sessionId === session.id).every((pane) =>
        pane.repo?.worktreeRoot === root && (pane.path === root || pane.path.startsWith(`${root}/`))))
  }).map((session) => session.id))
}

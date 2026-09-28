/** Generated tmux sessions whose name identifies the worktree they support. */
export function isAuxiliarySession(name: string, worktreeRoot: string): boolean {
  const match = /^(?:native_app|tilt)-(.+)$/u.exec(name)
  return Boolean(match && worktreeRoot.replace(/\/+$/u, '').split('/').at(-1) === match[1])
}

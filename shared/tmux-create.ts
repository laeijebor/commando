export const TMUX_CREATE_ROUTES = {
  session: '/api/tmux/sessions',
  window: '/api/tmux/windows',
  pane: '/api/tmux/panes',
} as const

export type TmuxSplitDirection = 'horizontal' | 'vertical'
export type TmuxSplitPlacement = 'before' | 'after'

/** Ask the daemon to branch and add a git worktree before starting the session in it. */
export type CreateTmuxSessionWorktree = {
  /** Branch to create (or reuse when it exists and is not checked out elsewhere). */
  branch: string
  /** Absolute worktree path; defaults to `defaultWorktreePath(mainRoot, branch)` when omitted. */
  path?: string
  /** Multiline shell command to run in the new worktree before opening its interactive shell. */
  prepareCommand?: string
}

export type CreateTmuxSessionRequest = {
  name: string
  windowName?: string
  cwd?: string
  worktree?: CreateTmuxSessionWorktree
}

export type CreateTmuxWindowRequest = {
  sessionId: string
  name?: string
  cwd?: string
}

export type CreateTmuxPaneRequest = {
  targetId: string
  direction: TmuxSplitDirection
  placement?: TmuxSplitPlacement
  cwd?: string
}

export type TmuxCreatedTarget = {
  kind: 'session' | 'window' | 'pane'
  sessionId: string
  sessionName: string
  windowId: string
  windowIndex: number
  windowName: string
  paneId: string
  paneIndex: number
  panePath: string
}

export type TmuxCreatedWorktree = {
  path: string
  branch: string
  /** Ref the branch was created from, e.g. `origin/main`; empty when an existing branch was reused. */
  base: string
  reusedBranch: boolean
  /** Set when the pre-branch fetch failed and the local remote-tracking ref was used instead. */
  warning?: string
}

export type TmuxCreateResponse = {
  created: TmuxCreatedTarget
  worktree?: TmuxCreatedWorktree
}

/** What the daemon knows about the repository containing a directory. */
export type GitRepoInfo = {
  isRepo: boolean
  /** Root of the main checkout; worktrees resolve to the checkout they belong to. */
  mainRoot?: string
  /** Root of the checkout containing the probed path (the worktree itself when inside one). */
  root?: string
  /** Folder name of the main checkout. */
  name?: string
  branch?: string
  isWorktree?: boolean
  /** Default branch on the remote, e.g. `main`; undefined without a remote. */
  defaultBranch?: string
  remote?: string
}

export const MAX_BRANCH_NAME_LENGTH = 64

/**
 * Turns a free-form session name into a git-safe branch name: lowercase, word
 * separators become dashes, anything outside [a-z0-9._-] is dropped, runs of
 * dashes collapse, and leading/trailing dashes and dots are trimmed.
 */
export function sanitizeBranchName(name: string): string {
  let value = name
    .toLowerCase()
    .replace(/[\s/&+_]+/gu, '-')
    .replace(/[^a-z0-9.-]/gu, '')
    .replace(/\.{2,}/gu, '.')
    .replace(/-{2,}/gu, '-')
    .replace(/(?:-\.|\.-)+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
  if (value.endsWith('.lock')) value = value.slice(0, -'.lock'.length)
  if (value.length > MAX_BRANCH_NAME_LENGTH) {
    value = value.slice(0, MAX_BRANCH_NAME_LENGTH).replace(/[-.]+$/u, '')
  }
  return value
}

/** `<parent of main checkout>/<repo>-worktrees/<branch>` */
export function defaultWorktreePath(mainRoot: string, branch: string): string {
  const root = mainRoot.replace(/\/+$/u, '')
  return `${root}-worktrees/${branch}`
}

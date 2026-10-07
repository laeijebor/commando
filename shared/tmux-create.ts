export const TMUX_CREATE_ROUTES = {
  session: '/api/tmux/sessions',
  window: '/api/tmux/windows',
  pane: '/api/tmux/panes',
} as const

export type TmuxSplitDirection = 'horizontal' | 'vertical'
export type TmuxSplitPlacement = 'before' | 'after'

/** Interactive CLIs supported by creation; provider names are not executable names. */
export type SessionAgentProvider = 'claude' | 'codex' | 'opencode' | 'cursor'
export type SessionAgentLaunch = { provider: SessionAgentProvider; prompt?: string }

export const SESSION_AGENT_CHOICES = [
  { value: 'shell', label: 'Shell' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'cursor', label: 'Cursor' },
] as const

export const SESSION_AGENT_EXECUTABLES: Record<SessionAgentProvider, string> = {
  claude: 'claude', codex: 'codex', opencode: 'opencode', cursor: 'agent',
}

/** Keep prompt data out of the shell and CLI option/subcommand parsers. */
export function sessionAgentArgv(launch: SessionAgentLaunch): string[] {
  const executable = SESSION_AGENT_EXECUTABLES[launch.provider]
  if (launch.provider === 'opencode' || !launch.prompt?.trim()) return [executable]
  // Claude's Commander parser dispatches exact command names even after `--`.
  // An inert leading space keeps arbitrary prompts in the interactive action.
  if (launch.provider === 'claude') return [executable, '--', ` ${launch.prompt}`]
  return launch.provider === 'cursor'
    ? [executable, 'agent', '--', launch.prompt]
    : [executable, '--', launch.prompt]
}

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
  /** Started interactively inside the new pane, after successful preparation. */
  agent?: SessionAgentLaunch
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
  /** Creation acknowledges the owned target, not CLI authentication or task completion. */
  created: TmuxCreatedTarget
  worktree?: TmuxCreatedWorktree
  agentLaunch?: SessionAgentLaunchAcknowledgment
}

/** The owned pane has been created with the PTY launch command installed.
 * Preparation can still be running; this does not acknowledge CLI auth or a task result.
 */
export type SessionAgentLaunchAcknowledgment = {
  version: 1
  provider: SessionAgentProvider
  paneId: string
  mode: 'interactive-pty'
  state: 'initiated'
}

export class TmuxAgentLaunchCompatibilityError extends Error {
  constructor(readonly response: TmuxCreateResponse, provider: SessionAgentProvider) {
    const label = SESSION_AGENT_CHOICES.find((choice) => choice.value === provider)?.label ?? provider
    super(`Session ${response.created.sessionName} (${response.created.paneId}) was created, but the daemon did not confirm the requested ${label} interactive launch. Update Commando on the daemon host. Open the existing session to inspect it or start the agent manually; do not create it again.`)
    this.name = 'TmuxAgentLaunchCompatibilityError'
  }
}

export function isSessionAgentLaunchAcknowledgment(value: unknown): value is SessionAgentLaunchAcknowledgment {
  if (!value || typeof value !== 'object') return false
  const ack = value as Partial<SessionAgentLaunchAcknowledgment>
  return ack.version === 1 && ack.mode === 'interactive-pty' && ack.state === 'initiated'
    && typeof ack.provider === 'string' && Object.hasOwn(SESSION_AGENT_EXECUTABLES, ack.provider)
    && typeof ack.paneId === 'string'
}

/** Older daemons can create a shell while silently ignoring `agent`. Preserve that target on error. */
export function requireSessionAgentLaunch(input: CreateTmuxSessionRequest, response: TmuxCreateResponse): TmuxCreateResponse {
  if (input.agent && (!isSessionAgentLaunchAcknowledgment(response.agentLaunch)
    || response.agentLaunch.provider !== input.agent.provider
    || response.agentLaunch.paneId !== response.created.paneId)) {
    throw new TmuxAgentLaunchCompatibilityError(response, input.agent.provider)
  }
  return response
}

/** Shared runtime decoding keeps both clients' partial-error targets and acknowledgments intact. */
export function parseTmuxCreateResponse(value: unknown): TmuxCreateResponse {
  if (!value || typeof value !== 'object') throw new Error('tmux create response did not match the protocol')
  const body = value as Partial<TmuxCreateResponse>
  const target = body.created
  if (!target || typeof target !== 'object'
    || !['session', 'window', 'pane'].includes(target.kind)
    || typeof target.sessionId !== 'string' || typeof target.sessionName !== 'string'
    || typeof target.windowId !== 'string' || !Number.isSafeInteger(target.windowIndex)
    || typeof target.windowName !== 'string' || typeof target.paneId !== 'string'
    || !Number.isSafeInteger(target.paneIndex) || typeof target.panePath !== 'string') {
    throw new Error('tmux create response did not match the protocol')
  }
  const worktree = body.worktree
  return {
    created: target,
    ...(worktree && typeof worktree.path === 'string' && typeof worktree.branch === 'string' && typeof worktree.base === 'string' ? { worktree } : {}),
    ...(isSessionAgentLaunchAcknowledgment(body.agentLaunch) ? { agentLaunch: body.agentLaunch } : {}),
  }
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

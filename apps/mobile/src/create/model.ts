import type { CommandoSnapshot } from '@commando/protocol'
import type { CreateTmuxSessionRequest, GitRepoInfo, SessionAgentProvider, ChatPermissionMode } from '@commando/tmux-create'
import { defaultWorktreePath, sanitizeBranchName, SESSION_AGENT_CHOICES, isChatLaunchProvider, chatPermissionModes } from '@commando/tmux-create'

/**
 * Everything screen 07 computes, kept away from the view so the branch name,
 * the worktree path and the command that launches the agent can be tested
 * without a renderer. The branch and path rules come from the daemon's own
 * `shared/tmux-create.ts`, never a copy.
 */

export type AgentChoice = SessionAgentProvider | 'shell'
export const DEFAULT_AGENT_CHOICE: AgentChoice = 'claude-chat'

export const AGENT_CHOICES: readonly { value: AgentChoice; label: string }[] = SESSION_AGENT_CHOICES

export type RepoOption = {
  /** Main checkout root; also the key the preparation command is stored under. */
  root: string
  name: string
  branch?: string
  defaultBranch?: string
  /** True when the entry only came from the directory history, not from a live pane. */
  fromHistory?: boolean
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const separator = trimmed.lastIndexOf('/')
  return separator === -1 ? trimmed : trimmed.slice(separator + 1)
}

/**
 * Repositories the phone can offer without asking the daemon: the distinct
 * repos its panes are sitting in, then any remembered directory that is not
 * already one of them.
 */
export function repoOptions(
  snapshot: CommandoSnapshot | null,
  directoryHistory: readonly string[] = [],
): RepoOption[] {
  const seen = new Set<string>()
  const options: RepoOption[] = []
  for (const pane of snapshot?.panes ?? []) {
    const repo = pane.repo
    if (!repo || seen.has(repo.root)) continue
    seen.add(repo.root)
    options.push({
      root: repo.root,
      name: repo.name,
      ...(repo.branch ? { branch: repo.branch } : {}),
      ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
    })
  }
  options.sort((left, right) => left.name.localeCompare(right.name))
  for (const directory of directoryHistory) {
    if (seen.has(directory)) continue
    seen.add(directory)
    options.push({ root: directory, name: basename(directory), fromHistory: true })
  }
  return options
}

/** The branch the form suggests for a session name, or the one the user typed. */
export function effectiveBranch(sessionName: string, edited: string | null): string {
  return edited === null ? sanitizeBranchName(sessionName) : edited
}

/** The daemon's default worktree path for the branch, with a placeholder while the branch is empty. */
export function previewWorktreePath(repo: GitRepoInfo | null, branch: string): string {
  if (!repo?.mainRoot) return ''
  return defaultWorktreePath(repo.mainRoot, branch || '<branch>', repo.worktreesParent)
}

/** `origin/main`, or plain `HEAD` when the checkout has no remote. */
export function baseLabel(repo: GitRepoInfo | null): string {
  if (repo?.defaultBranch) {
    const remote = repo.remote ?? 'origin'
    return `${remote}/${repo.defaultBranch}`
  }
  return 'HEAD'
}

export type SessionFormState = {
  name: string
  directory: string
  worktreeEnabled: boolean
  branch: string
  worktreePath: string
  prepareCommand: string
  prepareEnabled: boolean
  agent?: AgentChoice
  prompt?: string
  permissionMode?: ChatPermissionMode
}

/**
 * The create request for `POST /api/tmux/sessions`. The worktree block is only
 * included when the directory really is a checkout and the toggle is on, and
 * the path is only sent when it differs from the daemon's own default.
 */
export function buildSessionRequest(
  form: SessionFormState,
  repo: GitRepoInfo | null,
): CreateTmuxSessionRequest {
  const request: CreateTmuxSessionRequest = { name: form.name.trim() }
  if (form.agent && form.agent !== 'shell') {
    request.agent = {
      provider: form.agent,
      ...(isChatLaunchProvider(form.agent) ? { permissionMode: form.permissionMode ?? 'default' } : {}),
      ...(form.agent !== 'opencode' && form.prompt?.trim() ? { prompt: form.prompt } : {}),
    }
  }
  if (form.agent && isChatLaunchProvider(form.agent) && !chatPermissionModes(form.agent).some((mode) => mode.value === (form.permissionMode ?? 'default'))) throw new Error('Choose a supported permission mode for this chat provider')
  const cwd = form.directory.trim()
  if (cwd) request.cwd = cwd
  const wantsWorktree = form.worktreeEnabled && Boolean(repo?.isRepo && repo.mainRoot)
  if (!wantsWorktree) return request
  const branch = form.branch.trim()
  const path = form.worktreePath.trim()
  const prepare = form.prepareEnabled ? form.prepareCommand.trim() : ''
  request.worktree = {
    branch,
    ...(path && path !== previewWorktreePath(repo, branch) ? { path } : {}),
    ...(prepare ? { prepareCommand: prepare } : {}),
  }
  return request
}

export { defaultWorktreePath, sanitizeBranchName }

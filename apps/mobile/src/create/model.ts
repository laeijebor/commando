import type { CommandoSnapshot } from '@commando/protocol'
import type { ChatImageRef } from '@commando/agent-chat'
import type { CreateTmuxSessionRequest, GitRepoInfo, SessionAgentProvider, ChatLaunchProvider, ChatPermissionMode } from '@commando/tmux-create'
import { chatLaunchPermission, defaultWorktreePath, modelProvider, sanitizeBranchName, SESSION_AGENT_CHOICES, isChatLaunchProvider, chatPermissionModes } from '@commando/tmux-create'

/**
 * Everything screen 07 computes, kept away from the view so the branch name,
 * the worktree path and the command that launches the agent can be tested
 * without a renderer. The branch and path rules come from the daemon's own
 * `shared/tmux-create.ts`, never a copy.
 */

export type AgentChoice = SessionAgentProvider | 'shell'
export const DEFAULT_AGENT_CHOICE: AgentChoice = 'claude-chat'

export const AGENT_CHOICES: readonly { value: AgentChoice; label: string }[] = SESSION_AGENT_CHOICES

/** Claude chats and Claude in a terminal both pick a login (profile). */
export function usesClaudeProfile(agent: AgentChoice): agent is 'claude-chat' | 'claude' {
  return agent === 'claude-chat' || agent === 'claude'
}

/** Only chats are sent images with the opening prompt. */
export function takesImages(agent: AgentChoice): agent is ChatLaunchProvider {
  return isChatLaunchProvider(agent)
}

/** A chat's permission mode before one is remembered: Cursor runs unattended, the rest ask. */
export function defaultPermission(provider: ChatLaunchProvider, remembered?: ChatPermissionMode): ChatPermissionMode {
  const modes = chatPermissionModes(provider)
  if (remembered && modes.some((mode) => mode.value === remembered)) return remembered
  const fallback: ChatPermissionMode = provider === 'cursor-chat' ? 'bypassPermissions' : 'default'
  return modes.some((mode) => mode.value === fallback) ? fallback : modes[0]?.value ?? 'default'
}

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
  /** The Claude profile Claude starts with; without one the daemon uses the default. */
  configDir?: string
  /** A picker value; `default` (or none) leaves the choice to the agent. */
  model?: string
  fast?: boolean
  images?: readonly ChatImageRef[]
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
  const agent = form.agent
  if (agent && agent !== 'shell') {
    const chat = isChatLaunchProvider(agent)
    const permissionMode = form.permissionMode ?? 'default'
    if (chat && !chatPermissionModes(agent).some((mode) => mode.value === permissionMode)) throw new Error('Choose a supported permission mode for this chat provider')
    request.agent = {
      provider: agent,
      ...(chat ? chatLaunchPermission(agent, permissionMode) : {}),
      ...(usesClaudeProfile(agent) && form.configDir ? { configDir: form.configDir } : {}),
      ...(agent !== 'opencode' && form.prompt?.trim() ? { prompt: form.prompt } : {}),
      ...(chat && form.images?.length ? { images: [...form.images] } : {}),
      ...(modelProvider(agent) && form.model && form.model !== 'default' ? { model: form.model } : {}),
      ...(chat && form.fast ? { fast: true as const } : {}),
    }
  }
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

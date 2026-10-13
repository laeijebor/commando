import type { ChatPermissionMode, SessionAgentProvider, TmuxCreatedWorktree } from './tmux-create.js'

export type AgentChatInput = {
  location: 'pane' | 'session'
  title: string
  prompt: string
  split: 'right' | 'down'
  branch?: string
  worktree?: boolean
  agent?: SessionAgentProvider
  permissionMode?: ChatPermissionMode
}

export type AgentChatLaunch = { provider: SessionAgentProvider; configDir?: string; permissionMode?: ChatPermissionMode }

export type AgentChatResult = {
  ok: true
  location: AgentChatInput['location']
  paneId: string
  targetId: string
  sessionId: string
  sessionName: string
  windowId: string
  cwd: string
  worktree?: TmuxCreatedWorktree
  agent: AgentChatLaunch
  warning?: string
}

export type AgentChatRequest = {
  id: string
  callerPaneId: string
  callerTargetId: string
  requestedBy: string
  reason: 'rate' | 'depth'
  summary: Pick<AgentChatInput, 'location' | 'title' | 'branch'> & AgentChatLaunch & { promptPreview: string }
  requestedAt: number
}

export type AgentChatDecision = 'pending' | 'accepted' | 'dismissed' | 'superseded' | 'expired'
export type AgentChatFailure = { ok: false; error: string; status: number; created?: AgentChatResult }
export type AgentChatOutcome = { decision: AgentChatDecision; requestId: string } &
  (AgentChatResult | AgentChatFailure | { ok: true })

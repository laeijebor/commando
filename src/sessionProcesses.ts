import type { TmuxPane } from '../shared/protocol'

export const ARCHIVE_RESTORE_NOTE = 'If it has a worktree, uncommitted changes are saved as a wip commit on its branch, then the worktree is removed with its ignored files (node_modules, .env and the like) and its background sessions stop. The branch is kept: Restore checks it out again and reopens its windows and chats.'
export const PAUSE_RESUME_NOTE = 'Its worktree is kept and it stays in the session tree; Resume reopens its windows and chats.'

export type SessionProcess = { paneId: string; label: string; kind: 'chat' | 'terminal' }

/** What a session is running: its live panes, as chats or terminals, leaving out empty launchers. */
export function sessionProcesses(panes: readonly TmuxPane[], sessionId: string, chatPaneIds: ReadonlySet<string>): SessionProcess[] {
  return panes.filter((pane) => pane.sessionId === sessionId && !pane.dead && !pane.empty).map((pane) => {
    const kind = chatPaneIds.has(pane.id) ? 'chat' : 'terminal'
    return { paneId: pane.id, kind, label: (kind === 'chat' ? pane.chatTitle : undefined) || pane.title || pane.command || `Pane ${pane.index}` }
  })
}

/** Lists everything closing a session would stop, once it runs more than one process. */
export function sessionProcessesWarning(sessionName: string, processes: readonly SessionProcess[]): string | undefined {
  if (processes.length < 2) return undefined
  return `“${sessionName}” has ${processes.length} active processes, and all of them will stop:\n${processes.map(({ label, kind }) => `• ${label} (${kind})`).join('\n')}`
}

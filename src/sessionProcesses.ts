import type { TmuxPane } from '../shared/protocol'

export const ARCHIVE_RESTORE_NOTE = 'Restore will recreate its windows and panes as fresh shells in their saved directories; the worktree is kept.'

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

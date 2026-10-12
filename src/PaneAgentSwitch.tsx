/**
 * The pane header's two-way switch for a chat's conversation: the chat, or
 * Claude Code running the same conversation in the pane.
 */
export function PaneAgentSwitch({
  mode,
  hostLogShown = false,
  chatDisabled,
  claudeCodeDisabled,
  claudeCodeTitle,
  onChat,
  onClaudeCode,
}: {
  mode: 'chat' | 'claude-code'
  /** The chat's pane shows its host's log (from the pane menu); Chat goes back to the chat. */
  hostLogShown?: boolean
  chatDisabled?: boolean
  claudeCodeDisabled?: boolean
  /** Why Claude Code can't be picked now, or what picking it does. */
  claudeCodeTitle?: string
  onChat: () => void
  onClaudeCode: () => void
}) {
  return (
    <span className="pane-agent-switch" role="group" aria-label="Show this conversation as">
      <button
        type="button"
        aria-pressed={mode === 'chat' && !hostLogShown}
        disabled={chatDisabled}
        title={mode === 'chat' ? hostLogShown ? 'Show the chat' : 'Showing the chat' : 'Exit Claude Code and return to the chat (when Claude Code is idle)'}
        onClick={onChat}
      >
        Chat
      </button>
      <button
        type="button"
        aria-pressed={mode === 'claude-code'}
        disabled={mode === 'chat' && claudeCodeDisabled}
        title={mode === 'claude-code' ? 'Running in Claude Code' : claudeCodeTitle ?? 'Continue this conversation in Claude Code, in this pane'}
        onClick={() => { if (mode === 'chat') onClaudeCode() }}
      >
        Claude Code
      </button>
    </span>
  )
}

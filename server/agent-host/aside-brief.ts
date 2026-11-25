import type { ChatAsideMode, ChatItem } from '../../shared/agent-chat.js'

export function asideInstructions(mode: ChatAsideMode, ephemeral = false): string {
  return `${ephemeral ? 'Answer directly from the conversation so far. Do not use tools unless strictly necessary. This is a quick answer; keep it concise. ' : ''}You are an aside, a side thread of the user's main conversation. Answer the side question; do not continue the main task. ${mode === 'read-only' ? 'Do not modify files. ' : "The read-only restriction is off; use the main conversation's permissions. "}Commando pane commands (commando-session-update, commando-pr-marker, commando-sim, commando-device, commando-chat) are not for you. Do not set pane titles or headlines. Do not end replies with a 🟢 status line, even if the main conversation’s instructions request one.`
}

/** A bounded text handoff for providers without native forks. */
export function asideBrief(items: readonly ChatItem[], mode: ChatAsideMode, maxChars = 8000): string {
  const heading = `Context from the main conversation (${asideInstructions(mode)})\n`
  const messages = items.filter((item) => item.kind === 'user_message' || item.kind === 'assistant_message')
  const goal = messages.find((item) => item.kind === 'user_message')
  const paths = [...new Set(items.flatMap((item) => item.kind === 'file_change' ? [item.path] : []))]
  const files = paths.length ? `\nFiles mentioned:\n${paths.join('\n')}`.slice(0, 1500) : ''
  const budget = Math.max(0, maxChars - heading.length - files.length)
  const first = goal ? `Goal: ${goal.text}\n`.slice(0, Math.min(2000, budget)) : ''
  let left = Math.max(0, budget - first.length)
  const recent: string[] = []
  for (const item of [...messages].reverse()) {
    if (item === goal || left <= 0) continue
    const line = `${item.kind === 'user_message' ? 'User' : 'Assistant'}: ${item.text}\n`
    const kept = line.length <= left ? line : line.slice(0, left)
    recent.push(kept)
    left -= kept.length
  }
  return (heading + first + recent.reverse().join('') + files).slice(0, maxChars)
}

/** Child processes must never report themselves as the pane's main agent. */
export function asideEnv(env: Record<string, string | undefined>, id: string): Record<string, string | undefined> {
  const clean = { ...process.env, ...env }
  delete clean.TMUX_PANE
  delete clean.COMMANDO_CHAT_RESUME
  delete clean.COMMANDO_CHAT_RESUME_B64
  clean.COMMANDO_ASIDE = id
  return clean
}

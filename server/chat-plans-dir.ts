import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Plans too long for a pane's opening prompt are written here, and the new
 * chat is pointed at the file. Agent hosts add the folder to Claude's
 * directories so reading it doesn't ask for approval. (Its own module so the
 * host doesn't load the notes code.)
 */
export function chatPlansDir(env: Record<string, string | undefined> = process.env): string {
  return env.COMMANDO_CHAT_PLANS_DIR || join(homedir(), '.commando', 'chat-plans')
}

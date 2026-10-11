import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { homedir } from 'node:os'

/**
 * Plans too long for a pane's opening prompt are written here, each in its
 * own folder, and the new chat is pointed at the file. Only the pane started
 * with a plan may read that plan's folder (its `--readable-dir`); no chat can
 * read the others. (Its own module so the host doesn't load the notes code.)
 */
export function chatPlansDir(env: Record<string, string | undefined> = process.env): string {
  return env.COMMANDO_CHAT_PLANS_DIR || join(homedir(), '.commando', 'chat-plans')
}

/** A stashed plan's folder name: random, so one chat can't guess another's. */
export const CHAT_PLAN_FOLDER = /^[0-9a-f]{32}$/

/** True for one plan's folder: a direct child of the plans folder, nothing above or beside it. */
export function isChatPlanDir(path: unknown, env: Record<string, string | undefined> = process.env): path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.endsWith('/')) return false
  return dirname(path) === normalize(chatPlansDir(env)) && CHAT_PLAN_FOLDER.test(basename(path))
}

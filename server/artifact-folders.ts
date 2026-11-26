import { realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * Where the daemon may serve a user's HTML from: the rule resource tiles
 * (server/pane-management-api.ts) and inline reply embeds
 * (server/chat-reply-embeds.ts) share, so a page that would not open as a
 * tile never shows inline either.
 *
 * HTML runs scripts, and an artifact registration exposes a whole folder, so
 * HTML is only served from a `.redline`, `.canvas` or `.pr` folder inside the
 * pane's working directory, never from the daemon's own state under
 * ~/.commando and never from a broad folder such as home or /tmp.
 */

export const ARTIFACT_FOLDER_NAMES: ReadonlySet<string> = new Set(['.redline', '.canvas', '.pr'])

export type ArtifactFolderOptions = {
  /** The pane's working directory; without one nothing is servable. */
  cwd: string | undefined
  home?: string
  /** Extra temporary roots treated as broad, for tests. */
  tempRoots?: readonly string[]
}

export function containsPath(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

const realpathOrUndefined = (path: string) => realpath(path).catch(() => undefined)

/** Folders too broad to register: home, its parent, /, /Users, /Volumes and the temporary roots (as realpaths). */
export async function broadDirectoryRealpaths(home = homedir(), tempRoots: readonly string[] = []): Promise<string[]> {
  const realHome = await realpathOrUndefined(home)
  const directories = [realHome, realHome ? dirname(realHome) : undefined, '/', '/Users', '/Volumes',
    tmpdir(), '/tmp', '/private/tmp', ...tempRoots]
  const real = await Promise.all(directories.map((directory) => directory ? realpathOrUndefined(directory) : undefined))
  return real.filter((directory): directory is string => directory !== undefined)
}

/** The daemon's state folder, ~/.commando, as a realpath when it exists. */
export async function daemonStateDirectory(home = homedir()): Promise<string> {
  const statePath = join(home, '.commando')
  const realHome = await realpathOrUndefined(home)
  return await realpathOrUndefined(statePath) ?? (realHome ? join(realHome, '.commando') : statePath)
}

/**
 * The `.redline`, `.canvas` or `.pr` folder that `directory` (a realpath: the
 * folder an HTML file is in, or a canvas folder) belongs to, as a realpath,
 * when the daemon may serve it; null otherwise.
 */
export async function servableArtifactFolder(directory: string, options: ArtifactFolderOptions): Promise<string | null> {
  const home = options.home ?? homedir()
  const broad = await broadDirectoryRealpaths(home, options.tempRoots)
  if (broad.includes(directory)) return null
  let folder = directory
  while (!ARTIFACT_FOLDER_NAMES.has(basename(folder))) {
    const ancestor = dirname(folder)
    if (ancestor === folder) return null
    folder = ancestor
  }
  const realFolder = await realpathOrUndefined(folder)
  if (!realFolder) return null
  const cwd = options.cwd ? await realpathOrUndefined(options.cwd) : undefined
  if (!cwd || !containsPath(cwd, realFolder)) return null
  if (containsPath(await daemonStateDirectory(home), realFolder) || broad.includes(realFolder)) return null
  return realFolder
}

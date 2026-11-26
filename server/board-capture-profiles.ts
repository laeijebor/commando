import { execFileSync } from 'node:child_process'
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Written by spawnChromiumLauncher immediately after spawning the detached group.
export const BOARD_CAPTURE_OWNER_FILE = '.commando-browser-owner.json'
type Processes = {
  alive(pid: number): boolean
  inspect(pid: number): { uid: number; group: number; command: string } | undefined
  killGroup(pid: number): void
}
const processes: Processes = {
  alive: (pid) => {
    try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  },
  inspect: (pid) => {
    try {
      const text = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid=,pgid=,command='], { encoding: 'utf8', timeout: 1000 })
      const match = /^\s*(\d+)\s+(\d+)\s+([\s\S]+)$/.exec(text)
      if (match) return { uid: Number(match[1]), group: Number(match[2]), command: match[3].trim() }
    } catch { /* Unverified processes must never be killed or have profiles removed. */ }
  },
  killGroup: (pid) => { process.kill(-pid, 'SIGKILL') },
}
const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 1
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Cleanup is scoped to our owned capture prefix and never live-tile profiles.
 * A live daemon owner, foreign uid, reused pid, non-leader group or mismatched
 * --user-data-dir makes the directory ineligible. Refuse rather than guess. */
export async function sweepStaleBoardCaptureProfiles(options: {
  root?: string; uid?: number; now?: () => number; processes?: Processes
} = {}): Promise<{ removed: number; errors: string[] }> {
  const result = { removed: 0, errors: [] as string[] }
  const uid = options.uid ?? process.getuid?.()
  if (uid === undefined) return result
  const proc = options.processes ?? processes, now = options.now ?? Date.now
  let root: string
  try { root = await realpath(options.root ?? tmpdir()) } catch { return result }
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) }
  catch (error) { result.errors.push(String(error)); return result }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^commando-board-browser-[A-Za-z0-9_-]+$/.test(entry.name)) continue
    const profile = join(root, entry.name)
    try {
      const info = await lstat(profile)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || await realpath(profile) !== profile) continue
      let owner: { ownerPid: number; browserPid?: number; ownerUid?: number; phase?: 'launching' } | undefined
      try {
        const file = await lstat(join(profile, BOARD_CAPTURE_OWNER_FILE))
        if (!file.isFile() || file.isSymbolicLink() || file.uid !== uid || file.size > 4096) continue
        const value = JSON.parse(await readFile(join(profile, BOARD_CAPTURE_OWNER_FILE), 'utf8')) as typeof owner
        if (!value || !validPid(value.ownerPid) || (!validPid(value.browserPid) && value.phase !== 'launching') || (value.ownerUid !== undefined && value.ownerUid !== uid)) continue
        owner = value
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
        // A crash before spawn, or after normal exit, can leave no owner file.
        // Give concurrent startup/retirement a minute before deleting these.
        if (info.mtimeMs + 60_000 > now()) continue
      }
      if (owner) {
        if (proc.alive(owner.ownerPid)) continue
        if (owner.browserPid && proc.alive(owner.browserPid)) {
          const browser = proc.inspect(owner.browserPid)
          if (!browser || browser.uid !== uid || browser.group !== owner.browserPid
            || !/(?:^|\s)--headless(?:=\S+)?(?:\s|$)/.test(browser.command)
            || !new RegExp(`(?:^|\\s)--user-data-dir=${escapeRegex(profile)}(?:\\s|$)`).test(browser.command)) {
            result.errors.push(`Refusing unverified capture browser ${owner.browserPid} at ${profile}`); continue
          }
          proc.killGroup(owner.browserPid)
          const deadline = Date.now() + 2000
          while (proc.alive(owner.browserPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
          if (proc.alive(owner.browserPid)) { result.errors.push(`Capture browser ${owner.browserPid} did not exit`); continue }
        }
      }
      await rm(profile, { recursive: true, force: true }); result.removed++
    } catch (error) { result.errors.push(`${profile}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return result
}

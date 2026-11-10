/**
 * A process started from a Commando pane, grouped with its child processes. Panes mark their
 * processes through the inherited TMUX/TMUX_PANE environment, so detached processes (nohup,
 * setsid, disowned jobs) are tracked too, also after their pane or session has closed.
 */
export type TrackedProcess = {
  /** `pid:startSeconds`: stable for one process and never reused by a later one with the same pid. */
  key: string
  pid: number
  /** Short form for display; `fullCommand` keeps the complete command line (truncated). */
  command: string
  fullCommand: string
  /** Epoch milliseconds. */
  startedAt: number
  /** Summed over the process and its children. */
  cpuPercent: number
  rssKb: number
  ports: number[]
  /** Child processes grouped under this one. */
  childCount: number
  /** The process is no longer in its pane's process tree (reparented, or the pane has closed). */
  detached: boolean
  paneId: string
  /** Whether the pane that started it is still open. */
  paneOpen: boolean
  targetId?: string
  sessionId?: string
  sessionName?: string
}

const PROCESS_KEY = /^\d{1,10}:\d{1,12}$/

export function isTrackedProcessKey(value: unknown): value is string {
  return typeof value === 'string' && PROCESS_KEY.test(value)
}

const APP = /^(?:\/System)?\/Applications\/|^\/Users\/[^/]+\/Applications\//
// Daemons other sessions reuse once started: stopping one breaks their builds or devices.
const SHARED_HELPER_NAMES = new Set(['adb', 'gpg-agent', 'ssh-agent', 'watchman', 'sccache'])
const SHARED_HELPER_CLASSES = /\borg\.gradle\.launcher\.daemon\.|\bKotlinCompileDaemon\b/

/**
 * Why the close dialog leaves a process unticked, if it does. Apps from an Applications folder
 * (an editor a pane opened with `code .`, a browser) outlive the session on purpose, and shared
 * helper daemons (adb, Gradle, watchman) serve other sessions too.
 */
export function keepReason(process: Pick<TrackedProcess, 'fullCommand'>): 'app' | 'shared helper' | undefined {
  if (APP.test(process.fullCommand)) return 'app'
  const program = process.fullCommand.trimStart().split(/\s/, 1)[0].split('/').at(-1) ?? ''
  if (SHARED_HELPER_NAMES.has(program) || SHARED_HELPER_CLASSES.test(process.fullCommand)) return 'shared helper'
  return undefined
}

/** Whether the close dialog ticks a process to stop. */
export function stopsByDefault(process: Pick<TrackedProcess, 'fullCommand'>): boolean {
  return keepReason(process) === undefined
}

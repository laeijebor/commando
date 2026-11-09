import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isTrackedProcessKey, type TrackedProcess } from '../shared/tracked-processes.js'
import { parseListeningProcesses, type ListeningProcess } from './open-ports.js'
import { tmuxSocketStateSuffix } from './tmux-socket-scope.js'

/**
 * Tracks processes started from this daemon's tmux panes, including detached ones.
 *
 * Every process started in a pane inherits `TMUX=<socket>,<server pid>,<session>` and
 * `TMUX_PANE=%N`; both survive nohup, setsid and reparenting, so a process is attributed to a
 * pane by its pane's process tree first and by that environment otherwise. On macOS `ps -E`
 * shows the environment of the user's own processes, except Apple platform binaries
 * (/bin/sleep, /bin/zsh and the like), which it hides; those are still tracked while they are
 * in a pane's tree, and remembered by pid and start time once they leave it.
 */

export const SCAN_MAX_AGE_MS = 10_000
const MIN_PROCESS_AGE_MS = 5_000
const STOP_GRACE_MS = 3_000
const STOP_POLL_MS = 250
const COMMAND_TIMEOUT_MS = 3_000
const COMMAND_BUFFER_BYTES = 32 * 1024 * 1024
const MAX_PS_LINES = 20_000
const MAX_REMEMBERED_PROCESSES = 2_000
const MAX_PANE_RECORDS = 500
const MAX_COMMAND_LENGTH = 8_000
const MAX_FULL_COMMAND_LENGTH = 1_000
const SHORT_COMMAND_LENGTH = 120

export type ProcessRow = {
  pid: number
  ppid: number
  pgid: number
  /** Foreground process group of the process's terminal; 0 or -1 without one. */
  tpgid: number
  uid: number
  /** Controlling terminal, `??`/`?` without one. */
  tty: string
  cpuPercent: number
  rssKb: number
  startedAt: number
  command: string
}

/** The pane a process's environment names, on this daemon's tmux socket. */
export type PaneTag = { paneId: string; serverPid: number }

export type LivePane = {
  paneId: string
  processId: number
  sessionId: string
  sessionName: string
  targetId?: string
}

export type PaneRecord = { targetId?: string; sessionId: string; sessionName: string }

export type TmuxServer = { socketPath: string; serverPid: number }

export type ProcessMember = { pid: number; startedAt: number }

export type TrackInput = {
  rows: readonly ProcessRow[]
  tags: ReadonlyMap<number, PaneTag>
  listeners: readonly ListeningProcess[]
  livePanes: readonly LivePane[]
  server: TmuxServer
  /** Process key → pane key, from earlier scans. */
  remembered: ReadonlyMap<string, string>
  /** Pane key (`serverPid:%N`) → where that pane was, kept after it closes. */
  paneRecords: ReadonlyMap<string, PaneRecord>
  /** The daemon: it, its ancestors and its descendants are never tracked. */
  daemonPid: number
  protectedPorts: ReadonlySet<number>
  now: number
  minAgeMs?: number
}

export type TrackResult = {
  processes: TrackedProcess[]
  /** Every process in each listed group, for stopping it. */
  members: Map<string, ProcessMember[]>
  remembered: Map<string, string>
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

const LSTART = String.raw`[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})`
const TABLE_LINE = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+${LSTART}\s+(.*)$`)
const START_LINE = new RegExp(String.raw`^\s*(\d+)\s+${LSTART}\s*$`)

/** `ps -o lstart` (with LC_ALL=C), e.g. `Mon Nov  9 17:14:12 2026`, as local epoch milliseconds. */
function startTime(month: string, day: string, hours: string, minutes: string, seconds: string, year: string): number | null {
  const monthIndex = MONTHS[month]
  if (monthIndex === undefined) return null
  const time = new Date(Number(year), monthIndex, Number(day), Number(hours), Number(minutes), Number(seconds)).getTime()
  return Number.isFinite(time) ? time : null
}

export const PROCESS_TABLE_ARGS = ['-axww', '-o', 'pid=,ppid=,pgid=,tpgid=,uid=,tty=,%cpu=,rss=,lstart=,command=']

export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split('\n', MAX_PS_LINES)) {
    const match = TABLE_LINE.exec(line)
    if (!match) continue
    const startedAt = startTime(match[9], match[10], match[11], match[12], match[13], match[14])
    if (startedAt === null) continue
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tpgid: Number(match[4]), uid: Number(match[5]), tty: match[6],
      cpuPercent: Number(match[7]), rssKb: Number(match[8]), startedAt, command: match[15].trim().slice(0, MAX_COMMAND_LENGTH),
    })
  }
  return rows
}

/** `ps -o pid=,lstart= -p …`: each live pid's start time, for the pid-reuse check before a signal. */
export function parseStartTimes(output: string): Map<number, number> {
  const times = new Map<number, number>()
  for (const line of output.split('\n', MAX_PS_LINES)) {
    const match = START_LINE.exec(line)
    const startedAt = match && startTime(match[2], match[3], match[4], match[5], match[6], match[7])
    if (match && startedAt !== null) times.set(Number(match[1]), startedAt)
  }
  return times
}

export function processKey(process: ProcessMember): string {
  return `${process.pid}:${Math.floor(process.startedAt / 1_000)}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `ps -axwwE -o pid=,command=` on macOS appends each process's environment to its command line.
 * The environment comes last, so the last TMUX/TMUX_PANE words win over look-alike arguments.
 */
export function parseMacEnvironmentTags(output: string, socketPath: string): Map<number, PaneTag> {
  const tags = new Map<number, PaneTag>()
  const tmux = new RegExp(String.raw`(?:^|\s)TMUX=${escapeRegExp(socketPath)},(\d+),\d+(?=\s|$)`, 'g')
  const pane = /(?:^|\s)TMUX_PANE=(%\d+)(?=\s|$)/g
  for (const line of output.split('\n', MAX_PS_LINES)) {
    if (!line.includes('TMUX_PANE=%')) continue
    const pid = /^\s*(\d+)\s/.exec(line)?.[1]
    const serverPid = [...line.matchAll(tmux)].at(-1)?.[1]
    const paneId = [...line.matchAll(pane)].at(-1)?.[1]
    if (pid && serverPid && paneId) tags.set(Number(pid), { paneId, serverPid: Number(serverPid) })
  }
  return tags
}

/** A Linux `/proc/<pid>/environ` (NUL-separated). */
export function parseEnvironTag(environ: string, socketPath: string): PaneTag | null {
  let tmux: string | undefined
  let paneId: string | undefined
  for (const entry of environ.split('\0')) {
    if (entry.startsWith('TMUX=')) tmux = entry.slice(5)
    else if (entry.startsWith('TMUX_PANE=')) paneId = entry.slice(10)
  }
  if (!tmux || !paneId || !/^%\d+$/.test(paneId)) return null
  const match = /^(.*),(\d+),\d+$/.exec(tmux)
  return match && match[1] === socketPath ? { paneId, serverPid: Number(match[2]) } : null
}

async function readLinuxTags(pids: readonly number[], socketPath: string): Promise<Map<number, PaneTag>> {
  const tags = new Map<number, PaneTag>()
  const read = async (pid: number) => {
    // Processes exit between the table and this read, and other users' environments are unreadable.
    const environ = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '')
    const tag = environ ? parseEnvironTag(environ, socketPath) : null
    if (tag) tags.set(pid, tag)
  }
  for (let index = 0; index < pids.length; index += 64) await Promise.all(pids.slice(index, index + 64).map(read))
  return tags
}

/** `node /long/path/to/vite.js --port 5173` → `node …/to/vite.js --port 5173`. */
export function shortenCommand(command: string): string {
  const [program = '', ...args] = command.trim().split(/\s+/)
  const words = [program.split('/').at(-1) || program, ...args.map((arg) => {
    if (!arg.startsWith('/') || arg.length <= 32) return arg
    const parts = arg.split('/').filter(Boolean)
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : arg
  })]
  const short = words.join(' ')
  return short.length > SHORT_COMMAND_LENGTH ? `${short.slice(0, SHORT_COMMAND_LENGTH - 1)}…` : short
}

const SHELL_WRAPPER = /^(?:\S*\/)?(?:sh|bash|zsh|dash|fish)\s+-c\s/

/**
 * What a group runs, for display: a `sh -c` wrapper shows the command it started, or the
 * command an agent's tool wrapper evaluates (Claude Code runs `zsh -c … eval '<command>' < /dev/null`).
 */
function displayCommand(root: ProcessRow, children: readonly ProcessRow[]): string {
  if (!SHELL_WRAPPER.test(root.command)) return shortenCommand(root.command)
  const evaluated = /\beval '((?:[^']|'"'"')+)' < \/dev\/null/.exec(root.command)?.[1]
  if (evaluated) return shortenCommand(evaluated.replaceAll(`'"'"'`, `'`))
  const child = children.filter((row) => row.ppid === root.pid).sort((left, right) => left.startedAt - right.startedAt)[0]
  return shortenCommand((child ?? root).command)
}

export function trackProcesses(input: TrackInput): TrackResult {
  const byPid = new Map(input.rows.map((row) => [row.pid, row]))
  const children = new Map<number, number[]>()
  for (const row of input.rows) {
    if (row.ppid === row.pid) continue
    const siblings = children.get(row.ppid) ?? []
    siblings.push(row.pid)
    children.set(row.ppid, siblings)
  }
  const ancestors = function* (pid: number) {
    const seen = new Set<number>()
    for (let current = byPid.get(pid); current && current.pid > 1 && !seen.has(current.pid); current = byPid.get(current.ppid)) {
      seen.add(current.pid)
      yield current
    }
  }
  const addTree = (into: Set<number>, pid: number) => {
    const visited = new Set<number>()
    const stack = [pid]
    while (stack.length) {
      const current = stack.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      into.add(current)
      stack.push(...children.get(current) ?? [])
    }
  }

  // Never the daemon (with what started it and what it runs), the tmux server, or what serves protected ports.
  const protectedPids = new Set<number>([input.server.serverPid])
  for (const row of ancestors(input.daemonPid)) protectedPids.add(row.pid)
  addTree(protectedPids, input.daemonPid)
  for (const listener of input.listeners) if (input.protectedPorts.has(listener.port)) addTree(protectedPids, listener.processId)

  const liveByPid = new Map(input.livePanes.map((pane) => [pane.processId, pane]))
  const liveByKey = new Map(input.livePanes.map((pane) => [`${input.server.serverPid}:${pane.paneId}`, pane]))

  // The pane each process belongs to: through its live pane's tree first, else the nearest
  // ancestor (itself included) whose environment names a pane or that an earlier scan placed.
  const owners = new Map<number, { paneKey: string; inTree: boolean }>()
  for (const row of input.rows) {
    if (protectedPids.has(row.pid) || row.pid <= 1 || liveByPid.has(row.pid)) continue
    let owner: { paneKey: string; inTree: boolean } | undefined
    for (const ancestor of ancestors(row.ppid)) {
      const pane = liveByPid.get(ancestor.pid)
      if (pane) { owner = { paneKey: `${input.server.serverPid}:${pane.paneId}`, inTree: true }; break }
    }
    if (!owner) {
      for (const ancestor of ancestors(row.pid)) {
        const tag = input.tags.get(ancestor.pid)
        const paneKey = tag ? `${tag.serverPid}:${tag.paneId}` : input.remembered.get(processKey(ancestor))
        if (paneKey) { owner = { paneKey, inTree: false }; break }
      }
    }
    if (owner) owners.set(row.pid, owner)
  }

  // What a live pane visibly runs is not listed: its root shell, its foreground job (an agent CLI,
  // its wrappers and the helpers in its process group) and the agent's own helpers in other
  // process groups. Those are children of the foreground job that still share the pane's
  // terminal (MCP servers), or that hang off a foreground process beside the agent's chain
  // (an MCP server's watchdog). Commands the agent runs detach from the terminal and stay listed.
  const hidden = new Set<number>()
  for (const pane of input.livePanes) {
    const root = byPid.get(pane.processId)
    if (!root || root.tpgid <= 0) continue
    const paneKey = `${input.server.serverPid}:${pane.paneId}`
    const inPane = (pid: number) => owners.get(pid)?.inTree === true && owners.get(pid)?.paneKey === paneKey
    const foreground = new Set(input.rows.filter((row) => row.pgid === root.tpgid && inPane(row.pid)).map((row) => row.pid))
    for (const pid of foreground) {
      for (const ancestor of ancestors(pid)) {
        if (ancestor.pid === pane.processId) break
        hidden.add(ancestor.pid)
      }
    }
    // The agent's chain: from the top of the job down while it has a single foreground child.
    const spine = new Set<number>()
    let level = [...foreground].filter((pid) => !foreground.has(byPid.get(pid)!.ppid))
    while (level.length === 1) {
      spine.add(level[0])
      level = (children.get(level[0]) ?? []).filter((pid) => foreground.has(pid))
    }
    const terminal = /^\?+$/.test(root.tty) ? undefined : root.tty
    for (const row of input.rows) {
      if (foreground.has(row.pid) || !foreground.has(row.ppid) || !inPane(row.pid)) continue
      if (!spine.has(row.ppid) || row.tty === terminal) addTree(hidden, row.pid)
    }
  }

  const remembered = new Map<string, string>()
  const listed = new Set<number>()
  const minimumStart = input.now - (input.minAgeMs ?? MIN_PROCESS_AGE_MS)
  for (const [pid, owner] of owners) {
    const row = byPid.get(pid)!
    remembered.set(processKey(row), owner.paneKey)
    if (!hidden.has(pid) && row.startedAt <= minimumStart) listed.add(pid)
  }

  // Group each listed process under its topmost listed ancestor from the same pane.
  const groups = new Map<number, number[]>()
  for (const pid of listed) {
    let top = pid
    for (const ancestor of ancestors(byPid.get(pid)!.ppid)) {
      if (!listed.has(ancestor.pid) || owners.get(ancestor.pid)!.paneKey !== owners.get(pid)!.paneKey) break
      top = ancestor.pid
    }
    const group = groups.get(top) ?? []
    group.push(pid)
    groups.set(top, group)
  }

  const portsByPid = new Map<number, number[]>()
  for (const listener of input.listeners) portsByPid.set(listener.processId, [...portsByPid.get(listener.processId) ?? [], listener.port])
  const processes: TrackedProcess[] = []
  const members = new Map<string, ProcessMember[]>()
  for (const [top, pids] of groups) {
    const root = byPid.get(top)!
    const owner = owners.get(top)!
    const live = liveByKey.get(owner.paneKey)
    const record = live ?? input.paneRecords.get(owner.paneKey)
    const groupRows = pids.map((pid) => byPid.get(pid)!)
    const key = processKey(root)
    members.set(key, groupRows.map(({ pid, startedAt }) => ({ pid, startedAt })))
    processes.push({
      key, pid: top, command: displayCommand(root, groupRows), fullCommand: root.command.slice(0, MAX_FULL_COMMAND_LENGTH), startedAt: root.startedAt,
      cpuPercent: Math.round(groupRows.reduce((sum, row) => sum + row.cpuPercent, 0) * 10) / 10,
      rssKb: groupRows.reduce((sum, row) => sum + row.rssKb, 0),
      ports: [...new Set(pids.flatMap((pid) => portsByPid.get(pid) ?? []))].sort((left, right) => left - right),
      childCount: pids.length - 1, detached: !owner.inTree,
      paneId: owner.paneKey.slice(owner.paneKey.indexOf(':') + 1), paneOpen: Boolean(live),
      ...(record?.targetId ? { targetId: record.targetId } : {}),
      ...(record ? { sessionId: record.sessionId, sessionName: record.sessionName } : {}),
    })
  }
  processes.sort((left, right) => left.startedAt - right.startedAt || left.pid - right.pid)
  return { processes, members, remembered }
}

export type ProcessSignal = (pid: number, signal: NodeJS.Signals) => void

export type StopDependencies = {
  signal: ProcessSignal
  /** Current start times of the pids that are still alive. */
  startTimes: (pids: readonly number[]) => Promise<Map<number, number>>
  sleep: (ms: number) => Promise<void>
  graceMs?: number
}

/**
 * SIGTERM, then SIGKILL to what is still running after a grace period, to processes that are
 * still the exact processes that were scanned: each pid's start time is checked again right
 * before each signal, so a reused pid is never signalled. Resolves once TERM is sent; `finished`
 * settles once all have exited or been killed, with the number that needed KILL.
 */
export async function stopMembers(members: readonly ProcessMember[], dependencies: StopDependencies): Promise<{ terminated: number; failed: number[]; finished: Promise<number> }> {
  const failed: number[] = []
  const unchanged = async (candidates: readonly ProcessMember[]) => {
    const current = await dependencies.startTimes(candidates.map(({ pid }) => pid))
    return candidates.filter(({ pid, startedAt }) => {
      const now = current.get(pid)
      return pid > 1 && pid !== process.pid && now !== undefined && Math.floor(now / 1_000) === Math.floor(startedAt / 1_000)
    })
  }
  const send = (targets: readonly ProcessMember[], signal: NodeJS.Signals) => {
    let sent = 0
    for (const { pid } of targets) {
      try { dependencies.signal(pid, signal); sent += 1 }
      catch (error) {
        // ESRCH: it exited in between, so nothing is left to stop.
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue
        console.warn(`[commando] Could not send ${signal} to process ${pid}`, error)
        if (!failed.includes(pid)) failed.push(pid)
      }
    }
    return sent
  }
  const alive = await unchanged(members)
  const terminated = send(alive, 'SIGTERM')
  const finished = (async () => {
    let remaining = alive
    for (let waited = 0; remaining.length && waited < (dependencies.graceMs ?? STOP_GRACE_MS); waited += STOP_POLL_MS) {
      await dependencies.sleep(STOP_POLL_MS)
      remaining = await unchanged(remaining)
    }
    return remaining.length ? send(remaining, 'SIGKILL') : 0
  })()
  return { terminated, failed, finished }
}

/** A requested process belongs to another session or pane than the request is about. */
export class TrackedProcessScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TrackedProcessScopeError'
  }
}

type StoredState = { version: 1; panes: Record<string, PaneRecord>; processes: Record<string, string> }

export function defaultTrackedProcessesPath(): string {
  if (process.env.COMMANDO_TRACKED_PROCESSES_PATH) return process.env.COMMANDO_TRACKED_PROCESSES_PATH
  return join(homedir(), '.commando', `tracked-processes${tmuxSocketStateSuffix()}.json`)
}

function validState(value: unknown): value is StoredState {
  if (!value || typeof value !== 'object') return false
  const state = value as StoredState
  if (state.version !== 1 || !state.panes || typeof state.panes !== 'object' || !state.processes || typeof state.processes !== 'object') return false
  return Object.entries(state.processes).every(([key, paneKey]) => isTrackedProcessKey(key) && typeof paneKey === 'string' && /^\d+:%\d+$/.test(paneKey)) &&
    Object.entries(state.panes).every(([paneKey, record]) => /^\d+:%\d+$/.test(paneKey) && record && typeof record === 'object' &&
      typeof record.sessionId === 'string' && typeof record.sessionName === 'string' &&
      (record.targetId === undefined || typeof record.targetId === 'string'))
}

/** Pane records and remembered processes, kept so closed panes' processes survive a daemon restart. */
export class TrackedProcessStore {
  constructor(readonly statePath = defaultTrackedProcessesPath()) {}

  async load(): Promise<{ panes: Map<string, PaneRecord>; processes: Map<string, string> }> {
    try {
      const state: unknown = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (!validState(state)) throw new Error('Invalid tracked process state')
      return { panes: new Map(Object.entries(state.panes)), processes: new Map(Object.entries(state.processes)) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[commando] Ignoring unreadable tracked process state', error)
      return { panes: new Map(), processes: new Map() }
    }
  }

  async save(panes: ReadonlyMap<string, PaneRecord>, processes: ReadonlyMap<string, string>): Promise<void> {
    const state: StoredState = { version: 1, panes: Object.fromEntries(panes), processes: Object.fromEntries(processes) }
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(state)}\n`) }
    finally { await handle.close() }
    await rename(temporary, this.statePath)
  }
}

function runCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: 'utf8', maxBuffer: COMMAND_BUFFER_BYTES, shell: false, timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout) => {
      // lsof with no listeners and `ps -p` with no live pid exit 1 with nothing to report.
      if (!error || ((command === 'lsof' || (command === 'ps' && args.includes('-p'))) && error.code === 1)) resolve(stdout ?? '')
      else reject(error)
    })
  })
}

export type ProcessTrackerOptions = {
  livePanes: () => readonly LivePane[]
  tmuxServer: () => Promise<TmuxServer | null>
  protectedPorts?: Iterable<number>
  store?: TrackedProcessStore
  runner?: CommandRunner
  platform?: NodeJS.Platform
  readLinuxTags?: (pids: readonly number[], socketPath: string) => Promise<Map<number, PaneTag>>
  signal?: ProcessSignal
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  uid?: number
  daemonPid?: number
}

export type ProcessSelection = { processes: TrackedProcess[]; members: ProcessMember[]; missing: string[] }
export type StopResult = { stopped: TrackedProcess[]; missing: string[]; failed: number[]; finished: Promise<number> }

export class ProcessTracker {
  private readonly runner: CommandRunner
  private readonly protectedPorts: ReadonlySet<number>
  private readonly store: TrackedProcessStore
  private state: Promise<{ panes: Map<string, PaneRecord>; processes: Map<string, string> }> | null = null
  private latest: { at: number; result: TrackResult } | null = null
  /** Kept for when the tmux server exits with its last session: its processes are still tracked. */
  private lastServer: TmuxServer | null = null
  /** Kept so a failed lsof cannot drop the protection of protected ports. */
  private lastListeners: ListeningProcess[] = []
  private inflight: Promise<TrackResult> | null = null

  constructor(private readonly options: ProcessTrackerOptions) {
    this.runner = options.runner ?? runCommand
    this.protectedPorts = new Set(options.protectedPorts ?? [])
    this.store = options.store ?? new TrackedProcessStore()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Tracked processes from a scan no older than `maxAgeMs`; concurrent callers share one scan. */
  async list(maxAgeMs = SCAN_MAX_AGE_MS): Promise<TrackedProcess[]> {
    return (await this.result(maxAgeMs)).processes
  }

  private async result(maxAgeMs: number): Promise<TrackResult> {
    if (this.latest && this.now() - this.latest.at < maxAgeMs) return this.latest.result
    if (!this.inflight) {
      this.inflight = this.scan().finally(() => { this.inflight = null })
    }
    return this.inflight
  }

  private async scan(): Promise<TrackResult> {
    const startedAt = this.now()
    this.state ??= this.store.load()
    const state = await this.state
    const server = await this.options.tmuxServer() ?? this.lastServer
    if (server) this.lastServer = server
    if (!server) {
      const result = { processes: [], members: new Map(), remembered: new Map() }
      this.latest = { at: startedAt, result }
      return result
    }
    const platform = this.options.platform ?? process.platform
    const [table, listeners, macEnvironments] = await Promise.all([
      this.runner('ps', PROCESS_TABLE_ARGS),
      this.runner('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']).then(parseListeningProcesses).catch((error: unknown) => {
        // A host without lsof still lists its processes; the last listeners keep protected ports protected.
        console.warn('[commando] lsof failed; process ports may be stale', error)
        return this.lastListeners
      }),
      platform === 'darwin' ? this.runner('ps', ['-axwwE', '-o', 'pid=,command=']) : Promise.resolve(''),
    ])
    const uid = this.options.uid ?? process.getuid?.()
    const parsed = parseProcessTable(table)
    // A ps that cannot print these columns must not read as "nothing runs": that would forget every remembered process.
    if (!parsed.length) throw new Error('ps listed no processes')
    this.lastListeners = listeners
    const rows = parsed.filter((row) => uid === undefined || row.uid === uid)
    const tags = platform === 'darwin' ? parseMacEnvironmentTags(macEnvironments, server.socketPath)
      : platform === 'linux' ? await (this.options.readLinuxTags ?? readLinuxTags)(rows.map(({ pid }) => pid), server.socketPath)
        : new Map<number, PaneTag>()
    const livePanes = this.options.livePanes()
    for (const pane of livePanes) {
      state.panes.set(`${server.serverPid}:${pane.paneId}`, {
        sessionId: pane.sessionId, sessionName: pane.sessionName, ...(pane.targetId ? { targetId: pane.targetId } : {}),
      })
    }
    const result = trackProcesses({
      rows, tags, listeners, livePanes, server,
      remembered: state.processes, paneRecords: state.panes,
      daemonPid: this.options.daemonPid ?? process.pid, protectedPorts: this.protectedPorts, now: startedAt,
    })
    await this.persist(state, result, new Set(livePanes.map((pane) => `${server.serverPid}:${pane.paneId}`)))
    this.latest = { at: startedAt, result }
    return result
  }

  private async persist(
    state: { panes: Map<string, PaneRecord>; processes: Map<string, string> },
    result: TrackResult,
    livePaneKeys: ReadonlySet<string>,
  ): Promise<void> {
    const before = JSON.stringify([[...state.panes], [...state.processes]])
    const processes = new Map([...result.remembered].slice(-MAX_REMEMBERED_PROCESSES))
    const usedPanes = new Set([...livePaneKeys, ...processes.values()])
    const panes = new Map([...state.panes].filter(([paneKey]) => usedPanes.has(paneKey)).slice(-MAX_PANE_RECORDS))
    state.panes = panes
    state.processes = processes
    if (JSON.stringify([[...panes], [...processes]]) === before) return
    try { await this.store.save(panes, processes) }
    catch (error) { console.warn('[commando] Could not save tracked processes; they are kept in memory', error) }
  }

  /**
   * The tracked process groups for `keys` in a fresh scan, with every process in them. Keys no
   * longer tracked are `missing`; a key `allowed` refuses throws TrackedProcessScopeError.
   */
  async select(keys: readonly string[], allowed?: (process: TrackedProcess) => boolean): Promise<ProcessSelection> {
    const result = await this.result(0)
    const processes: TrackedProcess[] = []
    const missing: string[] = []
    for (const key of new Set(keys)) {
      const tracked = result.processes.find((process) => process.key === key)
      if (!tracked) { missing.push(key); continue }
      if (allowed && !allowed(tracked)) throw new TrackedProcessScopeError(`Process ${tracked.pid} (${tracked.command}) is not part of this request`)
      processes.push(tracked)
    }
    return { processes, members: processes.flatMap((tracked) => result.members.get(tracked.key) ?? []), missing }
  }

  /**
   * Stops a selection. Its pids are signalled as scanned (start times re-checked), so it can be
   * taken before a session closes and stopped after, however the close regroups its processes.
   */
  async stopSelection(selection: ProcessSelection): Promise<StopResult> {
    for (const tracked of selection.processes) console.info(`[commando] stopping process ${tracked.pid} (${tracked.command}) from pane ${tracked.paneId}${tracked.sessionName ? ` of ${tracked.sessionName}` : ''}`)
    this.latest = null
    const { failed, finished } = await stopMembers(selection.members, {
      signal: this.options.signal ?? ((pid, signal) => process.kill(pid, signal)),
      startTimes: async (pids) => pids.length ? parseStartTimes(await this.runner('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')])) : new Map(),
      sleep: this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    })
    return { stopped: selection.processes, missing: selection.missing, failed, finished: finished.finally(() => { this.latest = null }) }
  }

  /** Stops tracked process groups by key, from a fresh scan. */
  async stop(keys: readonly string[], allowed?: (process: TrackedProcess) => boolean): Promise<StopResult> {
    return this.stopSelection(await this.select(keys, allowed))
  }
}

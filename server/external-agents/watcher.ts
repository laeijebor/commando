import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ChatSessionStatus, ChatSubagentState, ExternalAgentRun } from '../../shared/agent-chat.js'
import { claudeSource, findClaudeTranscript } from './claude-transcript.js'
import { codexSource, matchRollout, rolloutCandidates, type RolloutCandidate } from './codex-rollout.js'
import { findAgentProcesses, indexProcesses, processCwd, readProcesses, runningCommand, type AgentProcess, type ProcessRow } from './process-scan.js'
import type { AgentProgress, ProgressSource } from './progress.js'

export const QUIET_AFTER_MS = 3 * 60 * 1000
/** A turn can launch a background run and finish between two polls, so keep scanning briefly after it. */
export const SCAN_AFTER_BUSY_MS = 30_000
export const MAX_ORPHAN_LOOKUPS_PER_POLL = 5

export interface WatchedPane {
  paneId: string
  panePid?: number
  hostPid?: number
  sessionId?: string
  status?: ChatSessionStatus
  cwd?: string
}

interface TrackedRun {
  process: AgentProcess
  run: ExternalAgentRun
  cwd?: string
  source?: ProgressSource
  completed: boolean
  alive: boolean
  retired?: boolean
  transcriptLookupStartedAt?: number
  nextTranscriptLookupAt?: number
}

interface WatcherDependencies {
  panes: () => readonly WatchedPane[]
  publish: (paneId: string, runs: ExternalAgentRun[]) => void
  now?: () => number
  processes?: () => Promise<ProcessRow[]>
  cwd?: (pid: number) => Promise<string | undefined>
  source?: (process: AgentProcess, cwd: string, claimed: ReadonlySet<string>, now: number) => Promise<ProgressSource | undefined>
  signal?: (pid: number, signal: NodeJS.Signals) => void
  later?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  home?: string
  configDirs?: string[]
}

export function runState(run: ExternalAgentRun, alive: boolean, completed: boolean, now: number, hasSource: boolean): ChatSubagentState {
  if (run.state === 'stopped') return 'stopped'
  if (completed) return 'completed'
  if (!alive) return run.runtime === 'codex' && hasSource ? 'failed' : 'completed'
  return hasSource && !run.runningCommand && now - (run.lastEventAt ?? run.startedAt) >= QUIET_AFTER_MS ? 'quiet' : 'running'
}

function sameProcess(row: ProcessRow | undefined, process: AgentProcess): boolean {
  return row?.startedAt === process.startedAt && row.command === process.command
}

export class ExternalAgentWatcher {
  private readonly runs = new Map<string, TrackedRun[]>()
  private readonly conversations = new Map<string, Pick<WatchedPane, 'hostPid' | 'sessionId' | 'status'> & { observedAt: number }>()
  private readonly paneBusyTimes = new Map<string, { since: number; lastBusyAt: number }>()
  private readonly orphanDecisions = new Map<string, { paneId?: string; cwd?: string }>()
  private readonly rolloutCache = new Map<string, RolloutCandidate>()
  private readonly published = new Map<string, string>()
  private readonly stopTimers = new Set<ReturnType<typeof setTimeout>>()
  private timer?: ReturnType<typeof setInterval>
  private polling = false
  private closed = false
  private busyAt = -Infinity
  private readonly now: () => number
  private readonly processes: () => Promise<ProcessRow[]>
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void

  constructor(private readonly dependencies: WatcherDependencies) {
    this.now = dependencies.now ?? Date.now
    this.processes = dependencies.processes ?? readProcesses
    this.signal = dependencies.signal ?? ((pid, signal) => { process.kill(pid, signal) })
  }

  start(): void {
    if (this.timer || this.closed) return
    void this.poll()
    this.timer = setInterval(() => { void this.poll() }, 2_000)
    this.timer.unref()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    for (const timer of this.stopTimers) clearTimeout(timer)
    this.stopTimers.clear()
  }

  snapshots(): { paneId: string; runs: ExternalAgentRun[] }[] {
    return [...this.runs].map(([paneId, runs]) => ({ paneId, runs: runs.filter((entry) => !entry.retired).map(({ run }) => ({ ...run })) }))
  }

  private publish(paneId: string): void {
    if (this.closed) return
    const runs = (this.runs.get(paneId) ?? []).filter((entry) => !entry.retired).map(({ run }) => ({ ...run }))
    const fingerprint = JSON.stringify(runs)
    if (this.published.get(paneId) === fingerprint) return
    this.published.set(paneId, fingerprint)
    this.dependencies.publish(paneId, runs)
  }

  async poll(): Promise<void> {
    if (this.polling || this.closed) return
    this.polling = true
    try {
      const panes = this.dependencies.panes()
      const observedAt = this.now()
      const paneIds = new Set(panes.map((pane) => pane.paneId))
      for (const paneId of this.runs.keys()) {
        if (paneIds.has(paneId)) continue
        this.runs.delete(paneId)
        this.publish(paneId)
        this.published.delete(paneId)
      }
      for (const paneId of this.conversations.keys()) { if (!paneIds.has(paneId)) this.conversations.delete(paneId) }
      for (const paneId of this.paneBusyTimes.keys()) { if (!paneIds.has(paneId)) this.paneBusyTimes.delete(paneId) }
      for (const pane of panes) {
        const previous = this.conversations.get(pane.paneId)
        if (previous && (previous.hostPid !== pane.hostPid || previous.sessionId !== pane.sessionId) && this.runs.has(pane.paneId)) {
          this.runs.set(pane.paneId, this.runs.get(pane.paneId)!.filter((entry) => {
            if (entry.run.state === 'running' || entry.run.state === 'quiet') return true
            if (!entry.alive) return false
            // Keep lingering processes private until exit so they aren't rediscovered.
            entry.retired = true
            return true
          }))
          this.publish(pane.paneId)
        }
        if (pane.hostPid && pane.hostPid !== previous?.hostPid) {
          this.busyAt = observedAt
          this.paneBusyTimes.delete(pane.paneId)
        }
        if (pane.hostPid && (pane.status === 'running' || pane.status === 'waiting')) {
          const busy = this.paneBusyTimes.get(pane.paneId)
          const wasBusy = previous?.status === 'running' || previous?.status === 'waiting'
          const since = wasBusy && busy ? busy.since : previous?.observedAt ?? observedAt
          this.paneBusyTimes.set(pane.paneId, { since, lastBusyAt: observedAt })
        }
        this.conversations.set(pane.paneId, { hostPid: pane.hostPid, sessionId: pane.sessionId, status: pane.status, observedAt })
      }
      const liveRuns = [...this.runs.values()].some((runs) => runs.some((entry) => entry.alive))
      if (panes.some((pane) => pane.hostPid && (pane.status === 'running' || pane.status === 'waiting'))) this.busyAt = this.now()
      if (!liveRuns && this.now() - this.busyAt > SCAN_AFTER_BUSY_MS) return
      // Failure to read ps is not evidence that every run exited.
      const rows = await this.processes()
      if (this.closed) return
      const processIndex = indexProcesses(rows)
      const now = this.now()
      await this.inspectOrphans(processIndex.agents.values(), rows, panes)
      if (this.closed) return
      const claimed = new Set([...this.runs.values()].flat().filter((entry) => entry.alive && entry.source).map((entry) => entry.source!.path))
      const chatTranscripts = panes.flatMap((pane) => pane.sessionId ? [`${pane.sessionId}.jsonl`] : [])
      let candidates: ReturnType<typeof rolloutCandidates> | undefined
      const home = this.dependencies.home ?? homedir()
      const configDirs = this.dependencies.configDirs ?? [join(home, '.claude'), join(home, '.claudep'), join(home, '.claudew'), ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : [])]
      for (const pane of panes) {
        const entries = this.runs.get(pane.paneId) ?? []
        const found = pane.panePid && pane.hostPid ? findAgentProcesses(rows, pane.panePid, pane.hostPid, processIndex) : []
        if (pane.hostPid) {
          for (const process of processIndex.agents.values()) {
            if (process.ppid === 1 && this.orphanDecisions.get(`${process.pid}:${process.startedAt}`)?.paneId === pane.paneId) found.push(process)
          }
        }
        for (const process of found) {
          if (entries.some((entry) => entry.process.pid === process.pid && sameProcess(process, entry.process))) continue
          entries.push({ process, cwd: this.orphanDecisions.get(`${process.pid}:${process.startedAt}`)?.cwd, run: { id: `external-${randomUUID()}`, runtime: process.runtime, label: process.label, model: process.model, effort: process.effort, state: 'running', startedAt: process.startedAt, updatedAt: process.startedAt }, completed: false, alive: true })
        }
        if (!entries.length) continue
        this.runs.set(pane.paneId, entries)
        for (const entry of entries) {
          if (!entry.alive) continue
          const before = JSON.stringify(entry.run)
          entry.alive = sameProcess(rows.find((row) => row.pid === entry.process.pid), entry.process)
          const readsProgress = entry.run.runtime === 'codex' || entry.run.runtime === 'claude'
          if (readsProgress && entry.run.state !== 'stopped') {
            const lookupAllowed = entry.run.runtime !== 'claude' || entry.source
              || (now >= (entry.nextTranscriptLookupAt ?? 0) && now - (entry.transcriptLookupStartedAt ?? now) < 120_000)
            if (!entry.source && lookupAllowed) {
              if (entry.run.runtime === 'claude') {
                entry.transcriptLookupStartedAt ??= now
                entry.nextTranscriptLookupAt = now + 15_000
              }
              if (!entry.cwd) {
                const cwd = await (this.dependencies.cwd ?? processCwd)(entry.process.pid).catch(() => undefined)
                if (cwd) entry.cwd = entry.process.cwdOverride ? resolve(cwd, entry.process.cwdOverride) : cwd
              }
              if (entry.cwd) {
                try {
                  if (this.dependencies.source) entry.source = await this.dependencies.source(entry.process, entry.cwd, claimed, now)
                  else if (entry.run.runtime === 'codex') {
                    candidates ??= rolloutCandidates(join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions'), now, this.rolloutCache)
                    const candidate = await matchRollout(await candidates, entry.process, entry.cwd, claimed)
                    if (candidate) entry.source = await codexSource(candidate, entry.process)
                  } else {
                    const path = await findClaudeTranscript(configDirs, entry.cwd, entry.process.startedAt, new Set([...claimed, ...chatTranscripts]), entry.process.prompt, entry.process)
                    if (path) entry.source = claudeSource(path, entry.process)
                  }
                  if (entry.source) claimed.add(entry.source.path)
                } catch { /* Missing transcripts degrade to process liveness. */ }
              }
            }
            if (entry.source) {
              const progress = await entry.source.poll().catch(() => undefined)
              if (progress) this.applyProgress(entry, progress)
            }
          }
          entry.run.runningCommand = entry.alive ? runningCommand(rows, entry.process) : undefined
          entry.run.state = runState(entry.run, entry.alive, entry.completed, now, Boolean(entry.source))
          if (entry.run.state !== 'running' && entry.run.state !== 'quiet') {
            entry.run.finishedAt ??= now
            entry.run.durationMs ??= now - entry.run.startedAt
            entry.run.runningCommand = undefined
          }
          if (before !== JSON.stringify(entry.run)) entry.run.updatedAt = now
        }
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (entries[index]!.retired && !entries[index]!.alive) entries.splice(index, 1)
        }
        // Keep live runs even if a pane briefly exceeds the finished-history cap.
        while (entries.length > 20) {
          const oldest = entries.findIndex((entry) => !entry.alive)
          if (oldest < 0) break
          entries.splice(oldest, 1)
        }
        this.publish(pane.paneId)
      }
    } catch { /* A transient process scan failure leaves the previous snapshot intact. */ }
    finally { this.polling = false }
  }

  private async inspectOrphans(agents: Iterable<AgentProcess>, rows: readonly ProcessRow[], panes: readonly WatchedPane[]): Promise<void> {
    const keys = new Set(rows.map((row) => `${row.pid}:${row.startedAt}`))
    for (const key of this.orphanDecisions.keys()) { if (!keys.has(key)) this.orphanDecisions.delete(key) }
    const tracked = new Set([...this.runs.values()].flat().map((entry) => `${entry.process.pid}:${entry.process.startedAt}`))
    const hosts = new Set(panes.flatMap((pane) => pane.hostPid ? [pane.hostPid] : []))
    if (!hosts.size) return
    const pending = [...agents].filter((process) => process.ppid === 1 && process.tty === '??' && !hosts.has(process.pid)
      && !tracked.has(`${process.pid}:${process.startedAt}`) && !this.orphanDecisions.has(`${process.pid}:${process.startedAt}`))
      .slice(0, MAX_ORPHAN_LOOKUPS_PER_POLL)
    await Promise.all(pending.map(async (process) => {
      const processPath = await (this.dependencies.cwd ?? processCwd)(process.pid).catch(() => undefined)
      if (!processPath) return
      const cwd = process.cwdOverride ? resolve(processPath, process.cwdOverride) : processPath
      const matches = panes.filter((pane) => {
        if (!pane.hostPid || !pane.cwd) return false
        const busy = this.paneBusyTimes.get(pane.paneId)
        // ps start times are rounded to seconds; allow the last idle observation's second.
        if (!busy || process.startedAt < busy.since - 1_000 || process.startedAt > busy.lastBusyAt + SCAN_AFTER_BUSY_MS) return false
        const path = relative(pane.cwd, cwd)
        return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path))
      })
      this.orphanDecisions.set(`${process.pid}:${process.startedAt}`, { cwd, ...(matches.length === 1 ? { paneId: matches[0]!.paneId } : {}) })
    }))
  }

  private applyProgress(entry: TrackedRun, progress: AgentProgress): void {
    const { completed, ...fields } = progress
    Object.assign(entry.run, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)))
    if (completed) entry.completed = true
  }

  /** Scope and process identity are checked again immediately before each signal. */
  async stop(paneId: string, runId: string): Promise<boolean> {
    const entry = this.runs.get(paneId)?.find((entry) => entry.run.id === runId)
    if (!entry || !['running', 'quiet'].includes(entry.run.state) || this.closed) return false
    const rows = await this.processes()
    if (this.closed || !['running', 'quiet'].includes(entry.run.state)) return false
    const current = rows.find((row) => row.pid === entry.process.pid)
    if (!this.dependencies.panes().some((pane) => pane.paneId === paneId) || !sameProcess(current, entry.process)) return false
    // A background shell can exit and reparent a run after we established its pane ownership.
    const target = current!.pgid === entry.process.pid ? -entry.process.pid : entry.process.pid
    this.signal(target, 'SIGINT')
    entry.run.state = 'stopped'
    entry.run.finishedAt = this.now()
    entry.run.updatedAt = this.now()
    entry.run.durationMs = entry.run.finishedAt - entry.run.startedAt
    entry.run.runningCommand = undefined
    this.publish(paneId)
    const later = this.dependencies.later ?? setTimeout
    const timer = later(() => {
      this.stopTimers.delete(timer)
      if (this.closed) return
      void this.processes().then((current) => {
        const row = current.find((row) => row.pid === entry.process.pid)
        if (!this.closed && this.dependencies.panes().some((pane) => pane.paneId === paneId) && this.runs.get(paneId)?.includes(entry) && sameProcess(row, entry.process)) {
          this.signal(row!.pgid === entry.process.pid ? -entry.process.pid : entry.process.pid, 'SIGTERM')
        }
      }).catch(() => undefined)
    }, 5_000)
    this.stopTimers.add(timer)
    return true
  }
}

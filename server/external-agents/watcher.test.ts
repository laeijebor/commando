import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAgentRun } from '../../shared/agent-chat.js'
import { ExternalAgentWatcher, QUIET_AFTER_MS, SCAN_AFTER_BUSY_MS, MAX_ORPHAN_LOOKUPS_PER_POLL, runState, type WatchedPane } from './watcher.js'
import { parseProcesses, type AgentProcess, type ProcessRow } from './process-scan.js'
import type { AgentProgress, ProgressSource } from './progress.js'

const row = (pid: number, ppid: number, command: string, startedAt = 1_000, pgid = pid, tty = '??'): ProcessRow => ({ pid, ppid, command, startedAt, pgid, tty })
const roots = [row(10, 1, '/bin/zsh'), row(20, 10, 'node commando-agent claude'), row(30, 20, 'claude -p --input-format stream-json'), row(40, 30, '/bin/bash -c launch')]
const alive = [...roots, row(50, 40, 'codex exec prompt')]
const watchers: ExternalAgentWatcher[] = []
afterEach(() => { watchers.splice(0).forEach((watcher) => watcher.close()); vi.useRealTimers(); vi.unstubAllEnvs() })

function setup(options: { runtime?: string; source?: () => Promise<ProgressSource | undefined>; pgid?: number; cwd?: (pid: number) => Promise<string | undefined> } = {}) {
  let table = options.runtime ? [...roots, row(50, 40, options.runtime, 1_000, options.pgid)] : [...alive]
  let now = 2_000
  let panes: WatchedPane[] = [{ paneId: '%1', panePid: 10, hostPid: 20, status: 'running', cwd: '/work' }]
  const publish = vi.fn()
  const signal = vi.fn()
  const processes = vi.fn(async () => table)
  const source = vi.fn(async (_process: AgentProcess, _cwd: string, _claimed: ReadonlySet<string>, _now: number) => options.source?.())
  const cwd = vi.fn(async (pid: number) => options.cwd ? options.cwd(pid) : '/work')
  const watcher = new ExternalAgentWatcher({ panes: () => panes, publish, now: () => now, processes, cwd, source, signal })
  watchers.push(watcher)
  return { watcher, publish, processes, signal, source, cwd, setTable: (rows: ProcessRow[]) => { table = rows }, setNow: (value: number) => { now = value }, setPanes: (value: WatchedPane[]) => { panes = value.map((pane) => pane.hostPid ? { status: 'running', cwd: '/work', ...pane } : pane) }, runs: () => watcher.snapshots()[0]?.runs ?? [] }
}

describe('external run states', () => {
  const run: ExternalAgentRun = { id: 'external-run', runtime: 'codex', label: 'Review', startedAt: 1_000, updatedAt: 1_000, state: 'running' }

  it('becomes quiet only with a progress source, suppressing quiet for running commands', () => {
    expect(runState(run, true, false, 1_000 + QUIET_AFTER_MS - 1, true)).toBe('running')
    expect(runState(run, true, false, 1_000 + QUIET_AFTER_MS, true)).toBe('quiet')
    expect(runState({ ...run, lastEventAt: 5_000 }, true, false, 1_000 + QUIET_AFTER_MS, true)).toBe('running')
    expect(runState({ ...run, runningCommand: { command: 'npm test', startedAt: 3_000 } }, true, false, 999_000, true)).toBe('running')
    for (const runtime of ['codex', 'claude', 'opencode', 'cursor'] as const) expect(runState({ ...run, runtime }, true, false, 999_000, false)).toBe('running')
  })

  it('distinguishes sourced Codex failure from liveness-only completion and stopping', () => {
    expect(runState(run, true, true, 2_000, true)).toBe('completed')
    expect(runState(run, false, true, 2_000, true)).toBe('completed')
    expect(runState(run, false, false, 2_000, true)).toBe('failed')
    expect(runState(run, false, false, 2_000, false)).toBe('completed')
    expect(runState({ ...run, runtime: 'claude' }, false, false, 2_000, true)).toBe('completed')
    expect(runState({ ...run, runtime: 'cursor' }, false, false, 2_000, false)).toBe('completed')
    expect(runState({ ...run, state: 'stopped' }, false, true, 2_000, true)).toBe('stopped')
  })
})

describe('external watcher', () => {
  it('uses a single process snapshot for all panes and publishes only changes', async () => {
    const env = setup()
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20 }, { paneId: '%2', panePid: 100, hostPid: 200 }])
    env.setTable([...alive, row(100, 1, 'zsh'), row(200, 100, 'node host'), row(300, 200, '/bin/sh'), row(400, 300, 'opencode run "Review another change"')])
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(1)
    expect(env.publish).toHaveBeenCalledTimes(2)
    expect(env.watcher.snapshots()[1]!.runs[0]).toMatchObject({ runtime: 'opencode', label: 'Review another change' })
    await env.watcher.poll()
    expect(env.publish).toHaveBeenCalledTimes(2)
  })

  it('skips scans without chat hosts or live runs, scans tracked live runs and cleans up removed panes', async () => {
    const env = setup()
    env.setPanes([{ paneId: '%1', panePid: 10 }])
    await env.watcher.poll()
    expect(env.processes).not.toHaveBeenCalled()
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20 }])
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(1)
    env.setPanes([{ paneId: '%1', panePid: 10 }])
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(2)
    expect(env.runs()).toHaveLength(1)
    env.setPanes([])
    env.setNow(2_000 + SCAN_AFTER_BUSY_MS + 1)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(2)
    expect(env.watcher.snapshots()).toEqual([])
    expect(env.publish).toHaveBeenLastCalledWith('%1', [])
  })

  it('publishes argv metadata until rollout metadata becomes available', async () => {
    let source: ProgressSource | undefined
    const env = setup({ runtime: 'codex exec -m gpt-6.1-sol -c model_reasoning_effort="high" prompt', source: async () => source })
    await env.watcher.poll()
    expect(env.runs()[0]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
    source = { path: '/rollout', poll: async () => ({ label: 'Review tests', model: 'rollout-model', effort: 'medium' }) }
    await env.watcher.poll()
    expect(env.runs()[0]).toMatchObject({ label: 'Review tests', model: 'rollout-model', effort: 'medium' })
  })

  it('scans running/waiting sessions or live runs, stopping after the grace period', async () => {
    const env = setup()
    env.setTable(roots)
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(1)
    env.setNow(2_000 + SCAN_AFTER_BUSY_MS + 1)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(1)
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'waiting' }])
    env.setTable(alive)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(2)
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    env.setTable(roots)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(3)
    expect(env.runs()[0]!.state).toBe('completed')
    env.setNow(2_000 + 2 * SCAN_AFTER_BUSY_MS + 1)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(4)
    env.setNow(2_000 + 2 * SCAN_AFTER_BUSY_MS + 2)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(4)
  })

  it('scans an already-running external run when an idle host first appears after restart', async () => {
    const env = setup()
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(1)
    expect(env.runs()[0]).toMatchObject({ state: 'running', startedAt: 1_000 })
  })

  it('opens a full grace period for a newly seen idle host and again when its pid changes', async () => {
    const env = setup()
    env.setTable(roots)
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    await env.watcher.poll()
    env.setNow(2_000 + SCAN_AFTER_BUSY_MS)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(2)
    env.setNow(2_000 + SCAN_AFTER_BUSY_MS + 1)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(2)
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 30, status: 'idle' }])
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(3)
  })

  it('attributes an orphan by its effective cwd and busy window, caching the cwd lookup', async () => {
    const env = setup({ cwd: async () => '/work/original' })
    env.setTable([...roots, row(60, 1, 'codex exec -C ../project prompt', 2_000)])
    await env.watcher.poll()
    expect(env.runs()).toHaveLength(1)
    expect(env.runs()[0]).toMatchObject({ runtime: 'codex', state: 'running' })
    expect(env.source).toHaveBeenCalledWith(expect.objectContaining({ pid: 60 }), '/work/project', expect.any(Set), 2_000)
    await env.watcher.poll()
    expect(env.cwd.mock.calls).toEqual([[60]])
  })

  it('scans newly seen and changed idle hosts without opening orphan attribution windows', async () => {
    const env = setup()
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    env.setTable([...roots, row(60, 1, 'codex exec prompt', 2_000)])
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(1)
    expect(env.runs()).toEqual([])
    env.setNow(3_000)
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 30, status: 'idle' }])
    env.setTable([...roots, row(61, 1, 'codex exec prompt', 3_000)])
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(2)
    expect(env.runs()).toEqual([])
  })

  it('rejects an orphan with a controlling terminal in a busy pane cwd', async () => {
    const env = setup()
    env.setTable([...roots, row(60, 1, 'codex exec prompt', 2_000, 60, 'ttys001')])
    await env.watcher.poll()
    expect(env.runs()).toEqual([])
    expect(env.cwd).not.toHaveBeenCalled()
  })

  it.each(['?', '??'])('attributes a detached orphan parsed from ps with tty %s', async (tty) => {
    const env = setup()
    const orphan = parseProcesses(`60 1 60 ${tty} Tue Oct 13 07:30:10 2026 codex exec prompt\n`)[0]!
    env.setNow(orphan.startedAt)
    env.setTable([...roots, orphan])
    await env.watcher.poll()
    expect(env.runs()).toHaveLength(1)
    expect(env.cwd.mock.calls).toEqual([[60]])
  })

  it('includes a fast launch between the last idle observation and the first busy observation', async () => {
    const env = setup()
    env.setTable(roots)
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    await env.watcher.poll()
    env.setNow(6_000)
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'running' }])
    env.setTable([...roots, row(60, 1, 'codex exec prompt', 3_000)])
    await env.watcher.poll()
    expect(env.runs()).toHaveLength(1)
  })

  it.each(['undefined', 'error'])('retries an orphan cwd lookup after %s instead of caching the failure', async (failure) => {
    let available = false
    const env = setup({ cwd: async () => {
      if (available) return '/work'
      if (failure === 'error') throw new Error('lsof unavailable')
      return undefined
    } })
    env.setTable([...roots, row(60, 1, 'codex exec prompt', 2_000)])
    await env.watcher.poll()
    expect(env.runs()).toEqual([])
    available = true
    await env.watcher.poll()
    expect(env.runs()).toHaveLength(1)
    expect(env.cwd.mock.calls).toEqual([[60], [60]])
  })

  it('attributes an orphan started within the grace period after a turn finishes', async () => {
    const env = setup()
    env.setTable(roots)
    await env.watcher.poll()
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    env.setNow(20_000)
    env.setTable([...roots, row(60, 1, 'codex exec prompt', 20_000)])
    await env.watcher.poll()
    expect(env.runs()).toHaveLength(1)
  })

  it('ignores an orphan started long after its pane was busy', async () => {
    const env = setup()
    await env.watcher.poll()
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    env.setNow(100_000)
    env.setTable([...alive, row(60, 1, 'codex exec prompt', 100_000)])
    await env.watcher.poll()
    expect(env.runs()).toHaveLength(1)
    expect(env.cwd.mock.calls.filter(([pid]) => pid === 60)).toHaveLength(1)
  })

  it('skips ambiguous orphans and caches the decision for two busy panes in the same cwd', async () => {
    const env = setup()
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20 }, { paneId: '%2', panePid: 100, hostPid: 200 }])
    env.setTable([...roots, row(60, 1, 'codex exec prompt', 2_000)])
    await env.watcher.poll()
    await env.watcher.poll()
    expect(env.watcher.snapshots()).toEqual([])
    expect(env.cwd.mock.calls).toEqual([[60]])
  })

  it("uses each pane's busy time when choosing among panes in the same cwd", async () => {
    const env = setup()
    env.setTable(roots)
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'running' }, { paneId: '%2', panePid: 100, hostPid: 200, status: 'idle' }])
    await env.watcher.poll()
    env.setNow(100_000)
    env.setTable([...roots, row(60, 1, 'codex exec prompt', 100_000)])
    await env.watcher.poll()
    expect(env.watcher.snapshots()).toEqual([{ paneId: '%1', runs: [expect.objectContaining({ runtime: 'codex' })] }])
  })

  it('bounds orphan cwd lookups per poll and inspects reused pids again', async () => {
    const env = setup({ cwd: async () => '/unrelated' })
    const orphans = Array.from({ length: MAX_ORPHAN_LOOKUPS_PER_POLL + 2 }, (_, index) => row(60 + index, 1, 'codex exec prompt', 2_000))
    env.setTable([...roots, ...orphans])
    await env.watcher.poll()
    expect(env.cwd).toHaveBeenCalledTimes(MAX_ORPHAN_LOOKUPS_PER_POLL)
    await env.watcher.poll()
    expect(env.cwd).toHaveBeenCalledTimes(orphans.length)
    await env.watcher.poll()
    expect(env.cwd).toHaveBeenCalledTimes(orphans.length)
    env.setNow(3_000)
    env.setTable([...roots, row(60, 1, 'codex exec prompt', 3_000)])
    await env.watcher.poll()
    expect(env.cwd).toHaveBeenCalledTimes(orphans.length + 1)
  })

  it('keeps failed orphan retries within the per-poll lookup cap', async () => {
    const env = setup({ cwd: async () => undefined })
    env.setTable([...roots, ...Array.from({ length: MAX_ORPHAN_LOOKUPS_PER_POLL + 2 }, (_, index) => row(60 + index, 1, 'codex exec prompt', 2_000))])
    await env.watcher.poll()
    expect(env.cwd).toHaveBeenCalledTimes(MAX_ORPHAN_LOOKUPS_PER_POLL)
    await env.watcher.poll()
    expect(env.cwd).toHaveBeenCalledTimes(2 * MAX_ORPHAN_LOOKUPS_PER_POLL)
    expect(env.runs()).toEqual([])
  })

  it('does not attribute an orphan to a sibling cwd or an unrelated process', async () => {
    const env = setup({ cwd: async () => '/work-other' })
    env.setTable([...roots, row(60, 1, 'codex exec prompt', 2_000), row(70, 1, 'npm test', 2_000)])
    await env.watcher.poll()
    expect(env.runs()).toEqual([])
    expect(env.cwd.mock.calls).toEqual([[60]])
  })

  it('fails sourced Codex on exit without completion and never ships the process command', async () => {
    const env = setup({ source: async () => ({ path: '/rollout', poll: async () => ({}) }) })
    await env.watcher.poll()
    expect(env.runs()[0]).not.toHaveProperty('command')
    expect(env.publish.mock.calls[0]![1][0]).not.toHaveProperty('command')
    env.setTable(roots)
    await env.watcher.poll()
    expect(env.runs()[0]!.state).toBe('failed')
  })

  it('backs off missing Claude transcripts for fifteen seconds and gives up after two minutes', async () => {
    const env = setup({ runtime: 'claude -p "Review tests"' })
    const attempts = [2_000, 17_000, 32_000, 47_000, 62_000, 77_000, 92_000, 107_000]
    for (let now = 2_000; now <= 137_000; now += 1_000) {
      env.setNow(now)
      await env.watcher.poll()
    }
    expect(env.source.mock.calls.map((call) => call[3])).toEqual(attempts)
    env.setNow(999_000)
    await env.watcher.poll()
    expect(env.source).toHaveBeenCalledTimes(attempts.length)
    expect(env.runs()[0]!.state).toBe('running')
  })

  it.each(['sessionId', 'hostPid'] as const)('drops finished history when %s changes, keeping live runs', async (key) => {
    const env = setup()
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, sessionId: 'old' }])
    await env.watcher.poll()
    env.setTable([...roots, row(60, 40, 'codex exec second')])
    await env.watcher.poll()
    expect(env.runs()).toHaveLength(2)
    expect(env.runs()[0]!.state).toBe('completed')
    const liveId = env.runs()[1]!.id
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, sessionId: 'old', [key]: key === 'sessionId' ? 'new' : 30 }])
    await env.watcher.poll()
    expect(env.runs()).toHaveLength(1)
    expect(env.runs()[0]).toMatchObject({ id: liveId, state: 'running' })
  })

  it('hides a finished row whose process lingers across a conversation change without rediscovering it', async () => {
    const env = setup({ source: async () => ({ path: '/rollout', poll: async () => ({ completed: true }) }) })
    await env.watcher.poll()
    expect(env.runs()[0]!.state).toBe('completed')
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, sessionId: 'new' }])
    await env.watcher.poll()
    expect(env.runs()).toEqual([])
    await env.watcher.poll()
    expect(env.runs()).toEqual([])
    env.setTable(roots)
    await env.watcher.poll()
    expect(env.runs()).toEqual([])
  })

  it('keeps a liveness-only run running past the quiet threshold', async () => {
    const env = setup()
    await env.watcher.poll()
    env.setNow(QUIET_AFTER_MS + 20_000)
    await env.watcher.poll()
    expect(env.runs()[0]!.state).toBe('running')
  })

  it('tracks quiet, progress recovery and running descendants with an injected clock', async () => {
    let progress: AgentProgress = { toolUses: 1, lastEventAt: 2_000 }
    const env = setup({ source: async () => ({ path: '/rollout', poll: async () => progress }) })
    await env.watcher.poll()
    env.setNow(2_000 + QUIET_AFTER_MS)
    await env.watcher.poll()
    expect(env.runs()[0]!.state).toBe('quiet')
    env.setTable([...alive, row(51, 50, '/bin/zsh -lc "npm test"', 150_000)])
    await env.watcher.poll()
    expect(env.runs()[0]).toMatchObject({ state: 'running', runningCommand: { command: 'npm test', startedAt: 150_000 } })
    env.setTable(alive)
    progress = { toolUses: 2, lastEventAt: 2_000 + QUIET_AFTER_MS, lastAction: '$ npm test' }
    await env.watcher.poll()
    expect(env.runs()[0]).toMatchObject({ state: 'running', toolUses: 2, lastAction: '$ npm test' })
  })

  it('tails one final time on exit, keeping completion and summaries for the pane lifetime', async () => {
    let progress: AgentProgress = { label: 'Review tests' }
    const env = setup({ source: async () => ({ path: '/rollout', poll: async () => progress }) })
    await env.watcher.poll()
    env.setTable(roots)
    env.setNow(9_000)
    progress = { completed: true, durationMs: 8_000, summary: 'Tests passed.' }
    await env.watcher.poll()
    expect(env.runs()[0]).toMatchObject({ state: 'completed', label: 'Review tests', durationMs: 8_000, summary: 'Tests passed.', finishedAt: 9_000 })
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    await env.watcher.poll()
    expect(env.runs()).toHaveLength(1)
    env.setPanes([])
    await env.watcher.poll()
    expect(env.watcher.snapshots()).toEqual([])
    expect(env.publish).toHaveBeenLastCalledWith('%1', [])
  })

  it('completes liveness-only runtimes on exit, including unmatched Codex', async () => {
    for (const command of ['codex exec prompt', 'claude -p prompt', 'opencode run prompt', 'agent -p prompt']) {
      const env = setup({ runtime: command })
      await env.watcher.poll()
      env.setTable(roots)
      await env.watcher.poll()
      expect(env.runs()[0]!.state).toBe('completed')
    }
  })

  it('keeps the snapshot on a failed scan, retries missing progress and rejects reused pids', async () => {
    const env = setup()
    env.processes.mockRejectedValueOnce(new Error('ps unavailable'))
    await env.watcher.poll()
    expect(env.publish).not.toHaveBeenCalled()
    await env.watcher.poll()
    await env.watcher.poll()
    expect(env.source).toHaveBeenCalledTimes(2)
    const old = env.runs()[0]!.id
    env.setTable([...roots, row(50, 40, 'codex exec prompt', 10_000)])
    await env.watcher.poll()
    expect(env.runs()).toHaveLength(2)
    expect(env.runs()[0]).toMatchObject({ id: old, state: 'completed' })
    expect(env.runs()[1]!.id).not.toBe(old)
  })

  it('retains only the newest twenty finished runs', async () => {
    const env = setup()
    for (let index = 0; index < 25; index += 1) {
      env.setTable([...roots, row(50 + index, 40, 'codex exec prompt', 1_000 + index)])
      await env.watcher.poll()
      env.setTable(roots)
      await env.watcher.poll()
    }
    expect(env.runs()).toHaveLength(20)
    expect(env.runs()[0]!.startedAt).toBe(1_005)
  })

  it.each(['-C /work/example', '--cd /work/example', '-C=/work/example', '--cd=/work/example', '-C ../example'])('matches a captured rollout using cwd override %s', async (flags) => {
    const home = await mkdtemp(join(tmpdir(), 'external-watcher-'))
    try {
      const startedAt = Date.parse('2026-10-13T06:30:10.000Z')
      const dir = join(home, '.codex', 'sessions', '2026', '10', '13')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'rollout-example.jsonl'), await readFile(new URL('./fixtures/codex-exec.jsonl', import.meta.url)))
      const publish = vi.fn()
      const watcher = new ExternalAgentWatcher({
        home, configDirs: [], panes: () => [{ paneId: '%1', panePid: 10, hostPid: 20, status: 'running' }],
        processes: async () => [...roots, row(50, 40, `codex exec ${flags} prompt`, startedAt)],
        cwd: async () => '/work/original', now: () => startedAt + 310_000, publish,
      })
      watchers.push(watcher)
      await watcher.poll()
      expect(publish).toHaveBeenCalledWith('%1', [expect.objectContaining({ label: 'Review the sample change.', model: 'gpt-5.6-terra', effort: 'medium', toolUses: 1, state: 'completed', summary: 'Review finished.' })])
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  it('uses CODEX_HOME when looking up sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'external-codex-home-'))
    try {
      const codexHome = join(home, 'custom-codex')
      vi.stubEnv('CODEX_HOME', codexHome)
      const startedAt = Date.parse('2026-10-13T06:30:10Z')
      const dir = join(codexHome, 'sessions', '2026', '10', '13')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'rollout-example.jsonl'), await readFile(new URL('./fixtures/codex-exec.jsonl', import.meta.url)))
      const watcher = new ExternalAgentWatcher({
        home, panes: () => [{ paneId: '%1', panePid: 10, hostPid: 20, status: 'running' }], publish: vi.fn(),
        processes: async () => [...roots, row(50, 40, 'codex exec prompt', startedAt)],
        cwd: async () => '/work/example', now: () => startedAt + 310_000,
      })
      watchers.push(watcher)
      await watcher.poll()
      expect(watcher.snapshots()[0]!.runs[0]).toMatchObject({ label: 'Review the sample change.', state: 'completed', toolUses: 1 })
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  it('attaches an older Codex resume rollout after skipping options before the subcommand', async () => {
    const home = await mkdtemp(join(tmpdir(), 'external-codex-resume-'))
    try {
      const id = '00000000-0000-4000-8000-000000000001'
      const startedAt = Date.parse('2026-10-13T06:30:10Z')
      const dir = join(home, '.codex', 'sessions', '2025', '09', '03')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `rollout-example-${id}.jsonl`), [
        { timestamp: '2025-09-03T06:30:10Z', type: 'session_meta', payload: { id, cwd: '/work/example', originator: 'codex_exec' } },
        { timestamp: '2025-09-03T06:31:10Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Old completion' } },
        { timestamp: new Date(startedAt).toISOString(), type: 'turn_context', payload: { model: 'resumed-model', effort: 'high' } },
        { timestamp: new Date(startedAt).toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Review new changes' }] } } },
        { timestamp: new Date(startedAt + 1_000).toISOString(), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'npm test'] } } },
      ].map((line) => JSON.stringify(line) + '\n').join(''))
      const watcher = new ExternalAgentWatcher({
        home, panes: () => [{ paneId: '%1', panePid: 10, hostPid: 20, status: 'running' }], publish: vi.fn(),
        processes: async () => [...roots, row(50, 40, `codex exec --json --cd=/work/example resume ${id} "Review new changes"`, startedAt)],
        cwd: async () => '/work/original', now: () => startedAt + 2_000,
      })
      watchers.push(watcher)
      await watcher.poll()
      expect(watcher.snapshots()[0]!.runs[0]).toMatchObject({ label: 'Review new changes', model: 'resumed-model', effort: 'high', toolUses: 1, lastAction: '$ npm test', state: 'running' })
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  it('connects a resumed Claude process to its old transcript and counts only the resumed turn', async () => {
    const config = await mkdtemp(join(tmpdir(), 'external-claude-resume-'))
    try {
      const project = join(config, 'projects', '-work-example')
      await mkdir(project, { recursive: true })
      await writeFile(join(project, 'old-session.jsonl'), [
        { type: 'user', timestamp: new Date(0).toISOString(), message: { content: 'Old prompt' } },
        { type: 'user', timestamp: new Date(3_000).toISOString(), message: { content: 'Review new changes' } },
        { type: 'assistant', timestamp: new Date(3_000).toISOString(), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
      ].map((line) => JSON.stringify(line) + '\n').join(''))
      const watcher = new ExternalAgentWatcher({
        panes: () => [{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }], publish: vi.fn(), configDirs: [config],
        processes: async () => [...roots, row(50, 40, 'claude -p --resume old-session "Review new changes"', 2_000)],
        cwd: async () => '/work/example', now: () => 3_000,
      })
      watchers.push(watcher)
      await watcher.poll()
      expect(watcher.snapshots()[0]!.runs[0]).toMatchObject({ runtime: 'claude', label: 'Review new changes', toolUses: 1, lastAction: '$ npm test' })
    } finally { await rm(config, { recursive: true, force: true }) }
  })

  it("finds a claude -p transcript in its chat's custom profile directory", async () => {
    const home = await mkdtemp(join(tmpdir(), 'external-claude-profile-'))
    try {
      const config = join(home, '.claude-work')
      const project = join(config, 'projects', '-work-example')
      await mkdir(project, { recursive: true })
      await writeFile(join(project, 'old-session.jsonl'), [
        { type: 'user', timestamp: new Date(3_000).toISOString(), message: { content: 'Review new changes' } },
        { type: 'assistant', timestamp: new Date(3_000).toISOString(), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
      ].map((line) => JSON.stringify(line) + '\n').join(''))
      const watcher = new ExternalAgentWatcher({
        home, panes: () => [{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle', configDir: config }], publish: vi.fn(),
        processes: async () => [...roots, row(50, 40, 'claude -p --resume old-session "Review new changes"', 2_000)],
        cwd: async () => '/work/example', now: () => 3_000,
      })
      watchers.push(watcher)
      await watcher.poll()
      expect(watcher.snapshots()[0]!.runs[0]).toMatchObject({ runtime: 'claude', toolUses: 1, lastAction: '$ npm test' })
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  it('excludes every pane chat session from Claude continuation matching', async () => {
    const config = await mkdtemp(join(tmpdir(), 'external-claude-continue-'))
    try {
      const project = join(config, 'projects', '-work-example')
      await mkdir(project, { recursive: true })
      for (const [id, modifiedAt, command] of [['external-session', 3_000, 'npm test'], ['parent-session', 4_000, 'parent command'], ['other-pane-session', 5_000, 'other pane command']] as const) {
        const path = join(project, `${id}.jsonl`)
        await writeFile(path, [
          { type: 'user', timestamp: new Date(0).toISOString(), message: { content: 'Old prompt' } },
          { type: 'user', timestamp: new Date(2_000).toISOString(), message: { content: 'Review new changes' } },
          { type: 'assistant', timestamp: new Date(3_000).toISOString(), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } },
        ].map((line) => JSON.stringify(line) + '\n').join(''))
        await utimes(path, new Date(modifiedAt), new Date(modifiedAt))
      }
      const watcher = new ExternalAgentWatcher({
        panes: () => [
          { paneId: '%1', panePid: 10, hostPid: 20, status: 'running', sessionId: 'parent-session' },
          { paneId: '%2', sessionId: 'other-pane-session' },
        ], publish: vi.fn(), configDirs: [config],
        processes: async () => [...roots, row(50, 40, 'claude -c -p "Review new changes"', 2_000)],
        cwd: async () => '/work/example', now: () => 3_000,
      })
      watchers.push(watcher)
      await watcher.poll()
      expect(watcher.snapshots()[0]!.runs[0]).toMatchObject({ label: 'Review new changes', toolUses: 1, lastAction: '$ npm test' })
    } finally { await rm(config, { recursive: true, force: true }) }
  })

  it('claims matched rollouts across live runs', async () => {
    const env = setup({ source: async () => ({ path: '/rollout', poll: async () => ({}) }) })
    env.setTable([...alive, row(60, 40, 'codex exec second')])
    await env.watcher.poll()
    expect(env.source.mock.calls[1]![2]).toEqual(new Set(['/rollout']))
  })
})

describe('Stop', () => {
  it.each([[50, -50], [40, 50]])('signals pgid %s as %s, escalating after five seconds', async (pgid, target) => {
    vi.useFakeTimers()
    const env = setup({ runtime: 'codex exec prompt', pgid })
    await env.watcher.poll()
    const id = env.runs()[0]!.id
    expect(await env.watcher.stop('%2', id)).toBe(false)
    expect(env.signal).not.toHaveBeenCalled()
    expect(await env.watcher.stop('%1', id)).toBe(true)
    expect(env.signal).toHaveBeenCalledExactlyOnceWith(target, 'SIGINT')
    expect(env.runs()[0]!.state).toBe('stopped')
    expect(await env.watcher.stop('%1', id)).toBe(false)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(env.signal).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(env.signal).toHaveBeenLastCalledWith(target, 'SIGTERM')
    env.setTable(roots)
    await env.watcher.poll()
    expect(env.runs()[0]!.state).toBe('stopped')
  })

  it.each(['exit', 'reuse', 'remove', 'close'])('does not escalate after %s', async (change) => {
    vi.useFakeTimers()
    const env = setup()
    await env.watcher.poll()
    await env.watcher.stop('%1', env.runs()[0]!.id)
    if (change === 'exit') env.setTable(roots)
    if (change === 'reuse') env.setTable([...roots, row(50, 40, 'codex exec prompt', 99_000)])
    if (change === 'remove') { env.setPanes([]); await env.watcher.poll() }
    if (change === 'close') env.watcher.close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(env.signal).toHaveBeenCalledTimes(1)
  })

  it('rechecks process identity before sending the initial signal', async () => {
    const env = setup()
    await env.watcher.poll()
    env.setTable([...roots, row(50, 1, 'codex exec prompt', 99_000)])
    expect(await env.watcher.stop('%1', env.runs()[0]!.id)).toBe(false)
    expect(env.signal).not.toHaveBeenCalled()
  })

  it('can stop a known run after its launching shell exited and it was reparented', async () => {
    vi.useFakeTimers()
    const env = setup()
    await env.watcher.poll()
    env.setTable([...roots, row(50, 1, 'codex exec prompt')])
    expect(await env.watcher.stop('%1', env.runs()[0]!.id)).toBe(true)
    expect(env.signal).toHaveBeenCalledExactlyOnceWith(-50, 'SIGINT')
  })

})

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAgentRun } from '../../shared/agent-chat.js'
import { ExternalAgentWatcher, QUIET_AFTER_MS, SCAN_AFTER_BUSY_MS, runState, type WatchedPane } from './watcher.js'
import type { AgentProcess, ProcessRow } from './process-scan.js'
import type { AgentProgress, ProgressSource } from './progress.js'

const row = (pid: number, ppid: number, command: string, startedAt = 1_000, pgid = pid): ProcessRow => ({ pid, ppid, command, startedAt, pgid })
const roots = [row(10, 1, '/bin/zsh'), row(20, 10, 'node commando-agent claude'), row(30, 20, 'claude -p --input-format stream-json'), row(40, 30, '/bin/bash -c launch')]
const alive = [...roots, row(50, 40, 'codex exec prompt')]
const watchers: ExternalAgentWatcher[] = []
afterEach(() => { watchers.splice(0).forEach((watcher) => watcher.close()); vi.useRealTimers(); vi.unstubAllEnvs() })

function setup(options: { runtime?: string; source?: () => Promise<ProgressSource | undefined>; pgid?: number } = {}) {
  let table = options.runtime ? [...roots, row(50, 40, options.runtime, 1_000, options.pgid)] : [...alive]
  let now = 2_000
  let panes: WatchedPane[] = [{ paneId: '%1', panePid: 10, hostPid: 20, status: 'running' }]
  const publish = vi.fn()
  const signal = vi.fn()
  const processes = vi.fn(async () => table)
  const source = vi.fn(async (_process: AgentProcess, _cwd: string, _claimed: ReadonlySet<string>, _now: number) => options.source?.())
  const watcher = new ExternalAgentWatcher({ panes: () => panes, publish, now: () => now, processes, cwd: async () => '/work', source, signal })
  watchers.push(watcher)
  return { watcher, publish, processes, signal, source, setTable: (rows: ProcessRow[]) => { table = rows }, setNow: (value: number) => { now = value }, setPanes: (value: WatchedPane[]) => { panes = value.map((pane) => pane.hostPid ? { status: 'running', ...pane } : pane) }, runs: () => watcher.snapshots()[0]?.runs ?? [] }
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

  it('scans running/waiting sessions or live runs, stopping once only finished history remains', async () => {
    const env = setup()
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    await env.watcher.poll()
    expect(env.processes).not.toHaveBeenCalled()
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'waiting' }])
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(1)
    env.setPanes([{ paneId: '%1', panePid: 10, hostPid: 20, status: 'idle' }])
    env.setTable(roots)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(2)
    expect(env.runs()[0]!.state).toBe('completed')
    // A turn that launched a run and went idle between polls is still scanned for a while.
    env.setNow(2_000 + SCAN_AFTER_BUSY_MS)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(3)
    env.setNow(2_000 + SCAN_AFTER_BUSY_MS + 1)
    await env.watcher.poll()
    expect(env.processes).toHaveBeenCalledTimes(3)
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

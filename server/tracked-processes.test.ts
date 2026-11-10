import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProcessTracker,
  TrackedProcessScopeError,
  TrackedProcessStore,
  parseEnvironTag,
  parseMacEnvironmentTags,
  parseProcessTable,
  parseStartTimes,
  processKey,
  shortenCommand,
  stopMembers,
  trackProcesses,
  type LivePane,
  type ProcessRow,
  type TrackInput,
} from './tracked-processes.js'

const SOCKET = '/private/tmp/tmux-501/commando'
const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime()
const OLD = NOW - 60_000

function row(pid: number, ppid: number, command: string, extra: Partial<ProcessRow> = {}): ProcessRow {
  return { pid, ppid, pgid: pid, tpgid: 0, uid: 501, tty: '??', cpuPercent: 0, rssKb: 1_000, startedAt: OLD, command, ...extra }
}

const pane: LivePane = { paneId: '%3', processId: 100, sessionId: '$1', sessionName: 'Work', targetId: '11111111-1111-4111-8111-111111111111' }

function input(rows: ProcessRow[], overrides: Partial<TrackInput> = {}): TrackInput {
  return {
    rows: [row(1, 0, '/sbin/launchd'), row(50, 1, 'tmux new-session'), ...rows],
    tags: new Map(), listeners: [], livePanes: [pane], server: { socketPath: SOCKET, serverPid: 50 },
    remembered: new Map(), paneRecords: new Map(), daemonPid: 9_000, protectedPorts: new Set([4310]), now: NOW,
    ...overrides,
  }
}

describe('process table parsing', () => {
  it('reads macOS and Linux ps rows with their start times', () => {
    const rows = parseProcessTable([
      '  100    50   100   200   501 ttys003   0.0   2048 Mon Nov  9 11:59:00 2026     -zsh',
      '  201   100   201    -1  1000 ?        12.5 900000 Mon Nov  9 09:05:07 2026     /usr/bin/node /srv/app/vite.js --port 5173',
      'garbage line',
    ].join('\n'))
    expect(rows).toEqual([
      { pid: 100, ppid: 50, pgid: 100, tpgid: 200, uid: 501, tty: 'ttys003', cpuPercent: 0, rssKb: 2048, startedAt: new Date(2026, 10, 9, 11, 59, 0).getTime(), command: '-zsh' },
      { pid: 201, ppid: 100, pgid: 201, tpgid: -1, uid: 1000, tty: '?', cpuPercent: 12.5, rssKb: 900000, startedAt: new Date(2026, 10, 9, 9, 5, 7).getTime(), command: '/usr/bin/node /srv/app/vite.js --port 5173' },
    ])
    expect(parseStartTimes('  201 Mon Nov  9 09:05:07 2026    \n')).toEqual(new Map([[201, new Date(2026, 10, 9, 9, 5, 7).getTime()]]))
  })

  it('finds this socket’s pane in macOS ps -E output, letting the environment win over arguments', () => {
    const output = [
      `  300 node server.js TMUX_PANE=%9 HOME=/Users/me TMUX=${SOCKET},50,0 TMUX_PANE=%3`,
      `  301 python3 -m http.server TMUX=/private/tmp/tmux-501/default,77,0 TMUX_PANE=%3`,
      `  302 node TMUX=${SOCKET}-other,50,0 TMUX_PANE=%3`,
      '  303 /bin/sleep 9999',
      `  304 echo TMUX_PANE=%4 TMUX=${SOCKET},50,1`,
    ].join('\n')
    expect(parseMacEnvironmentTags(output, SOCKET)).toEqual(new Map([
      [300, { paneId: '%3', serverPid: 50 }],
      [304, { paneId: '%4', serverPid: 50 }],
    ]))
  })

  it('reads Linux environ files', () => {
    expect(parseEnvironTag(`HOME=/root\0TMUX=${SOCKET},50,2\0TMUX_PANE=%7\0`, SOCKET)).toEqual({ paneId: '%7', serverPid: 50 })
    expect(parseEnvironTag(`TMUX=/tmp/other,50,2\0TMUX_PANE=%7\0`, SOCKET)).toBeNull()
    expect(parseEnvironTag(`TMUX=${SOCKET},50,2\0`, SOCKET)).toBeNull()
  })

  it('shortens long paths but keeps arguments', () => {
    expect(shortenCommand('/Users/me/.nvm/versions/node/v24/bin/node /Users/me/project/node_modules/vite/bin/vite.js --port 5173'))
      .toBe('node …/bin/vite.js --port 5173')
  })
})

describe('tracking processes', () => {
  it('lists background and detached processes but not the pane shell, its agent or the agent’s helpers', () => {
    const rows = [
      row(100, 50, '-zsh', { pgid: 100, tpgid: 110, tty: 'ttys003' }),
      // The agent: a wrapper and the CLI in the pane's foreground process group.
      row(110, 100, 'node agent-host claude', { pgid: 110, tty: 'ttys003' }),
      row(111, 110, 'claude', { pgid: 110, tty: 'ttys003' }),
      // MCP servers: one in the job, one in its own group but on the pane terminal, and a watchdog off the agent's chain.
      row(112, 111, 'npm exec mcp', { pgid: 110, tty: 'ttys003' }),
      row(113, 112, 'mcp', { pgid: 110, tty: 'ttys003' }),
      row(114, 113, 'node watchdog.js', { pgid: 114 }),
      row(115, 111, 'node argent mcp', { pgid: 115, tty: 'ttys003' }),
      row(116, 111, 'node docs-mcp', { pgid: 110, tty: 'ttys003' }),
      // A command the agent runs in the background, detached from the terminal.
      row(120, 111, 'zsh -c npm run dev', { pgid: 120 }),
      row(121, 120, 'node vite --port 5173', { pgid: 120, cpuPercent: 3 }),
      row(122, 121, 'esbuild --service', { pgid: 120, cpuPercent: 1.5 }),
      // nohup'd and reparented to launchd: only its environment links it to the pane.
      row(130, 1, 'python3 -m http.server 4499'),
      // Not old enough to be worth listing.
      row(140, 111, 'git status', { pgid: 140, startedAt: NOW - 1_000 }),
      // Another tmux server's process.
      row(150, 1, 'node other'),
    ]
    const result = trackProcesses(input(rows, {
      tags: new Map([[130, { paneId: '%3', serverPid: 50 }]]),
      listeners: [{ processId: 121, processName: 'node', port: 5173 }, { processId: 130, processName: 'python3', port: 4499 }],
    }))
    expect(result.processes.map(({ pid, command, childCount, detached, ports, cpuPercent }) => ({ pid, command, childCount, detached, ports, cpuPercent }))).toEqual([
      { pid: 120, command: 'node vite --port 5173', childCount: 2, detached: false, ports: [5173], cpuPercent: 4.5 },
      { pid: 130, command: 'python3 -m http.server 4499', childCount: 0, detached: true, ports: [4499], cpuPercent: 0 },
    ])
    expect(result.processes[0]).toMatchObject({ paneId: '%3', paneOpen: true, sessionId: '$1', sessionName: 'Work', targetId: pane.targetId })
    expect(result.members.get(processKey(rows.find(({ pid }) => pid === 120)!))?.map(({ pid }) => pid).sort()).toEqual([120, 121, 122])
    // Everything that belongs to the pane is remembered, so it stays tracked once it leaves the tree.
    expect([...result.remembered.keys()]).toContain(processKey(rows.find(({ pid }) => pid === 120)!))
    expect([...result.remembered.keys()]).toContain(processKey(rows[1]))
  })

  it('lists an idle shell’s background jobs', () => {
    const result = trackProcesses(input([
      row(100, 50, '-zsh', { pgid: 100, tpgid: 100, tty: 'ttys003' }),
      row(101, 100, 'sleep 9999', { pgid: 101, tty: 'ttys003' }),
    ]))
    expect(result.processes.map(({ pid }) => pid)).toEqual([101])
  })

  it('keeps following a process without a readable environment by pid and start time', () => {
    const sleeper = row(160, 1, '/bin/sleep 9999')
    const closed = { ...input([sleeper]), livePanes: [] }
    const remembered = new Map([[processKey(sleeper), '50:%3']])
    const paneRecords = new Map([['50:%3', { sessionId: '$1', sessionName: 'Work', targetId: pane.targetId }]])
    expect(trackProcesses({ ...closed, remembered, paneRecords }).processes).toMatchObject([
      { pid: 160, detached: true, paneOpen: false, targetId: pane.targetId, sessionName: 'Work' },
    ])
    // The same pid started at another time is a different process.
    const reused = { ...sleeper, startedAt: OLD + 5_000 }
    expect(trackProcesses({ ...closed, rows: [...closed.rows.slice(0, 2), reused], remembered, paneRecords }).processes).toEqual([])
  })

  it('never tracks the daemon, what it runs, the tmux server or protected port listeners', () => {
    const rows = [
      row(100, 50, '-zsh', { pgid: 100, tpgid: 100, tty: 'ttys003' }),
      row(8_000, 100, 'npm run dev', { pgid: 8_000 }),
      row(9_000, 8_000, 'node server/index.ts', { pgid: 8_000 }),
      row(9_001, 9_000, 'ps -axwwE', { pgid: 8_000 }),
      row(8_500, 100, 'vite', { pgid: 8_500 }),
    ]
    const tags = new Map([[50, { paneId: '%3', serverPid: 50 }], [9_000, { paneId: '%3', serverPid: 50 }]])
    const result = trackProcesses(input(rows, { tags, listeners: [{ processId: 8_500, processName: 'node', port: 4310 }] }))
    expect(result.processes).toEqual([])
  })
})

describe('stopping processes', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends TERM, then KILL after the grace period, only to processes whose start time still matches', async () => {
    const signals: [number, string][] = []
    const live = new Map([[201, OLD], [202, OLD], [203, OLD + 9_000]])
    const result = await stopMembers(
      [{ pid: 201, startedAt: OLD }, { pid: 202, startedAt: OLD }, { pid: 203, startedAt: OLD }, { pid: 204, startedAt: OLD }],
      {
        signal: (pid, signal) => {
          signals.push([pid, signal])
          if (signal === 'SIGTERM' && pid === 201) live.delete(201)
        },
        startTimes: async (pids) => new Map(pids.flatMap((pid) => live.has(pid) ? [[pid, live.get(pid)!] as const] : [])),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        graceMs: 3_000,
      },
    )
    // 203 is a different process that reused the pid; 204 is gone.
    expect(result.terminated).toBe(2)
    expect(signals).toEqual([[201, 'SIGTERM'], [202, 'SIGTERM']])
    await vi.advanceTimersByTimeAsync(2_999)
    expect(signals).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result.finished).resolves.toBe(1)
    expect(signals).toEqual([[201, 'SIGTERM'], [202, 'SIGTERM'], [202, 'SIGKILL']])
  })

  it('finishes as soon as everything has exited after TERM', async () => {
    const live = new Map([[201, OLD]])
    const signal = vi.fn((pid: number) => { live.delete(pid) })
    const result = await stopMembers([{ pid: 201, startedAt: OLD }], {
      signal, startTimes: async (pids) => new Map(pids.flatMap((pid) => live.has(pid) ? [[pid, live.get(pid)!] as const] : [])),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    await vi.advanceTimersByTimeAsync(250)
    await expect(result.finished).resolves.toBe(0)
    expect(signal.mock.calls).toEqual([[201, 'SIGTERM']])
  })

  it('ignores processes that already exited and reports ones it may not signal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await stopMembers([{ pid: 301, startedAt: OLD }, { pid: 302, startedAt: OLD }], {
      signal: (pid) => { throw Object.assign(new Error('nope'), { code: pid === 301 ? 'ESRCH' : 'EPERM' }) },
      startTimes: async () => new Map([[301, OLD], [302, OLD]]),
      sleep: async () => undefined,
    })
    expect(result).toMatchObject({ terminated: 0, failed: [302] })
    await result.finished
    expect(warn).toHaveBeenCalled()
  })
})

describe('ProcessTracker', () => {
  let folder: string
  beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'commando-tracked-processes-')) })
  afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

  const table = [
    '  100    50   100   100   501 ttys003   0.0   2048 Mon Nov  9 11:00:00 2026     -zsh',
    '  101   100   101   100   501 ttys003   0.0   2048 Mon Nov  9 11:00:00 2026     /bin/sleep 9999',
  ].join('\n')

  function tracker(livePanes: LivePane[], signal = vi.fn()) {
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === 'lsof') return ''
      if (args.includes('-E') || args[0] === '-axwwE') return ''
      if (args[0] === '-o') return '  101 Mon Nov  9 11:00:00 2026\n'
      return livePanes.length ? table : table.split('\n')[1].replace('  101   100', '  101     1')
    })
    return {
      runner, signal,
      tracker: new ProcessTracker({
        livePanes: () => livePanes, tmuxServer: async () => ({ socketPath: SOCKET, serverPid: 50 }),
        store: new TrackedProcessStore(join(folder, 'state.json')), runner, platform: 'darwin', signal,
        sleep: async () => undefined, now: () => NOW, uid: 501, daemonPid: 9_000,
      }),
    }
  }

  it('keeps tracking after the tmux server exits with its last session, and refuses an unreadable process table', async () => {
    // A /bin/sleep left by a closed pane: only the saved state places it.
    const remembered = new Map([[processKey({ pid: 101, startedAt: new Date(2026, 10, 9, 11, 0, 0).getTime() }), '50:%3']])
    await new TrackedProcessStore(join(folder, 'state.json')).save(new Map([['50:%3', { sessionId: '$1', sessionName: 'Work' }]]), remembered)
    let server: { socketPath: string; serverPid: number } | null = { socketPath: SOCKET, serverPid: 50 }
    const runner = vi.fn(async (command: string, args: readonly string[]) => command === 'lsof' || args[0] === '-axwwE' ? '' : table)
    const scanner = new ProcessTracker({
      livePanes: () => [], tmuxServer: async () => server, store: new TrackedProcessStore(join(folder, 'state.json')),
      runner, platform: 'darwin', now: () => NOW, uid: 501, daemonPid: 9_000,
    })
    expect((await scanner.list(0)).map(({ pid }) => pid)).toEqual([101])
    server = null
    expect((await scanner.list(0)).map(({ pid }) => pid)).toEqual([101])
    runner.mockImplementation(async (command: string) => command === 'ps' ? 'ps: lstart: keyword not found\n' : '')
    await expect(scanner.list(0)).rejects.toThrow('ps listed no processes')
  })

  it('shares a recent scan, remembers processes across daemon restarts and stops them after their pane closed', async () => {
    const first = tracker([pane])
    expect((await first.tracker.list()).map(({ pid }) => pid)).toEqual([101])
    await first.tracker.list()
    expect(first.runner.mock.calls.filter(([command]) => command === 'ps')).toHaveLength(2)
    expect(JSON.parse(await readFile(join(folder, 'state.json'), 'utf8')).panes['50:%3'].targetId).toBe(pane.targetId)

    // A new daemon, after the pane closed: /bin/sleep shows no environment, so only the saved state places it.
    const second = tracker([])
    const [left] = await second.tracker.list()
    expect(left).toMatchObject({ pid: 101, detached: true, paneOpen: false, sessionId: '$1', targetId: pane.targetId })
    await expect(second.tracker.stop([left.key], (process) => process.sessionId === '$2')).rejects.toBeInstanceOf(TrackedProcessScopeError)
    expect(second.signal).not.toHaveBeenCalled()
    const stopped = await second.tracker.stop([left.key, '999:1'])
    expect(stopped.missing).toEqual(['999:1'])
    await stopped.finished
    expect(second.signal.mock.calls).toEqual([[101, 'SIGTERM'], [101, 'SIGKILL']])
  })
})

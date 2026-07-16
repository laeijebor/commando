import { describe, expect, it, vi } from 'vitest'
import {
  OpenPortConflictError,
  OpenPortNotFoundError,
  OpenPortScanner,
  associatePortsWithPanes,
  parseListeningProcesses,
  parseProcessParents,
} from './open-ports.js'

const lsofOutput = [
  'p200',
  'cnode',
  'f12',
  'n127.0.0.1:5173',
  'f13',
  'n[::1]:5173',
  'p300',
  'cworkerd',
  'f8',
  'n*:8787',
  'p999',
  'cUnrelated',
  'n*:4000',
  '',
].join('\n')

describe('open port discovery', () => {
  it('parses lsof listeners and the process parent table', () => {
    expect(parseListeningProcesses(lsofOutput)).toEqual([
      { processId: 200, processName: 'node', port: 5173 },
      { processId: 200, processName: 'node', port: 5173 },
      { processId: 300, processName: 'workerd', port: 8787 },
      { processId: 999, processName: 'Unrelated', port: 4000 },
    ])
    expect(parseProcessParents('  200   150\n150 100\n300 101\n')).toEqual(new Map([
      [200, 150],
      [150, 100],
      [300, 101],
    ]))
  })

  it('groups descendant listeners under their owning tmux panes', () => {
    const ports = associatePortsWithPanes(
      parseListeningProcesses(lsofOutput),
      parseProcessParents('200 150\n150 100\n300 101\n999 1\n'),
      [
        { paneId: '%1', sessionId: '$1', processId: 100 },
        { paneId: '%2', sessionId: '$2', processId: 101 },
      ],
    )

    expect(ports).toEqual([
      { port: 5173, processName: 'node', sessionId: '$1', paneId: '%1' },
      { port: 8787, processName: 'workerd', sessionId: '$2', paneId: '%2' },
    ])
  })

  it('caches scans briefly and degrades gracefully when host commands fail', async () => {
    const runner = vi.fn(async (command: string) => {
      if (command === 'lsof') return lsofOutput
      return '200 100\n'
    })
    const scanner = new OpenPortScanner(runner)
    const panes = [{ paneId: '%1', sessionId: '$1', processId: 100 }]

    await expect(scanner.scan(panes, 10_000)).resolves.toEqual([
      { port: 5173, processName: 'node', sessionId: '$1', paneId: '%1' },
    ])
    await scanner.scan(panes, 11_000)
    expect(runner).toHaveBeenCalledTimes(2)

    runner.mockRejectedValue(new Error('lsof unavailable'))
    await expect(scanner.scan(panes, 13_000)).resolves.toEqual([
      { port: 5173, processName: 'node', sessionId: '$1', paneId: '%1' },
    ])
  })

  it('freshly revalidates a listener before terminating its process', async () => {
    const runner = vi.fn(async (command: string) => command === 'lsof' ? lsofOutput : '200 100\n')
    const signaler = vi.fn()
    const scanner = new OpenPortScanner(runner, signaler, vi.fn())
    const panes = [{ paneId: '%1', sessionId: '$1', processId: 100 }]

    await expect(scanner.terminatePort(panes, {
      sessionId: '$1',
      paneId: '%1',
      port: 5173,
    })).resolves.toEqual({
      port: 5173,
      processName: 'node',
      sessionId: '$1',
      paneId: '%1',
    })
    expect(signaler).toHaveBeenCalledWith(200, 'SIGTERM')

    await expect(scanner.terminatePort(panes, {
      sessionId: '$1',
      paneId: '%1',
      port: 5174,
    })).rejects.toBeInstanceOf(OpenPortNotFoundError)
    expect(signaler).toHaveBeenCalledTimes(1)
  })

  it('signals each listener process only once for a session-wide termination', async () => {
    const listeners = [
      'p200', 'cnode', 'n*:3000', 'n*:3001',
      'p201', 'cworkerd', 'n*:8787', '',
    ].join('\n')
    const runner = vi.fn(async (command: string) => command === 'lsof'
      ? listeners
      : '200 100\n201 100\n')
    const signaler = vi.fn()
    const scanner = new OpenPortScanner(runner, signaler, vi.fn())
    const expectedTargets = [
      { sessionId: '$1', paneId: '%1', port: 3000 },
      { sessionId: '$1', paneId: '%1', port: 3001 },
      { sessionId: '$1', paneId: '%1', port: 8787 },
    ]

    await expect(scanner.terminateSessionPorts([
      { paneId: '%1', sessionId: '$1', processId: 100 },
    ], '$1', expectedTargets.slice(0, 2))).rejects.toBeInstanceOf(OpenPortConflictError)
    expect(signaler).not.toHaveBeenCalled()

    await expect(scanner.terminateSessionPorts([
      { paneId: '%1', sessionId: '$1', processId: 100 },
    ], '$1', expectedTargets)).resolves.toEqual({ processCount: 2, portCount: 3 })
    expect(signaler.mock.calls).toEqual([
      [200, 'SIGTERM'],
      [201, 'SIGTERM'],
    ])
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
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
})

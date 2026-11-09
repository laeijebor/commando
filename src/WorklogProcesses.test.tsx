// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TrackedProcess } from '../shared/tracked-processes'
import { WorklogProcesses, processUptime } from './WorklogProcesses'
import type { TrackedProcessesApiClient } from './trackedProcessesApi'

const TARGET = '550e8400-e29b-41d4-a716-000000000001'

function tracked(key: string, overrides: Partial<TrackedProcess> = {}): TrackedProcess {
  return {
    key, pid: Number(key.split(':')[0]), command: 'node vite --port 5173', fullCommand: '/usr/bin/node /app/vite --port 5173',
    startedAt: Date.now() - 125 * 60_000, cpuPercent: 1, rssKb: 204_800, ports: [], childCount: 0, detached: false,
    paneId: '%1', paneOpen: true, targetId: TARGET, sessionId: '$1', sessionName: 'work', ...overrides,
  }
}

function api(processes: TrackedProcess[]): TrackedProcessesApiClient & { list: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => processes),
    stop: vi.fn(async (keys: string[]) => ({ stopped: keys, missing: [], failed: [] })),
  }
}

afterEach(() => cleanup())

describe('processUptime', () => {
  it('reads like a clock', () => {
    const now = 1_000_000_000
    expect(processUptime(now - 40_000, now)).toBe('40s')
    expect(processUptime(now - 12 * 60_000, now)).toBe('12m')
    expect(processUptime(now - 185 * 60_000, now)).toBe('3h 5m')
    expect(processUptime(now - 52 * 3_600_000, now)).toBe('2d 4h')
  })
})

describe('WorklogProcesses', () => {
  it('lists this pane’s processes with ports, children, a detached badge and a Stop button', async () => {
    const client = api([
      tracked('10:1', { ports: [5173], childCount: 12 }),
      tracked('11:1', { command: 'python3 -m http.server 4499', detached: true, ports: [4499] }),
      tracked('12:1', { targetId: '550e8400-e29b-41d4-a716-000000000002', command: 'other pane' }),
    ])
    render(<WorklogProcesses api={client} targetId={TARGET} paneLabel="shell" connected />)
    const section = await screen.findByRole('region', { name: 'Processes for shell' })
    expect(within(section).getByText('2')).toBeInTheDocument()
    expect(within(section).queryByText('other pane')).toBeNull()
    expect(within(section).getByText('node vite --port 5173')).toHaveAttribute('title', '/usr/bin/node /app/vite --port 5173')
    expect(section).toHaveTextContent('up 2h 5m · pid 10 · +12 children · 200 MB')
    expect(within(section).getByRole('link', { name: ':4499' })).toHaveAttribute('href', expect.stringMatching(/^http:\/\/[^/]+:4499\/$/))
    expect(within(section).getAllByText('detached')).toHaveLength(1)

    fireEvent.click(within(section).getByRole('button', { name: 'Stop python3 -m http.server 4499' }))
    await waitFor(() => expect(client.stop).toHaveBeenCalledWith(['11:1'], TARGET))
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2))
  })

  it('is hidden while the pane has no processes', async () => {
    const client = api([tracked('12:1', { targetId: '550e8400-e29b-41d4-a716-000000000002' })])
    const { container } = render(<WorklogProcesses api={client} targetId={TARGET} paneLabel="shell" connected />)
    await waitFor(() => expect(client.list).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('does not poll while hidden or disconnected', () => {
    const client = api([tracked('10:1')])
    render(<WorklogProcesses api={client} targetId={TARGET} paneLabel="shell" connected={false} />)
    render(<WorklogProcesses api={client} targetId={TARGET} paneLabel="shell" connected visible={false} />)
    expect(client.list).not.toHaveBeenCalled()
  })

  it('reports a process it could not stop', async () => {
    const client = api([tracked('10:1')])
    client.stop.mockRejectedValue(new Error('Process 10 (node vite) is not part of this request'))
    render(<WorklogProcesses api={client} targetId={TARGET} paneLabel="shell" connected />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stop node vite --port 5173' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not part of this request')
  })
})

import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackedProcess } from '../shared/tracked-processes.js'
import { SessionManagementApi } from './session-management-api.js'
import { SessionArchives } from './session-archives.js'
import { SessionPreferenceStore } from './session-preferences.js'
import { TmuxSessionActions } from './tmux-session-actions.js'
import { TrackedProcessesApi, parseProcessKeys } from './tracked-processes-api.js'
import { TrackedProcessScopeError, type ProcessSelection, type ProcessTracker, type StopResult } from './tracked-processes.js'

const TARGET = '11111111-1111-4111-8111-111111111111'

function tracked(key: string, overrides: Partial<TrackedProcess> = {}): TrackedProcess {
  return {
    key, pid: Number(key.split(':')[0]), command: 'node vite', fullCommand: 'node vite', startedAt: 1, cpuPercent: 0, rssKb: 0,
    ports: [], childCount: 0, detached: false, paneId: '%3', paneOpen: true, targetId: TARGET, sessionId: '$1', sessionName: 'work',
    ...overrides,
  }
}

async function call(handler: { handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> }, path: string, method: string, body?: unknown) {
  const incoming = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
    method, headers: { 'content-type': 'application/json' },
  }) as IncomingMessage
  let status = 0
  let result = ''
  const response = {
    setHeader() {},
    writeHead(code: number) { status = code },
    end(value: string) { result = value },
  } as unknown as ServerResponse
  await handler.handle(incoming, response, new URL(path, 'http://localhost'))
  return { status, body: JSON.parse(result) }
}

function fakeTracker(processes: TrackedProcess[]) {
  const select = vi.fn(async (keys: readonly string[], allowed?: (process: TrackedProcess) => boolean): Promise<ProcessSelection> => {
    const chosen = processes.filter((process) => keys.includes(process.key))
    const outside = chosen.find((process) => allowed && !allowed(process))
    if (outside) throw new TrackedProcessScopeError(`Process ${outside.pid} is not part of this request`)
    return {
      processes: chosen, members: chosen.map(({ pid, startedAt }) => ({ pid, startedAt })),
      missing: keys.filter((key) => !chosen.some((process) => process.key === key)),
    }
  })
  const stopSelection = vi.fn(async (selection: ProcessSelection): Promise<StopResult> =>
    ({ stopped: selection.processes, missing: selection.missing, failed: [], finished: Promise.resolve(0) }))
  const stop = vi.fn(async (keys: readonly string[], allowed?: (process: TrackedProcess) => boolean) => stopSelection(await select(keys, allowed)))
  const list = vi.fn(async () => processes)
  return { list, stop, select, stopSelection } satisfies Pick<ProcessTracker, 'list' | 'stop' | 'select' | 'stopSelection'>
}

describe('process keys', () => {
  it('accepts a bounded list of pid:start keys and drops duplicates', () => {
    expect(parseProcessKeys(['12:1700000000', '12:1700000000'])).toEqual(['12:1700000000'])
    for (const value of [null, '12:1', [12], ['12'], ['abc:1'], ['1:2; rm'], Array.from({ length: 257 }, (_, index) => `${index}:1`)]) {
      expect(parseProcessKeys(value)).toBeNull()
    }
  })
})

describe('tracked processes API', () => {
  it('lists processes, scanning afresh on request', async () => {
    const tracker = fakeTracker([tracked('5:1')])
    const api = new TrackedProcessesApi(tracker)
    expect((await call(api, '/api/tracked-processes', 'GET')).body.processes).toHaveLength(1)
    await call(api, '/api/tracked-processes?fresh=1', 'GET')
    expect(tracker.list.mock.calls).toEqual([[undefined], [0]])
    expect((await call(api, '/api/tracked-processes', 'POST', {})).status).toBe(405)
  })

  it('validates stop requests and keeps a pane’s Stop to that pane’s processes', async () => {
    const tracker = fakeTracker([tracked('5:1'), tracked('6:1', { targetId: '22222222-2222-4222-8222-222222222222' })])
    const api = new TrackedProcessesApi(tracker)
    for (const body of [{}, { keys: [] }, { keys: ['nope'] }, { keys: ['5:1'], targetId: 'pane' }]) {
      expect((await call(api, '/api/tracked-processes/stop', 'POST', body)).status).toBe(400)
    }
    expect(tracker.stop).not.toHaveBeenCalled()
    expect((await call(api, '/api/tracked-processes/stop', 'POST', { keys: ['6:1'], targetId: TARGET })).status).toBe(409)
    const stopped = await call(api, '/api/tracked-processes/stop', 'POST', { keys: ['5:1', '7:1'], targetId: TARGET })
    expect(stopped).toEqual({ status: 200, body: { stopped: ['5:1'], missing: ['7:1'], failed: [], killed: 0 } })
  })
})

describe('closing a session with tracked processes', () => {
  // Pausing saves the session's place in the tree: keep that, and archives, out of the real ~/.commando.
  let folder: string
  beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'commando-close-processes-')) })
  afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

  function harness(processes: TrackedProcess[]) {
    const order: string[] = []
    const tracker = fakeTracker(processes)
    tracker.select.mockImplementation(async (keys, allowed) => {
      order.push('select')
      const chosen = processes.filter((process) => keys.includes(process.key))
      const outside = chosen.find((process) => !allowed?.(process))
      if (outside) throw new TrackedProcessScopeError(`Process ${outside.pid} is not part of this request`)
      return { processes: chosen, members: chosen.map(({ pid, startedAt }) => ({ pid, startedAt })), missing: keys.filter((key) => !chosen.some((process) => process.key === key)) }
    })
    tracker.stopSelection.mockImplementation(async (selection) => {
      order.push('stop')
      return { stopped: selection.processes, missing: selection.missing, failed: [], finished: Promise.resolve(0) }
    })
    const archives = new SessionArchives({ directory: join(folder, 'archives') })
    archives.archive = vi.fn(async () => { order.push('archive'); return { id: 'a', name: 'work', createdAt: 1, windowCount: 1, paneCount: 1 } })
    const actions = new TmuxSessionActions()
    actions.delete = vi.fn(async () => { order.push('delete') })
    const preferences = new SessionPreferenceStore(join(folder, 'session-tree.json'))
    const api = new SessionManagementApi({ archives, actions, preferences, trackedProcesses: tracker, currentSessions: () => [{ id: '$1', name: 'work' }], currentWindowIds: () => [] })
    return { api, tracker, order, archives, actions }
  }
  const processes = [tracked('5:1'), tracked('6:1', { detached: true, paneOpen: false }), tracked('8:1', { sessionId: '$2' })]

  it('stops only the chosen processes, after the session has closed', async () => {
    const { api, tracker, order } = harness(processes)
    const result = await call(api, '/api/session-management/sessions/%241/archive', 'POST', { confirmSessionId: '$1', stopProcessKeys: ['6:1', '9:1'] })
    expect(result.status).toBe(200)
    expect(result.body.processesStopped).toBe(1)
    // Chosen before the session closes, stopped by pid after it.
    expect(order).toEqual(['select', 'archive', 'stop'])
    // 9:1 exited since the dialog listed it; 5:1 was left unticked.
    expect(tracker.stopSelection.mock.calls[0][0].members).toEqual([{ pid: 6, startedAt: 1 }])
  })

  it('stops chosen processes on pause and delete too, and nothing when none are chosen', async () => {
    const paused = harness(processes)
    expect((await call(paused.api, '/api/session-management/sessions/%241/pause', 'POST', { confirmSessionId: '$1', stopProcessKeys: ['5:1'] })).status).toBe(200)
    expect(paused.order).toEqual(['select', 'archive', 'stop'])
    const deleted = harness(processes)
    expect((await call(deleted.api, '/api/session-management/sessions/%241/delete', 'DELETE', { confirmSessionId: '$1', stopProcessKeys: ['5:1', '6:1'] })).body.processesStopped).toBe(2)
    expect(deleted.order).toEqual(['select', 'delete', 'stop'])
    const kept = harness(processes)
    expect((await call(kept.api, '/api/session-management/sessions/%241/delete', 'DELETE', { confirmSessionId: '$1' })).status).toBe(200)
    expect(kept.tracker.stopSelection).not.toHaveBeenCalled()
  })

  it('refuses malformed keys and another session’s processes before closing anything', async () => {
    const { api, tracker, archives, actions } = harness(processes)
    expect((await call(api, '/api/session-management/sessions/%241/archive', 'POST', { confirmSessionId: '$1', stopProcessKeys: '5:1' })).status).toBe(400)
    const other = await call(api, '/api/session-management/sessions/%241/delete', 'DELETE', { confirmSessionId: '$1', stopProcessKeys: ['5:1', '8:1'] })
    expect(other.status).toBe(409)
    expect(archives.archive).not.toHaveBeenCalled()
    expect(actions.delete).not.toHaveBeenCalled()
    expect(tracker.stopSelection).not.toHaveBeenCalled()
  })

  it('reports processes it could not stop without failing the close', async () => {
    const { api, tracker } = harness(processes)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    tracker.stopSelection.mockReset().mockRejectedValue(new Error('ps failed'))
    const result = await call(api, '/api/session-management/sessions/%241/archive', 'POST', { confirmSessionId: '$1', stopProcessKeys: ['5:1'] })
    expect(result.status).toBe(200)
    expect(result.body.processesNotStopped).toBe('ps failed')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

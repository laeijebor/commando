import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenPortNotFoundError } from './open-ports.js'
import { PortManagementApi } from './port-management-api.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function startApi(api: PortManagementApi): Promise<string> {
  const server = createServer((request, response) => {
    void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('port management API', () => {
  it('terminates an exactly identified open port and refreshes the snapshot', async () => {
    const terminated = { port: 3000, processName: 'node', sessionId: '$1', paneId: '%2' }
    const actions = {
      terminatePort: vi.fn().mockResolvedValue(terminated),
      terminateSessionPorts: vi.fn(),
    }
    const onPortsChanged = vi.fn().mockResolvedValue(undefined)
    const baseUrl = await startApi(new PortManagementApi({
      actions,
      currentSessionIds: () => ['$1'],
      currentPorts: () => [terminated],
      onPortsChanged,
    }))

    const response = await fetch(`${baseUrl}/api/port-management/ports/kill`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: '$1', paneId: '%2', port: 3000, confirmPort: 3000 }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, terminated })
    expect(actions.terminatePort).toHaveBeenCalledWith({ sessionId: '$1', paneId: '%2', port: 3000 })
    expect(onPortsChanged).toHaveBeenCalledOnce()
  })

  it('requires exact confirmation before terminating every listener in a session', async () => {
    const ports = [
      { port: 3000, processName: 'node', sessionId: '$1', paneId: '%1' },
      { port: 5173, processName: 'node', sessionId: '$1', paneId: '%2' },
    ]
    const actions = {
      terminatePort: vi.fn(),
      terminateSessionPorts: vi.fn().mockResolvedValue({ processCount: 2, portCount: 2 }),
    }
    const baseUrl = await startApi(new PortManagementApi({
      actions,
      currentSessionIds: () => ['$1'],
      currentPorts: () => ports,
    }))

    const rejected = await fetch(`${baseUrl}/api/port-management/sessions/%241/kill`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmSessionId: '$2' }),
    })
    expect(rejected.status).toBe(400)
    expect(actions.terminateSessionPorts).not.toHaveBeenCalled()

    const accepted = await fetch(`${baseUrl}/api/port-management/sessions/%241/kill`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmSessionId: '$1',
        targets: ports.map((port) => ({ paneId: port.paneId, port: port.port })),
      }),
    })
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toEqual({
      ok: true,
      sessionId: '$1',
      processCount: 2,
      portCount: 2,
    })
    expect(actions.terminateSessionPorts).toHaveBeenCalledWith('$1', [
      { sessionId: '$1', paneId: '%1', port: 3000 },
      { sessionId: '$1', paneId: '%2', port: 5173 },
    ])
  })

  it('returns not found when fresh discovery no longer finds the listener', async () => {
    const actions = {
      terminatePort: vi.fn().mockRejectedValue(new OpenPortNotFoundError('Open port process no longer exists')),
      terminateSessionPorts: vi.fn(),
    }
    const baseUrl = await startApi(new PortManagementApi({
      actions,
      currentSessionIds: () => ['$1'],
      currentPorts: () => [],
    }))

    const response = await fetch(`${baseUrl}/api/port-management/ports/kill`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: '$1', paneId: '%2', port: 3000, confirmPort: 3000 }),
    })

    expect(response.status).toBe(404)
  })

  it('rejects a session action when the confirmed targets differ from the current snapshot', async () => {
    const actions = {
      terminatePort: vi.fn(),
      terminateSessionPorts: vi.fn(),
    }
    const baseUrl = await startApi(new PortManagementApi({
      actions,
      currentSessionIds: () => ['$1'],
      currentPorts: () => [
        { port: 3000, processName: 'node', sessionId: '$1', paneId: '%1' },
        { port: 5173, processName: 'node', sessionId: '$1', paneId: '%2' },
      ],
    }))

    const response = await fetch(`${baseUrl}/api/port-management/sessions/%241/kill`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmSessionId: '$1',
        targets: [{ paneId: '%1', port: 3000 }],
      }),
    })

    expect(response.status).toBe(409)
    expect(actions.terminateSessionPorts).not.toHaveBeenCalled()
  })
})

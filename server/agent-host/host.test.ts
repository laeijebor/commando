import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../shared/agent-chat.js'
import { snapshotItems } from './host.js'

describe('snapshotItems', () => {
  it('keeps the newest items that fit, in order', () => {
    const items = Array.from({ length: 10 }, (_, index): ChatItem => ({
      id: `i${index}`, turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'notice', level: 'info', text: 'x'.repeat(100),
    }))
    const size = JSON.stringify(items[0]).length
    expect(snapshotItems(items, size * 3).map((item) => item.id)).toEqual(['i7', 'i8', 'i9'])
    expect(snapshotItems(items)).toHaveLength(10)
  })
})

describe('DaemonLink', () => {
  it('backs off instead of hammering a daemon that refuses it', async () => {
    const { WebSocketServer } = await import('ws')
    const { DaemonLink } = await import('./host.js')
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const port = (server.address() as { port: number }).port
    let connections = 0
    server.on('connection', (socket) => {
      connections += 1
      socket.close(4003, 'host is not running in pane %1')
    })
    const closes: number[] = []
    const link = new DaemonLink(`ws://127.0.0.1:${port}`, async () => 'token', { open: () => {}, message: () => {}, close: (code) => closes.push(code) })
    link.start()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    link.stop()
    server.close()
    expect(closes).toEqual([4003])
    expect(connections).toBe(1)
  })
})

describe('AgentHost input relays', () => {
  it('sends the command list after the snapshot and answers file searches', async () => {
    const { WebSocketServer } = await import('ws')
    const { AgentHost } = await import('./host.js')
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const port = (server.address() as { port: number }).port
    const received: { type: string; [key: string]: unknown }[] = []
    const sends: unknown[][] = []
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type: string }
        received.push(message)
        if (message.type === 'session_snapshot') {
          socket.send(JSON.stringify({ type: 'file_search', paneId: '%4', query: 'comp', requestId: 'q1' }))
          socket.send(JSON.stringify({ type: 'send', paneId: '%4', text: 'hi', images: [{ id: `${'a'.repeat(64)}.png` }], requestId: 's1' }))
        }
      })
    })
    const fakeSession = {
      paneId: '%4',
      commands: [{ name: 'compact', description: 'Free context', kind: 'command' }],
      on: () => {},
      snapshot: () => ({ session: { paneId: '%4', provider: 'claude', cwd: '/w', status: 'idle', hostPid: 1, hostVersion: 3 }, items: [] }),
      searchFiles: async (query: string) => ({ entries: [{ path: `src/${query}.ts`, kind: 'file' }], truncated: false }),
      send: (...args: unknown[]) => { sends.push(args) },
    }
    const host = new AgentHost(`ws://127.0.0.1:${port}`, async () => 'token', 'pane', { info: () => {} })
    host.add(fakeSession as never)
    host.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    host.stop()
    server.close()
    expect(received.map((message) => message.type)).toEqual(['hello', 'session_snapshot', 'commands', 'file_search_result'])
    expect(received[3]).toEqual({ type: 'file_search_result', paneId: '%4', requestId: 'q1', entries: [{ path: 'src/comp.ts', kind: 'file' }], truncated: false })
    expect(sends).toEqual([['hi', [{ id: `${'a'.repeat(64)}.png` }]]])
  })
})

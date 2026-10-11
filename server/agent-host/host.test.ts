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

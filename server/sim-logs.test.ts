import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimLogsService, simLogFilters, simLogsUdid } from './sim-logs.js'
import type { SimLiveSocket } from './sim-live.js'

const U = 'AAAAAAAA-1111-1111-1111-111111111111'
class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  kill = vi.fn(() => { this.emit('close', null); return true })
}
class Viewer extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn((_code?: number, _reason?: string) => { if (this.readyState !== 3) { this.readyState = 3; this.emit('close') } })
  lines() { return this.send.mock.calls.map(([data]) => JSON.parse(data)) }
}
const services: SimLogsService[] = []
afterEach(() => { for (const service of services.splice(0)) service.close() })
function setup() {
  const children: Child[] = []
  const spawn = vi.fn(() => { const child = new Child(); children.push(child); return child as unknown as ChildProcessWithoutNullStreams })
  const service = new SimLogsService({ spawn, command: 'fake-baguette' }); services.push(service)
  const connect = (query = '', udid = U) => { const viewer = new Viewer(); service.connect(udid, viewer as unknown as SimLiveSocket, new URLSearchParams(query)); return viewer }
  return { service, children, spawn, connect }
}

describe('simulator logs', () => {
  it('routes both paths and validates levels, duplicate filters and bundle ids', () => {
    expect(simLogsUdid(`/api/sims/${U.toLowerCase()}/logs`)).toBe(U)
    expect(simLogsUdid(`/ws/api/sims/${U}/logs`)).toBe(U)
    expect(simLogsUdid('/api/sims/bad/logs')).toBeNull()
    expect(simLogsUdid(`/api/sims/${U}/live`)).toBeNull()
    for (const query of ['level=error', 'level=', 'level=debug&level=info', 'bundle=', 'bundle=a/b', 'bundle=a&bundle=b', `bundle=${'a'.repeat(256)}`]) {
      expect(simLogFilters(new URLSearchParams(query))).toBeNull()
      const { spawn, connect } = setup(); expect(connect(query).close).toHaveBeenCalledWith(1008, expect.any(String)); expect(spawn).not.toHaveBeenCalled()
    }
    expect(simLogFilters(new URLSearchParams())).toEqual({ level: 'info' })
  })

  it('spawns a separate argv per socket and releases each child on disconnect', () => {
    const { connect, spawn, children } = setup()
    const first = connect('', U.toLowerCase()), second = connect('level=debug&bundle=com.example.app'), third = connect('level=default')
    expect(spawn.mock.calls).toEqual([
      ['fake-baguette', ['logs', '--udid', U, '--style', 'ndjson', '--level', 'info']],
      ['fake-baguette', ['logs', '--udid', U, '--style', 'ndjson', '--level', 'debug', '--bundle-id', 'com.example.app']],
      ['fake-baguette', ['logs', '--udid', U, '--style', 'ndjson', '--level', 'default']],
    ])
    expect(children[0].stderr.readableFlowing).toBe(true)
    first.close(); expect(children[0].kill).toHaveBeenCalledOnce(); expect(children[1].kill).not.toHaveBeenCalled()
    second.emit('error', new Error('gone')); expect(children[1].kill).toHaveBeenCalledOnce()
    third.close(); expect(children[2].kill).toHaveBeenCalledOnce()
  })

  it('parses fragmented UTF-8 NDJSON, malformed and unknown lines, and truncates messages', () => {
    const { connect, children } = setup(), viewer = connect()
    const data = Buffer.from(JSON.stringify({ timestamp: 'now', messageType: 'Error', processImagePath: '/app', subsystem: 'sub', category: 'cat', eventMessage: 'héllo' }) + '\n')
    const split = data.indexOf(Buffer.from('é')) + 1
    children[0].stdout.write(data.subarray(0, split)); expect(viewer.send).not.toHaveBeenCalled()
    children[0].stdout.write(data.subarray(split))
    children[0].stdout.write('broken\r\n{"eventMessage":5}\nnull\n\n')
    children[0].stdout.write(JSON.stringify({ eventMessage: 'x'.repeat(5000), subsystem: 7 }) + '\n')
    expect(viewer.lines()).toEqual([
      { t: 'now', level: 'Error', process: '/app', subsystem: 'sub', category: 'cat', message: 'héllo' },
      { t: '', level: 'default', process: '', message: 'broken' },
      { t: '', level: 'default', process: '', message: '{"eventMessage":5}' },
      { t: '', level: 'default', process: '', message: 'null' },
      { t: '', level: 'default', process: '', message: 'x'.repeat(4000) },
    ])
  })

  it('drops slow-client lines and bounds unterminated output without losing the next line', () => {
    const { connect, children } = setup(), viewer = connect()
    viewer.bufferedAmount = 300 * 1024; children[0].stdout.write('dropped\n'); expect(viewer.send).not.toHaveBeenCalled()
    viewer.bufferedAmount = 0
    children[0].stdout.write('x'.repeat(100_000)); children[0].stdout.write('more\nnext\n')
    expect(viewer.lines().map((line) => line.message)).toEqual(['x'.repeat(4000), 'next'])
  })

  it('caps at four streams across devices and filters, then frees slots on close and exit', () => {
    const { connect, spawn, children, service } = setup()
    const viewers = Array.from({ length: 4 }, (_, index) => connect(`level=debug&bundle=app${index}`, index ? U.replace('AAAAAAAA', 'BBBBBBBB') : U))
    expect(connect().close).toHaveBeenCalledWith(1013, expect.stringContaining('Four log streams'))
    expect(spawn).toHaveBeenCalledTimes(4)
    viewers[0].close(); connect(); expect(spawn).toHaveBeenCalledTimes(5)
    children[1].stdout.write('final line'); children[1].emit('close', 1)
    expect(viewers[1].lines()[0].message).toBe('final line')
    expect(viewers[1].close).toHaveBeenCalledWith(1011, expect.stringContaining('exited'))
    connect(); expect(spawn).toHaveBeenCalledTimes(6)
    service.close(); service.close()
    expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true)
    expect(connect().close).toHaveBeenCalledWith(1008, expect.any(String))
  })

  it('closes clearly for missing Baguette and other child failures, including synchronous spawn errors', () => {
    const { connect, children } = setup(), missing = connect()
    children[0].emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect(missing.close).toHaveBeenCalledWith(1011, 'Baguette is not installed'); expect(children[0].kill).toHaveBeenCalledOnce()
    const failed = connect(); children[1].emit('error', new Error('failed'))
    expect(failed.close).toHaveBeenCalledWith(1011, 'Simulator logs failed')
    const service = new SimLogsService({ spawn: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } }); services.push(service)
    const viewer = new Viewer(); service.connect(U, viewer as unknown as SimLiveSocket)
    expect(viewer.close).toHaveBeenCalledWith(1011, 'Baguette is not installed')
  })
})

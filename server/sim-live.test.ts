import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimLiveService, simGesture, simLiveUdid, type SimLiveSocket } from './sim-live.js'

const A = 'AAAAAAAA-1111-1111-1111-111111111111'
const B = 'BBBBBBBB-2222-2222-2222-222222222222'
const C = 'CCCCCCCC-3333-3333-3333-333333333333'
class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  writes: string[] = []
  kill = vi.fn(() => { this.emit('close', null); return true })
  constructor(readonly args: string[]) { super(); this.stdin.on('data', (data) => this.writes.push(data.toString())) }
}
class Viewer extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn((_code?: number, _reason?: string) => { if (this.readyState !== 3) { this.readyState = 3; this.emit('close') } })
  gesture(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false) }
}
const services: SimLiveService[] = []
afterEach(() => { for (const service of services.splice(0)) service.close(); vi.restoreAllMocks() })
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function setup() {
  const children: Child[] = []
  const spawn = vi.fn((_command: string, args: string[]) => { const child = new Child(args); children.push(child); return child as unknown as ChildProcessWithoutNullStreams })
  const service = new SimLiveService({ spawn, command: 'fake-baguette' }); services.push(service)
  const connect = (udid = A) => { const viewer = new Viewer(); service.connect(udid, viewer as unknown as SimLiveSocket); return viewer }
  const layout = async (width = 390, height = 844) => { const child = [...children].reverse().find((item) => item.args[0] === 'chrome')!; child.stdout.write(JSON.stringify({ screen: { width, height } })); child.emit('close', 0); await flush() }
  return { children, service, spawn, connect, layout }
}
function chunk(tag: number, payload = Buffer.from('payload')) { const frame = Buffer.concat([Buffer.from([tag]), payload]); const length = Buffer.alloc(4); length.writeUInt32BE(frame.length); return Buffer.concat([length, frame]) }

describe('live simulator sessions', () => {
  it('shares stream/input children, frames fragmented and coalesced output, and seeds every new viewer after meta', async () => {
    const { children, spawn, connect, layout } = setup()
    const first = connect(A.toLowerCase()); const second = connect()
    expect(spawn).toHaveBeenCalledTimes(1)
    await layout()
    expect(children.map((child) => child.args)).toEqual([
      ['chrome', 'layout', '--udid', A], ['stream', '--udid', A, '--format', 'avcc', '--fps', '30', '--scale', '2'], ['input', '--udid', A],
    ])
    expect(first.send.mock.calls[0]).toEqual([JSON.stringify({ type: 'meta', width: 390, height: 844 })])
    const data = Buffer.concat([chunk(1), chunk(2), chunk(3), chunk(4)])
    children[1].stdout.write(data.subarray(0, 2)); children[1].stdout.write(data.subarray(2, 7)); children[1].stdout.write(data.subarray(7))
    expect(first.send.mock.calls.slice(1).map(([frame]) => frame[0])).toEqual([1, 2, 3, 4])
    expect(second.send.mock.calls).toEqual(first.send.mock.calls)
    const late = connect(); await flush()
    expect(late.send.mock.calls.map(([frame]) => typeof frame === 'string' ? JSON.parse(frame).type : frame[0])).toEqual(['meta', 1])
    expect(children[1].writes.join('')).toBe('{"cmd":"force_idr"}\n{"cmd":"snapshot"}\n'.repeat(3))
    first.close(); second.close(); expect(children[1].kill).not.toHaveBeenCalled()
    late.close(); expect(children[1].kill).toHaveBeenCalledOnce(); expect(children[2].kill).toHaveBeenCalledOnce()
  })

  it('validates input, injects point size, drops only moves under backpressure and drains acks', async () => {
    const { connect, children, layout } = setup(); const viewer = connect(); await layout()
    viewer.gesture({ type: 'touch1-down', x: 30, y: 40, width: 999, height: 999 })
    viewer.gesture({ type: 'paste', text: 'bad' }); viewer.gesture({ type: 'touch1-move', x: '3', y: 2 })
    viewer.emit('message', Buffer.from('{broken'), false); viewer.emit('message', Buffer.from('{"type":"scroll","deltaY":1e999}'), false)
    viewer.emit('message', Buffer.from('{"type":"button","button":"home"}'), true)
    expect(children[2].writes).toHaveLength(1)
    expect(JSON.parse(children[2].writes[0])).toEqual({ type: 'touch1-down', x: 30, y: 40, width: 390, height: 844 })
    vi.spyOn(children[2].stdin, 'writableNeedDrain', 'get').mockReturnValue(true)
    viewer.gesture({ type: 'touch1-move', x: 31, y: 41 }); viewer.gesture({ type: 'touch2-move', x1: 1, y1: 1, x2: 2, y2: 2 })
    viewer.gesture({ type: 'touch1-up', x: 31, y: 41 }); viewer.gesture({ type: 'key', code: 'KeyA', modifiers: ['command'] })
    expect(children[2].writes).toHaveLength(3)
    expect(children[2].stdout.readableFlowing).toBe(true)
  })

  it('reserves starting sessions in the two-device cap, refuses a third without killing existing streams, and frees a slot', async () => {
    const { connect, children, layout } = setup(); const first = connect(A); await layout(); const second = connect(B); await layout()
    const third = connect(C)
    expect(third.close).toHaveBeenCalledWith(1013, expect.stringContaining('Two simulators'))
    expect(children).toHaveLength(6); expect(children.every((child) => child.kill.mock.calls.length === 0)).toBe(true)
    first.close(); const accepted = connect(C); await layout()
    expect(accepted.close).not.toHaveBeenCalled(); expect(second.close).not.toHaveBeenCalled()
  })

  it('releases pending layout children on disconnect and all sessions on shutdown', async () => {
    const { service, connect, children, layout } = setup(); const pending = connect(); pending.close(); await flush()
    expect(children[0].kill).toHaveBeenCalledOnce()
    connect(A); await layout(); const other = connect(B); await layout()
    service.close(); service.close()
    expect(children.filter((child) => child.args[0] !== 'chrome').every((child) => child.kill.mock.calls.length === 1)).toBe(true)
    expect(other.close).toHaveBeenCalled(); expect(connect(C).close).toHaveBeenCalled()
  })

  it('reports missing Baguette, invalid layout, malformed stream and child failures as snapshot fallbacks', async () => {
    const first = setup(); const missing = first.connect()
    first.children[0].emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); await flush()
    expect(missing.close).toHaveBeenCalledWith(1011, expect.stringContaining('not installed'))
    const second = setup(); const badLayout = second.connect(); await second.layout(NaN)
    expect(badLayout.close).toHaveBeenCalledWith(1011, expect.stringContaining('could not start'))
    const third = setup(); const badStream = third.connect(); await third.layout()
    const length = Buffer.alloc(4); length.writeUInt32BE(17 * 1024 * 1024); third.children[1].stdout.write(length)
    expect(badStream.close).toHaveBeenCalledWith(1011, 'Invalid simulator stream')
    const fourth = setup(); const failed = fourth.connect(); await fourth.layout(); fourth.children[2].emit('error', new Error('input died'))
    expect(failed.close).toHaveBeenCalledWith(1011, expect.stringContaining('failed'))
    expect(fourth.children[1].kill).toHaveBeenCalledOnce()
  })

  it('closes a slow viewer without losing frame dependencies for other viewers', async () => {
    const { connect, children, layout } = setup(); const slow = connect(); const fast = connect(); await layout()
    slow.bufferedAmount = 17 * 1024 * 1024; children[1].stdout.write(chunk(3))
    expect(slow.close).toHaveBeenCalledWith(1013, expect.stringContaining('too slow'))
    expect(fast.send).toHaveBeenLastCalledWith(Buffer.concat([Buffer.from([3]), Buffer.from('payload')]))
    expect(children[1].kill).not.toHaveBeenCalled()
  })
})

describe('gesture and endpoint validation', () => {
  it('allows precisely the supported gesture types and rejects invalid fields', () => {
    expect(simGesture({ type: 'touch2-down', x1: 1, y1: 2, x2: 3, y2: 4 }, 390, 844)).toMatchObject({ width: 390, height: 844 })
    for (const value of [null, [], { type: 'force_idr' }, { type: 'touch1-up', x: 1 }, { type: 'scroll', deltaX: Infinity }, { type: 'scroll', deltaY: '3' }, { type: 'key', code: 'KeyA', modifiers: ['bad'] }, { type: 'type', text: 1 }, { type: 'button', button: 'siri' }]) expect(simGesture(value, 390, 844)).toBeNull()
    for (const value of [{ type: 'scroll', deltaY: 3 }, { type: 'type', text: 'hello' }, { type: 'button', button: 'lock' }]) expect(simGesture(value, 390, 844)).not.toBeNull()
  })
  it('routes the API endpoint and its development proxy alias without query auth', () => {
    expect(simLiveUdid(`/api/sims/${A.toLowerCase()}/live`)).toBe(A)
    expect(simLiveUdid(`/ws/api/sims/${A}/live`)).toBe(A)
    expect(simLiveUdid('/api/sims/bad/live')).toBeNull()
    expect(simLiveUdid(`/api/sims/${A}/snapshot.jpg`)).toBeNull()
  })
})

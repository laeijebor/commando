// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimLiveView } from './SimLiveView'

const U = 'AAAAAAAA-1111-1111-1111-111111111111'
class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1; binaryType = ''
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { reason: string }) => void) | null = null
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3 })
  constructor(readonly url: string, readonly protocols: string[]) { Socket.instances.push(this) }
  message(data: unknown) { act(() => this.onmessage?.({ data })) }
  envelopes() { return this.send.mock.calls.map(([data]) => JSON.parse(data)) }
}
class Decoder {
  static instances: Decoder[] = []
  state = 'unconfigured'
  configure = vi.fn(() => { this.state = 'configured' })
  decode = vi.fn()
  close = vi.fn(() => { this.state = 'closed' })
  constructor(readonly init: VideoDecoderInit) { Decoder.instances.push(this) }
}
const draw = vi.fn()
let visibility: DocumentVisibilityState
let images: HTMLImageElement[]
let rafs: Map<number, FrameRequestCallback>
let capture: Set<number>
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }) }
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await flush() }
function meta(socket = Socket.instances.at(-1)!) { socket.message(JSON.stringify({ type: 'meta', width: 390, height: 844 })) }
function binary(tag: number, payload: number[], socket = Socket.instances.at(-1)!) { socket.message(new Uint8Array([tag, ...payload]).buffer) }
function changeVisibility(value: DocumentVisibilityState) { visibility = value; fireEvent(document, new Event('visibilitychange')) }
function pointer(canvas: HTMLElement, type: string, x: number, y: number) {
  const event = new MouseEvent(type === 'pointerleave' ? 'pointerout' : type, { bubbles: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 7 })
  fireEvent(canvas, event)
}
beforeEach(() => {
  vi.useFakeTimers(); Socket.instances = []; Decoder.instances = []; images = []; rafs = new Map(); capture = new Set(); visibility = 'visible'; draw.mockClear()
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('VideoDecoder', Decoder)
  vi.stubGlobal('EncodedVideoChunk', class { constructor(readonly init: EncodedVideoChunkInit) { Object.assign(this, init) } })
  vi.stubGlobal('Image', vi.fn(function () { const image = document.createElement('img'); images.push(image); return image }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('jpeg')))
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 205, bottom: 442, width: 195, height: 422, toJSON: () => ({}) })
  Object.defineProperties(HTMLCanvasElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn((id: number) => capture.add(id)) },
    hasPointerCapture: { configurable: true, value: (id: number) => capture.has(id) },
    releasePointerCapture: { configurable: true, value: vi.fn((id: number) => capture.delete(id)) },
  })
  let url = 0
  Object.defineProperties(URL, { createObjectURL: { configurable: true, value: vi.fn(() => `blob:frame-${++url}`) }, revokeObjectURL: { configurable: true, value: vi.fn() } })
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { const id = rafs.size + 1; rafs.set(id, callback); return id }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => rafs.delete(id)))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('SimLiveView', () => {
  it('authenticates without URL tokens, configures AVCC, skips deltas before IDR, draws video and closes frame/decoder/socket', () => {
    const { unmount } = render(<SimLiveView udid={U} token="token/value &" />)
    const ws = Socket.instances[0]
    expect(new URL(ws.url).pathname).toBe(`/ws/api/sims/${U}/live`)
    expect(new URL(ws.url).search).toBe('')
    expect(ws.protocols).toEqual(['commando-live', 'commando-auth.token%2Fvalue%20%26'])
    expect(ws.binaryType).toBe('arraybuffer'); meta()
    binary(1, [1, 100, 0, 31, 255]); const decoder = Decoder.instances[0]
    expect(decoder.configure).toHaveBeenCalledWith(expect.objectContaining({ codec: 'avc1.64001f', description: new Uint8Array([1, 100, 0, 31, 255]) }))
    binary(3, [1]); expect(decoder.decode).not.toHaveBeenCalled()
    binary(2, [2]); binary(3, [3])
    expect(decoder.decode.mock.calls.map(([frame]) => frame.type)).toEqual(['key', 'delta'])
    expect(decoder.decode.mock.calls[1][0].timestamp).toBeCloseTo(1_000_000 / 30)
    const frame = { displayWidth: 195, displayHeight: 422, close: vi.fn() }
    act(() => decoder.init.output(frame as unknown as VideoFrame))
    expect(draw).toHaveBeenCalledWith(frame, 0, 0, 195, 422); expect(frame.close).toHaveBeenCalledOnce()
    expect(screen.getByText('live')).toBeVisible()
    unmount(); expect(ws.close).toHaveBeenCalled(); expect(decoder.close).toHaveBeenCalledOnce()
  })

  it('paints the JPEG seed before video and revokes pending seeds on unmount', () => {
    const { unmount } = render(<SimLiveView udid={U} token="" />)
    binary(4, [255, 216]); Object.defineProperties(images[0], { naturalWidth: { value: 195 }, naturalHeight: { value: 422 } })
    fireEvent.load(images[0]); expect(draw).toHaveBeenCalledWith(images[0], 0, 0, 195, 422)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-1')
    binary(4, [255, 216]); unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-2'); expect(images[1].onload).toBeNull()
  })

  it('maps pointer coordinates to points, captures, coalesces moves and sends up on cancel/leave/blur/unmount', () => {
    const { container, unmount } = render(<SimLiveView udid={U} token="" />); meta()
    const canvas = container.querySelector('canvas')!; const ws = Socket.instances[0]
    pointer(canvas, 'pointerdown', 107.5, 231)
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(7)
    expect(ws.envelopes()[0]).toEqual({ type: 'touch1-down', x: 195, y: 422 })
    pointer(canvas, 'pointermove', 100, 200); pointer(canvas, 'pointermove', 205, 442)
    expect(ws.envelopes()).toHaveLength(1); expect(rafs.size).toBe(1)
    act(() => { for (const callback of rafs.values()) callback(0); rafs.clear() })
    expect(ws.envelopes()[1]).toEqual({ type: 'touch1-move', x: 390, y: 844 })
    pointer(canvas, 'pointercancel', 205, 442)
    expect(ws.envelopes()[2]).toEqual({ type: 'touch1-up', x: 390, y: 844 })
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7)
    pointer(canvas, 'pointerdown', 10, 20); pointer(canvas, 'pointermove', 15, 25); pointer(canvas, 'pointerleave', 15, 25)
    expect(ws.envelopes().at(-1).type).toBe('touch1-up'); expect(rafs.size).toBe(0)
    pointer(canvas, 'pointerdown', 10, 20); fireEvent.blur(canvas); expect(ws.envelopes().at(-1).type).toBe('touch1-up')
    pointer(canvas, 'pointerdown', 10, 20); unmount(); expect(ws.envelopes().at(-1).type).toBe('touch1-up')
  })

  it('sends wheel, focused code/modifier keys and toolbar buttons; Escape releases focus', async () => {
    const { container } = render(<SimLiveView udid={U} token="owner" />); meta()
    const canvas = container.querySelector('canvas')!; const ws = Socket.instances[0]
    fireEvent.wheel(canvas, { deltaX: 2, deltaY: -50 })
    act(() => canvas.focus()); expect(canvas).toHaveClass('is-focused')
    fireEvent.keyDown(canvas, { key: 'A', code: 'KeyA', shiftKey: true, metaKey: true })
    expect(ws.envelopes()).toEqual([{ type: 'scroll', deltaX: 2, deltaY: -50 }, { type: 'key', code: 'KeyA', modifiers: ['shift', 'command'] }])
    fireEvent.keyDown(canvas, { key: 'Escape', code: 'Escape' }); expect(canvas).not.toHaveFocus(); expect(canvas).not.toHaveClass('is-focused')
    fireEvent.keyDown(canvas, { key: 'b', code: 'KeyB' }); expect(ws.envelopes()).toHaveLength(2)
    fireEvent.click(screen.getByText('Home')); fireEvent.click(screen.getByText('Lock'))
    expect(ws.envelopes().slice(-2)).toEqual([{ type: 'button', button: 'home' }, { type: 'button', button: 'lock' }])
    fireEvent.click(screen.getByText('Open Simulator')); await flush()
    expect(fetch).toHaveBeenCalledWith(`/api/sims/${U}/open`, expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: { Authorization: 'Bearer owner' } }))
  })

  it('falls back on missing WebCodecs, polls snapshots every two seconds with header auth and stops when hidden', async () => {
    vi.stubGlobal('VideoDecoder', undefined)
    const { unmount } = render(<SimLiveView udid={U} token="owner" />); await flush()
    expect(Socket.instances).toHaveLength(0); expect(screen.getByText('snapshot')).toBeVisible()
    expect(screen.getByAltText('Simulator snapshot')).toHaveAttribute('src', 'blob:frame-1')
    expect(fetch).toHaveBeenCalledWith(`/api/sims/${U}/snapshot.jpg`, expect.objectContaining({ headers: { Authorization: 'Bearer owner' } }))
    await advance(2000); expect(fetch).toHaveBeenCalledTimes(2); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-1')
    changeVisibility('hidden'); await advance(10_000); expect(fetch).toHaveBeenCalledTimes(2)
    changeVisibility('visible'); await flush(); expect(fetch).toHaveBeenCalledTimes(3)
    unmount(); expect(vi.getTimerCount()).toBe(0)
  })

  it('falls back with the refusal reason and on decoder errors, keeping input disabled', async () => {
    render(<SimLiveView udid={U} token="" />)
    act(() => Socket.instances[0].onclose?.({ reason: 'Two simulators are already live' })); await flush()
    expect(screen.getByText('snapshot')).toBeVisible(); expect(screen.getByRole('status')).toHaveTextContent('Two simulators')
    expect(screen.getByText('Home')).toBeDisabled(); cleanup()
    render(<SimLiveView udid={U} token="" />); binary(1, [1, 100, 0, 31])
    act(() => Decoder.instances[0].init.error(new DOMException('bad video'))); await flush()
    expect(screen.getByText('snapshot')).toBeVisible(); expect(screen.getByRole('status')).toHaveTextContent('decoded')
  })

  it('keeps a brief hidden socket, closes after thirty seconds, reconnects on return and cancels hidden timers on unmount', async () => {
    const { unmount } = render(<SimLiveView udid={U} token="" />); meta()
    const first = Socket.instances[0]
    changeVisibility('hidden'); await advance(29_999); expect(first.close).not.toHaveBeenCalled()
    changeVisibility('visible'); await advance(10); expect(Socket.instances).toHaveLength(1)
    changeVisibility('hidden'); await advance(30_000); expect(first.close).toHaveBeenCalledOnce()
    changeVisibility('visible'); await flush(); expect(Socket.instances).toHaveLength(2)
    changeVisibility('hidden'); unmount(); await advance(30_000)
    expect(Socket.instances).toHaveLength(2); expect(Socket.instances[1].close).toHaveBeenCalledOnce()
  })

  it('reconnects the selected tile when the main daemon connection returns after a restart', async () => {
    const { rerender } = render(<SimLiveView udid={U} token="" connected />)
    const first = Socket.instances[0]
    rerender(<SimLiveView udid={U} token="" connected={false} />); await flush()
    expect(first.close).toHaveBeenCalled(); expect(screen.getByText('snapshot')).toBeVisible()
    rerender(<SimLiveView udid={U} token="" connected />)
    expect(Socket.instances).toHaveLength(2)
    expect(screen.queryByText('snapshot')).toBeNull()
  })

  it('only activates the selected tile and aborts a pending snapshot on unmount', async () => {
    const { rerender, unmount } = render(<SimLiveView udid={U} token="" active={false} />); await flush()
    expect(Socket.instances).toHaveLength(0); expect(screen.getByText('snapshot')).toBeVisible()
    rerender(<SimLiveView udid={U} token="" active />); expect(Socket.instances).toHaveLength(1)
    rerender(<SimLiveView udid={U} token="" active={false} />); expect(Socket.instances[0].close).toHaveBeenCalled()
    await flush(); const signal = vi.mocked(fetch).mock.calls.at(-1)![1]!.signal!
    unmount(); expect(signal.aborted).toBe(true)
  })
})

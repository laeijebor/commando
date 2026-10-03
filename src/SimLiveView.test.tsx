// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimLiveView, lastOrientation } from './SimLiveView'
import { SIM_ORIENTATIONS, type SimOrientation } from '../shared/sim-actions'
import { fitCanvas, nativeToScreen, ORIENTATION_TURNS, rotateOrientation, screenBottomEdge, screenSize, screenToNative } from './simGeometry'

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
  /** Parsed envelopes; coordinates are rounded to absorb floating-point scaling noise. */
  envelopes() { return this.send.mock.calls.map(([data]) => JSON.parse(data, (_key, value) => typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value)) }
}
class Decoder {
  static instances: Decoder[] = []
  state = 'unconfigured'
  configure = vi.fn(() => { this.state = 'configured' })
  decode = vi.fn()
  close = vi.fn(() => { this.state = 'closed' })
  constructor(readonly init: VideoDecoderInit) { Decoder.instances.push(this) }
}
class Recorder {
  static instances: Recorder[] = []
  static isTypeSupported = vi.fn((type: string) => type === 'video/mp4')
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  start = vi.fn(() => { this.state = 'recording' })
  stop = vi.fn(() => {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['video'], { type: this.mimeType }) })
    this.onstop?.()
  })
  mimeType: string
  constructor(readonly stream: MediaStream, options: MediaRecorderOptions) { this.mimeType = options.mimeType!; Recorder.instances.push(this) }
}
const trackStop = vi.fn()
const captureStream = vi.fn(() => ({ getTracks: () => [{ stop: trackStop }] }))
class ScreenObserver {
  static instances: ScreenObserver[] = []
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(readonly callback: ResizeObserverCallback) { ScreenObserver.instances.push(this) }
  resize(width: number, height: number) { act(() => this.callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
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
function video(width = 195, height = 422) {
  binary(1, [1, 100, 0, 31])
  act(() => Decoder.instances.at(-1)!.init.output({ displayWidth: width, displayHeight: height, close: vi.fn() } as unknown as VideoFrame))
}
function changeVisibility(value: DocumentVisibilityState) { visibility = value; fireEvent(document, new Event('visibilitychange')) }
function pointer(canvas: HTMLElement, type: string, x: number, y: number, keys: { altKey?: boolean; shiftKey?: boolean } = {}) {
  const event = new MouseEvent(type === 'pointerleave' ? 'pointerout' : type, { bubbles: true, clientX: x, clientY: y, button: 0, ...keys })
  Object.defineProperty(event, 'pointerId', { value: 7 })
  fireEvent(canvas, event)
}
beforeEach(() => {
  lastOrientation.clear()
  vi.useFakeTimers(); Socket.instances = []; Decoder.instances = []; images = []; rafs = new Map(); capture = new Set(); visibility = 'visible'; draw.mockClear()
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('VideoDecoder', Decoder)
  Recorder.instances = []; Recorder.isTypeSupported.mockImplementation((type) => type === 'video/mp4'); captureStream.mockClear(); trackStop.mockClear(); ScreenObserver.instances = []
  vi.stubGlobal('MediaRecorder', Recorder); vi.stubGlobal('ResizeObserver', ScreenObserver)
  vi.stubGlobal('EncodedVideoChunk', class { constructor(readonly init: EncodedVideoChunkInit) { Object.assign(this, init) } })
  vi.stubGlobal('Image', vi.fn(function () { const image = document.createElement('img'); images.push(image); return image }))
  vi.stubGlobal('fetch', vi.fn(async (path) => new Response(String(path).endsWith('/snapshot.jpg') ? 'jpeg' : String(path).endsWith('/schemes') ? '{"schemes":["myapp","https"]}' : '{"ok":true}')))
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 205, bottom: 442, width: 195, height: 422, toJSON: () => ({}) })
  Object.defineProperties(HTMLCanvasElement.prototype, {
    captureStream: { configurable: true, value: captureStream },
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

describe('simulator rotation geometry', () => {
  const size = { width: 390, height: 844 }
  it.each([
    ['portrait', [78, 590.8], 'bottom', 0],
    ['landscape-left', [273, 675.2], 'right', 90],
    ['portrait-upside-down', [312, 253.2], 'top', 180],
    ['landscape-right', [117, 168.8], 'left', 270],
  ] as const)('maps fractions, inverse points, bottom edge and CSS rotation for %s', (orientation, expected, edge, degrees) => {
    const native = screenToNative({ x: 0.2, y: 0.7 }, size, orientation)
    expect(native.x).toBeCloseTo(expected[0]); expect(native.y).toBeCloseTo(expected[1])
    const fraction = nativeToScreen(native, size, orientation)
    expect(fraction.x).toBeCloseTo(0.2); expect(fraction.y).toBeCloseTo(0.7)
    expect(screenBottomEdge(orientation)).toBe(edge)
    expect(ORIENTATION_TURNS[orientation] * 90).toBe(degrees)
    for (const x of [0, 1]) for (const y of [0, 1]) {
      expect(nativeToScreen(screenToNative({ x, y }, size, orientation), size, orientation)).toEqual({ x, y })
    }
  })
  it.each(SIM_ORIENTATIONS)('fits both wide and tall bounds in %s', (orientation) => {
    for (const bounds of [{ width: 200, height: 600 }, { width: 600, height: 200 }]) {
      const fitted = fitCanvas(size, bounds, orientation)
      const displayed = screenSize(fitted, orientation)
      expect(fitted.width / fitted.height).toBeCloseTo(size.width / size.height)
      expect(displayed.width).toBeLessThanOrEqual(bounds.width)
      expect(displayed.height).toBeLessThanOrEqual(bounds.height)
      expect(Math.min(bounds.width - displayed.width, bounds.height - displayed.height)).toBeCloseTo(0)
    }
    expect(rotateOrientation(rotateOrientation(orientation, 1), -1)).toBe(orientation)
  })
})

describe('SimLiveView', () => {
  const orient = async (orientation: SimOrientation) => {
    for (let step = 0; step < ORIENTATION_TURNS[orientation]; step++) {
      fireEvent.click(screen.getByRole('button', { name: 'Rotate right' })); await flush()
    }
  }
  it('steps right and left through all orientations using the focused shortcuts and menu', async () => {
    const { container } = render(<SimLiveView udid={U} token="" />); meta()
    const canvas = container.querySelector('canvas')!
    act(() => canvas.focus())
    for (const value of ['landscape-left', 'portrait-upside-down', 'landscape-right', 'portrait']) {
      fireEvent.keyDown(canvas, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true }); await flush()
      expect(fetch).toHaveBeenLastCalledWith(`/api/sims/${U}/action`, expect.objectContaining({ body: JSON.stringify({ action: 'orientation', value }) }))
    }
    fireEvent.keyDown(canvas, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }); await flush()
    expect(canvas.style.transform).toContain('rotate(270deg)')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rotate right' })); await flush()
    expect(canvas.style.transform).toContain('rotate(0deg)')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rotate left' })); await flush()
    expect(canvas.style.transform).toContain('rotate(270deg)')
    expect(Socket.instances[0].envelopes()).toEqual([])
    act(() => canvas.blur())
    fireEvent.keyDown(canvas, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true })
    expect(fetch).toHaveBeenCalledTimes(7)
  })

  it('leaves orientation unchanged after a failed action and prevents overlapping rotations', async () => {
    let reject!: (error: Error) => void
    vi.mocked(fetch).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const { container } = render(<SimLiveView udid={U} token="" />); meta()
    const canvas = container.querySelector('canvas')!
    act(() => canvas.focus())
    fireEvent.keyDown(canvas, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true })
    fireEvent.keyDown(canvas, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true })
    expect(screen.getByRole('button', { name: 'Rotate right' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menuitem', { name: 'Rotate left' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Rotate right' })).toBeDisabled()
    act(() => reject(new Error('Orientation failed'))); await flush()
    expect(canvas.style.transform).toContain('rotate(0deg)')
    expect(screen.getByRole('status')).toHaveTextContent('Orientation failed')
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rotate right' })); await flush()
    expect(canvas.style.transform).toContain('rotate(90deg)')
  })

  it.each([
    ['portrait', [97.5, 211], [156, 253.2], [195, 839], 'bottom', [20, 10], [-20, 40]],
    ['landscape-left', [97.5, 633], [117, 506.4], [385, 422], 'right', [10, -20], [40, 20]],
    ['portrait-upside-down', [292.5, 633], [234, 590.8], [195, 5], 'top', [-20, -10], [20, -40]],
    ['landscape-right', [292.5, 211], [273, 337.6], [5, 422], 'left', [-10, 20], [-40, -20]],
  ] as const)('maps taps, drags, edge envelopes, two fingers, markers and wheel in %s', async (orientation, tap, moved, bottom, edge, pan, wheel) => {
    const { container } = render(<SimLiveView udid={U} token="" />); meta(); await orient(orientation)
    const canvas = container.querySelector('canvas')!, ws = Socket.instances[0]
    const landscape = orientation.startsWith('landscape')
    const width = landscape ? 422 : 195, height = landscape ? 195 : 422
    vi.mocked(HTMLCanvasElement.prototype.getBoundingClientRect).mockReturnValue({ left: 10, top: 20, width, height } as DOMRect)
    const frame = () => act(() => { for (const callback of rafs.values()) callback(0); rafs.clear() })
    const x = 10 + width / 4, y = 20 + height / 4
    pointer(canvas, 'pointerdown', x, y)
    pointer(canvas, 'pointermove', 10 + width * 0.4, 20 + height * 0.3); frame()
    pointer(canvas, 'pointerup', 10 + width * 0.4, 20 + height * 0.3)
    expect(ws.envelopes()).toEqual([
      { type: 'touch1-down', x: tap[0], y: tap[1] },
      { type: 'touch1-move', x: moved[0], y: moved[1] },
      { type: 'touch1-up', x: moved[0], y: moved[1] },
    ])
    ws.send.mockClear()
    pointer(canvas, 'pointerdown', 10 + width / 2, 20 + height - 2.5)
    pointer(canvas, 'pointermove', 10 + width / 2, 20 + height / 2); frame()
    pointer(canvas, 'pointerup', 10 + width / 2, 20 + height / 2)
    expect(ws.envelopes()).toEqual([
      { type: 'touch1-down', x: bottom[0], y: bottom[1], edge },
      { type: 'touch1-move', x: 195, y: 422, edge }, { type: 'touch1-up', x: 195, y: 422, edge },
    ])
    ws.send.mockClear()
    pointer(canvas, 'pointerdown', x, y, { altKey: true })
    expect(ws.envelopes()[0]).toEqual({ type: 'touch2-down', x1: tap[0], y1: tap[1], x2: 390 - tap[0], y2: 844 - tap[1] })
    const markers = [...container.querySelectorAll<HTMLElement>('.sim-live-finger')]
    expect(markers.map((marker) => [marker.style.left, marker.style.top])).toEqual([
      [`${Math.round(x)}px`, `${Math.round(y)}px`], [`${Math.round(10 + width * 0.75)}px`, `${Math.round(20 + height * 0.75)}px`],
    ])
    pointer(canvas, 'pointermove', x + 10, y + 5, { altKey: true, shiftKey: true }); frame()
    expect(ws.envelopes()[1]).toEqual({ type: 'touch2-move', x1: tap[0] + pan[0], y1: tap[1] + pan[1], x2: 390 - tap[0] + pan[0], y2: 844 - tap[1] + pan[1] })
    pointer(canvas, 'pointerup', x + 10, y + 5, { altKey: true, shiftKey: true })
    ws.send.mockClear()
    fireEvent.wheel(canvas, { clientX: x, clientY: y, deltaX: 20, deltaY: -40 })
    act(() => vi.advanceTimersByTime(120))
    expect(ws.envelopes()).toEqual([
      { type: 'touch1-down', x: tap[0], y: tap[1] },
      { type: 'touch1-move', x: tap[0] + wheel[0], y: tap[1] + wheel[1] },
      { type: 'touch1-up', x: tap[0] + wheel[0], y: tap[1] + wheel[1] },
    ])
  })

  it('sizes the canvas before rotation and resizes within the live screen', async () => {
    const { container, unmount } = render(<SimLiveView udid={U} token="" />); meta()
    const canvas = container.querySelector('canvas')!, observer = ScreenObserver.instances[0]
    observer.resize(600, 400)
    expect(parseFloat(canvas.style.height)).toBe(400)
    await orient('landscape-left')
    expect(parseFloat(canvas.style.height)).toBe(600)
    expect(parseFloat(canvas.style.width)).toBeCloseTo(600 * 390 / 844)
    observer.resize(200, 100)
    expect(parseFloat(canvas.style.height)).toBe(200)
    expect(parseFloat(canvas.style.width)).toBeLessThan(100)
    unmount(); expect(observer.disconnect).toHaveBeenCalledOnce()
  })

  it('clears hover markers and releases held touches when rotation succeeds', async () => {
    const { container } = render(<SimLiveView udid={U} token="" />); meta()
    const canvas = container.querySelector('canvas')!, ws = Socket.instances[0]
    pointer(canvas, 'pointermove', 60, 120, { altKey: true })
    expect(container.querySelectorAll('.sim-live-finger')).toHaveLength(2)
    await orient('landscape-left')
    expect(container.querySelectorAll('.sim-live-finger')).toHaveLength(0)
    pointer(canvas, 'pointerdown', 107.5, 231)
    act(() => canvas.focus())
    fireEvent.keyDown(canvas, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true }); await flush()
    expect(ws.envelopes()).toEqual([{ type: 'touch1-down', x: 195, y: 422 }, { type: 'touch1-up', x: 195, y: 422 }])
    expect(capture.size).toBe(0)
    expect(container.querySelectorAll('.sim-live-finger')).toHaveLength(0)
  })

  it('waits for the recorder final data event after unmount before saving', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { unmount } = render(<SimLiveView udid={U} token="" />); meta(); video()
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    const recorder = Recorder.instances[0]
    recorder.stop.mockImplementation(() => { recorder.state = 'inactive' })
    unmount()
    expect(recorder.stop).toHaveBeenCalledOnce(); expect(click).not.toHaveBeenCalled()
    recorder.ondataavailable?.({ data: new Blob(['final frame'], { type: 'video/mp4' }) })
    recorder.onstop?.()
    expect(click).toHaveBeenCalledOnce(); expect(trackStop).toHaveBeenCalledOnce()
    await advance(1000); expect(vi.getTimerCount()).toBe(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith((click.mock.contexts[0] as HTMLAnchorElement).href)
  })

  it.each(['mp4', 'webm'])('records canvas video, shows elapsed time and downloads matching %s', async (extension) => {
    Recorder.isTypeSupported.mockImplementation((type) => extension === 'mp4' && type === 'video/mp4')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<SimLiveView udid={U} token="" />); meta(); video()
    expect(screen.getByRole('button', { name: 'Record' })).not.toHaveAttribute('title', expect.stringContaining('unrotated'))
    await orient('landscape-left')
    expect(screen.getByRole('button', { name: 'Record' })).toHaveAttribute('title', expect.stringContaining('unrotated canvas pixels'))
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect(captureStream).toHaveBeenCalledWith(30)
    expect(Recorder.instances[0].mimeType).toBe(`video/${extension}`)
    expect(Recorder.instances[0].start).toHaveBeenCalledWith(1000)
    expect(screen.getByRole('button', { name: 'Stop recording' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Stop recording' })).toHaveTextContent('00:00')
    await advance(65_000)
    expect(screen.getByRole('button', { name: 'Stop recording' })).toHaveTextContent('01:05')
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(Recorder.instances[0].stop).toHaveBeenCalledOnce(); expect(trackStop).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Record' })).toHaveAttribute('aria-pressed', 'false')
    expect(click).toHaveBeenCalledOnce()
    expect(click.mock.contexts[0]).toHaveProperty('download', expect.stringMatching(new RegExp(`^simulator-AAAAAAAA-[\\dTZ-]+\\.${extension}$`)))
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob
    expect(blob.type).toBe(`video/${extension}`); expect(blob.size).toBe(5)
    const url = (click.mock.contexts[0] as HTMLAnchorElement).href
    await advance(1000); expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
  })

  it.each(['stream drop', 'hidden timeout', 'unmount', 'daemon disconnect'])('stops and saves recording on %s', async (end) => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { unmount, rerender } = render(<SimLiveView udid={U} token="" />); meta(); video()
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    const recorder = Recorder.instances[0]
    if (end === 'stream drop') act(() => Socket.instances[0].onclose?.({ reason: 'Lost stream' }))
    else if (end === 'hidden timeout') {
      changeVisibility('hidden'); await advance(29_999)
      expect(recorder.stop).not.toHaveBeenCalled()
      await advance(1)
    } else if (end === 'unmount') unmount()
    else rerender(<SimLiveView udid={U} token="" connected={false} />)
    await flush()
    expect(recorder.stop).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce(); expect(trackStop).toHaveBeenCalledOnce()
    unmount(); await advance(1000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith((click.mock.contexts[0] as HTMLAnchorElement).href)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['MediaRecorder', 'captureStream', 'snapshot'])('disables recording when %s is unavailable', (missing) => {
    if (missing === 'MediaRecorder') vi.stubGlobal('MediaRecorder', undefined)
    if (missing === 'captureStream') Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: undefined })
    if (missing === 'snapshot') vi.stubGlobal('VideoDecoder', undefined)
    render(<SimLiveView udid={U} token="" />)
    if (missing !== 'snapshot') meta()
    const record = screen.getByRole('button', { name: 'Record' })
    expect(record).toBeDisabled(); fireEvent.click(record)
    expect(Recorder.instances).toHaveLength(0)
  })

  it('shows nine named icon buttons with tooltips and no toolbar in preview mode', () => {
    const { container, unmount } = render(<SimLiveView udid={U} token="" />)
    for (const name of ['Home', 'App Switcher', 'Lock', 'Screenshot', 'Rotate right', 'Record', 'Toggle Light/Dark', 'Open URL', 'More']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveAttribute('title')
      expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
      expect(button).toHaveTextContent('')
    }
    expect(container.querySelectorAll('.sim-live-toolbar > button')).toHaveLength(9)
    expect(screen.getByRole('button', { name: 'Home' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Toggle Light/Dark' })).toBeEnabled()
    unmount()
    const preview = render(<SimLiveView udid={U} token="" preview />)
    expect(preview.container.querySelector('.sim-live-toolbar')).toBeNull()
  })

  it('opens More, moves focus, closes on Escape/outside click and returns focus', () => {
    render(<SimLiveView udid={U} token="" />); meta()
    const more = screen.getByRole('button', { name: 'More' })
    expect(more).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitem', { name: 'Volume up' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Volume down' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(screen.getByRole('menuitem', { name: 'Open in Simulator' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull(); expect(more).toHaveFocus()
    fireEvent.click(more); fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull(); expect(more).toHaveFocus()
    expect(more).toHaveAttribute('aria-expanded', 'false')
  })

  it.each([
    ['Shake', { action: 'shake' }],
    ['Clean status bar', { action: 'status-bar', mode: 'clean' }], ['Reset status bar', { action: 'status-bar', mode: 'clear' }],
    ['Text size larger', { action: 'text-size', step: 1 }], ['Text size smaller', { action: 'text-size', step: -1 }],
    ['Increase contrast on', { action: 'contrast', enabled: true }], ['Increase contrast off', { action: 'contrast', enabled: false }],
    ['Reduce motion on', { action: 'reduce-motion', enabled: true }], ['Reduce motion off', { action: 'reduce-motion', enabled: false }],
    ...['off', 'offline', '3g', 'lte', 'lossy'].map((profile): [string, unknown] => [`Network: ${profile}`, { action: 'network', profile }]),
  ])('sends %s from More and closes it', async (name, body) => {
    render(<SimLiveView udid={U} token="owner" />)
    const more = screen.getByRole('button', { name: 'More' })
    fireEvent.click(more); fireEvent.click(screen.getByRole('menuitem', { name: name as string })); await flush()
    expect(fetch).toHaveBeenCalledWith(`/api/sims/${U}/action`, expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }))
    expect(screen.queryByRole('menu')).toBeNull(); expect(more).toHaveFocus()
  })

  it('confirms Repair input and sends nothing on cancellation', async () => {
    render(<SimLiveView udid={U} token="" />)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const more = screen.getByRole('button', { name: 'More' })
    fireEvent.click(more); fireEvent.click(screen.getByRole('menuitem', { name: 'Repair input' }))
    expect(confirm).toHaveBeenCalledWith("This restarts the simulator's home screen")
    expect(fetch).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Repair input' })); await flush()
    expect(fetch).toHaveBeenCalledWith(`/api/sims/${U}/action`, expect.objectContaining({ body: '{"action":"heal"}' }))
    expect(screen.queryByRole('menu')).toBeNull(); expect(more).toHaveFocus()
  })

  it('loads schemes on opening the URL popover, submits a custom deep link on Enter and returns focus', async () => {
    render(<SimLiveView udid={U} token="owner" />)
    expect(fetch).not.toHaveBeenCalled()
    const open = screen.getByRole('button', { name: 'Open URL' })
    fireEvent.click(open); await flush()
    expect(fetch).toHaveBeenCalledWith(`/api/sims/${U}/schemes`, expect.objectContaining({ method: 'GET' }))
    const input = screen.getByRole('combobox', { name: 'Open URL / deep link' })
    expect(input).toHaveFocus()
    expect(document.querySelector('datalist option[value="myapp://"]')).not.toBeNull()
    fireEvent.change(input, { target: { value: 'custom://path?a=1' } })
    // Submitting the form is the browser's default action for Enter in this field.
    fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.submit(input.closest('form')!); await flush()
    expect(fetch).toHaveBeenLastCalledWith(`/api/sims/${U}/action`, expect.objectContaining({ body: '{"action":"open-url","url":"custom://path?a=1"}' }))
    expect(screen.queryByRole('combobox')).toBeNull(); expect(open).toHaveFocus()
    fireEvent.click(open); await flush(); fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('combobox')).toBeNull(); expect(open).toHaveFocus()
  })

  it('routes ⌘⇧A and the appearance icon to a single pending action, then shows errors', async () => {
    let reject!: (error: Error) => void
    vi.mocked(fetch).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const { container } = render(<SimLiveView udid={U} token="" />); meta()
    const canvas = container.querySelector('canvas')!
    act(() => canvas.focus())
    fireEvent.keyDown(canvas, { key: 'A', code: 'KeyA', metaKey: true, shiftKey: true })
    const toggle = screen.getByRole('button', { name: 'Toggle Light/Dark' })
    expect(toggle).toBeDisabled()
    fireEvent.keyDown(canvas, { key: 'A', code: 'KeyA', metaKey: true, shiftKey: true })
    fireEvent.click(toggle)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(`/api/sims/${U}/action`, expect.objectContaining({ body: '{"action":"appearance","value":"toggle"}' }))
    expect(Socket.instances[0].envelopes()).toEqual([])
    act(() => reject(new Error('baguette failed: input unavailable'))); await flush()
    expect(screen.getByRole('status')).toHaveTextContent('input unavailable'); expect(toggle).toBeEnabled()
    vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}'))
    fireEvent.click(toggle); await flush()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('disables both controls for a pending menu action while preserving other actions', async () => {
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockImplementation(() => new Promise((done) => { resolve = done }))
    render(<SimLiveView udid={U} token="" />)
    const more = screen.getByRole('button', { name: 'More' })
    fireEvent.click(more); fireEvent.click(screen.getByRole('menuitem', { name: 'Text size larger' })); fireEvent.click(more)
    expect(screen.getByRole('menuitem', { name: 'Text size larger' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Text size smaller' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Shake' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: 'Volume up' })).toBeDisabled()
    act(() => resolve(new Response('{"ok":true}'))); await flush()
    expect(screen.getByRole('menuitem', { name: 'Text size smaller' })).toBeEnabled()
  })

  it('keeps a failed URL open for correction and reports scheme-loading errors', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":"Unable to load schemes"}', { status: 500 }))
    render(<SimLiveView udid={U} token="" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open URL' })); await flush()
    expect(screen.getByRole('status')).toHaveTextContent('Unable to load schemes')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bad-url' } })
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":"Invalid simulator action or parameters"}', { status: 400 }))
    fireEvent.click(screen.getByRole('button', { name: 'Open' })); await flush()
    expect(screen.getByRole('status')).toHaveTextContent('Invalid simulator action')
    expect(screen.getByRole('combobox')).toHaveValue('bad-url')
  })

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

  it.each([false, true])('maps points, captures, coalesces moves and releases on cancel/leave/focus loss/unmount (preview=%s)', (preview) => {
    const { container, unmount } = render(<SimLiveView udid={U} token="" preview={preview} />); meta(); if (preview) video()
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
    pointer(canvas, 'pointerdown', 10, 20); if (preview) fireEvent(canvas, new Event('lostpointercapture', { bubbles: true })); else fireEvent.blur(canvas); expect(ws.envelopes().at(-1).type).toBe('touch1-up')
    pointer(canvas, 'pointerdown', 10, 20); unmount(); expect(ws.envelopes().at(-1).type).toBe('touch1-up')
  })

  it.each([false, true])('pinches/rotates with Option, pans with Shift, shows fingers and flags edge swipes (preview=%s)', (preview) => {
    const { container } = render(<SimLiveView udid={U} token="" preview={preview} />); meta(); if (preview) video()
    const canvas = container.querySelector('canvas')!; const ws = Socket.instances[0]
    const frame = () => act(() => { for (const callback of rafs.values()) callback(0); rafs.clear() })
    const fingers = () => [...container.querySelectorAll<HTMLElement>('.sim-live-finger')].map((finger) => [finger.style.left, finger.style.top, finger.classList.contains('is-pressed')])
    pointer(canvas, 'pointermove', 60, 120, { altKey: true })
    expect(ws.envelopes()).toEqual([]); expect(fingers()).toEqual([['60px', '120px', false], ['155px', '342px', false]])
    pointer(canvas, 'pointermove', 60, 120); expect(fingers()).toEqual([])
    pointer(canvas, 'pointerdown', 60, 120, { altKey: true })
    expect(ws.envelopes()[0]).toEqual({ type: 'touch2-down', x1: 100, y1: 200, x2: 290, y2: 644 })
    expect(fingers().every(([, , pressed]) => pressed)).toBe(true)
    pointer(canvas, 'pointermove', 85, 170, { altKey: true }); frame()
    expect(ws.envelopes()[1]).toEqual({ type: 'touch2-move', x1: 150, y1: 300, x2: 240, y2: 544 })
    pointer(canvas, 'pointermove', 90, 180, { altKey: true, shiftKey: true }); frame()
    expect(ws.envelopes()[2]).toEqual({ type: 'touch2-move', x1: 160, y1: 320, x2: 250, y2: 564 })
    pointer(canvas, 'pointerup', 90, 180, { altKey: true, shiftKey: true })
    expect(ws.envelopes()[3]).toEqual({ type: 'touch2-up', x1: 160, y1: 320, x2: 250, y2: 564 }); expect(fingers()).toEqual([])
    pointer(canvas, 'pointerdown', 107.5, 438); pointer(canvas, 'pointermove', 107.5, 231); frame(); pointer(canvas, 'pointerup', 107.5, 231)
    expect(ws.envelopes().slice(4)).toEqual([{ type: 'touch1-down', x: 195, y: 836, edge: 'bottom' }, { type: 'touch1-move', x: 195, y: 422, edge: 'bottom' }, { type: 'touch1-up', x: 195, y: 422, edge: 'bottom' }])
  })

  it('pastes host text, maps Simulator shortcuts, sends the extra buttons and saves a screenshot', () => {
    const { container } = render(<SimLiveView udid={U} token="" />); meta()
    const canvas = container.querySelector('canvas')!; const ws = Socket.instances[0]
    act(() => canvas.focus())
    expect(fireEvent.keyDown(canvas, { key: 'v', code: 'KeyV', metaKey: true })).toBe(true)
    fireEvent.paste(canvas, { clipboardData: { getData: () => 'héllo' } })
    fireEvent.keyDown(canvas, { key: 'Alt', code: 'AltLeft', altKey: true })
    fireEvent.keyDown(canvas, { key: 'H', code: 'KeyH', metaKey: true, shiftKey: true }); fireEvent.keyDown(canvas, { key: 'l', code: 'KeyL', metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'App Switcher' }))
    for (const name of ['Volume down', 'Volume up']) {
      fireEvent.click(screen.getByRole('button', { name: 'More' }))
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }
    expect(ws.envelopes()).toEqual([{ type: 'paste', text: 'héllo', press: true }, ...['home', 'lock', 'app-switcher', 'volume-down', 'volume-up'].map((button) => ({ type: 'button', button }))])
    const toBlob = vi.fn((done: BlobCallback) => done(new Blob(['png'])))
    Object.defineProperty(canvas, 'toBlob', { value: toBlob })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }))
    expect(toBlob).toHaveBeenCalled(); expect(click).toHaveBeenCalled()
    expect(click.mock.contexts[0]).toHaveProperty('download', expect.stringMatching(/\.png$/))
  })

  it('saves fallback snapshots as JPEG and reports preview streaming only once video is ready', async () => {
    vi.stubGlobal('VideoDecoder', undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const fallback = render(<SimLiveView udid={U} token="" />); await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }))
    expect(click.mock.contexts[0]).toHaveProperty('download', expect.stringMatching(/\.jpg$/))
    fallback.unmount(); vi.stubGlobal('VideoDecoder', Decoder)
    const onStreaming = vi.fn()
    const { container, unmount } = render(<SimLiveView udid={U} token="" preview onStreaming={onStreaming} />)
    expect(onStreaming).not.toHaveBeenCalled(); expect(container.querySelector('canvas')).not.toBeVisible()
    meta(); expect(onStreaming).not.toHaveBeenCalled(); expect(container.querySelector('canvas')).not.toBeVisible()
    binary(4, [255, 216]); Object.defineProperties(images[0], { naturalWidth: { value: 195 }, naturalHeight: { value: 422 } }); fireEvent.load(images[0])
    expect(onStreaming).not.toHaveBeenCalled(); expect(container.querySelector('canvas')).not.toBeVisible()
    video(); expect(onStreaming.mock.calls).toEqual([[true]]); expect(container.querySelector('canvas')).toBeVisible()
    unmount(); expect(onStreaming.mock.calls).toEqual([[true], [false]])
  })

  it.each([
    { width: 300, height: 900, x: 100, y: 215, expected: { x: 150, y: 325 } },
    { width: 600, height: 900, x: 35, y: 150, expected: { x: 150, y: 300 } },
  ])('maps top-aligned cover crops for a $width × $height device in a 9/19.5 card', ({ width, height, x, y, expected }) => {
    vi.mocked(HTMLCanvasElement.prototype.getBoundingClientRect).mockReturnValue({ left: 10, top: 20, width: 180, height: 390 } as DOMRect)
    const { container } = render(<SimLiveView udid={U} token="" preview />)
    const ws = Socket.instances[0]
    ws.message(JSON.stringify({ type: 'meta', width, height })); video(width / 2, height / 2)
    const canvas = container.querySelector('canvas')!
    pointer(canvas, 'pointerdown', x, y)
    expect(ws.envelopes()).toEqual([{ type: 'touch1-down', ...expected }])
    const marker = container.querySelector<HTMLElement>('.sim-live-finger')!
    expect(marker.style.left).toBe(`${x}px`); expect(marker.style.top).toBe(`${y}px`)
    pointer(canvas, 'pointerup', x, y)
    expect(ws.envelopes().at(-1)).toEqual({ type: 'touch1-up', ...expected })
  })

  it('scrolls a streaming preview without taking focus, handling keys/paste or showing full-view controls', () => {
    const { container } = render(<><button>Keep focus</button><SimLiveView udid={U} token="" preview /></>)
    const canvas = container.querySelector('canvas')!; const ws = Socket.instances[0]
    const focused = screen.getByRole('button', { name: 'Keep focus' }); focused.focus()
    meta(); pointer(canvas, 'pointerdown', 60, 120); fireEvent.wheel(canvas, { deltaY: 50 })
    expect(ws.envelopes()).toEqual([])
    video(); pointer(canvas, 'pointerdown', 60, 120); pointer(canvas, 'pointerup', 60, 120)
    expect(focused).toHaveFocus(); expect(canvas).not.toHaveAttribute('tabindex')
    expect(fireEvent.wheel(canvas, { deltaY: -50, clientX: 60, clientY: 120 })).toBe(false)
    expect(fireEvent.keyDown(canvas, { key: 'H', code: 'KeyH', metaKey: true, shiftKey: true })).toBe(true)
    expect(fireEvent.keyUp(canvas, { key: 'Alt' })).toBe(true)
    expect(fireEvent.paste(canvas, { clipboardData: { getData: () => 'text' } })).toBe(true)
    expect(ws.envelopes().map((envelope) => envelope.type)).toEqual(['touch1-down', 'touch1-up', 'touch1-down', 'touch1-move'])
    expect(container.querySelector('.sim-live-toolbar')).toBeNull(); expect(container.querySelector('.sim-live-hint')).toBeNull()
    act(() => ws.onerror?.()); fireEvent.wheel(canvas, { deltaY: 50 })
    expect(ws.envelopes()).toHaveLength(4); expect(container.querySelector('canvas')).toBeNull()
  })

  it('releases a captured preview drag ending outside the card and releases on stream failure', () => {
    const { container } = render(<SimLiveView udid={U} token="" preview />); meta(); video()
    const canvas = container.querySelector('canvas')!; const ws = Socket.instances[0]
    pointer(canvas, 'pointerdown', 60, 120)
    pointer(canvas, 'pointermove', 300, 500)
    // Browsers retarget an outside release to the canvas while it holds pointer capture.
    pointer(canvas, 'pointerup', 300, 500)
    expect(ws.envelopes()).toEqual([{ type: 'touch1-down', x: 100, y: 200 }, { type: 'touch1-up', x: 390, y: 844 }])
    expect(capture.size).toBe(0); expect(rafs.size).toBe(0); expect(container.querySelector('.sim-live-finger')).toBeNull()
    pointer(canvas, 'pointerdown', 60, 120, { altKey: true }); act(() => ws.onerror?.())
    expect(ws.envelopes().at(-1)).toEqual({ type: 'touch2-up', x1: 100, y1: 200, x2: 290, y2: 644 })
    expect(capture.size).toBe(0)
  })

  it('sends wheel, focused code/modifier keys and toolbar buttons; Escape releases focus', async () => {
    const { container } = render(<SimLiveView udid={U} token="owner" />); meta()
    const canvas = container.querySelector('canvas')!; const ws = Socket.instances[0]
    // The wheel drives a one-finger drag: no press until real travel, content follows the finger, lift when idle.
    fireEvent.wheel(canvas, { deltaY: -4, clientX: 107.5, clientY: 231 }); expect(ws.envelopes()).toEqual([])
    fireEvent.wheel(canvas, { deltaY: -46, clientX: 107.5, clientY: 231 }); fireEvent.wheel(canvas, { deltaY: -10, clientX: 150, clientY: 300 })
    act(() => { vi.advanceTimersByTime(120) })
    expect(ws.envelopes()).toEqual([{ type: 'touch1-down', x: 195, y: 422 }, { type: 'touch1-move', x: 195, y: 472 }, { type: 'touch1-move', x: 195, y: 482 }, { type: 'touch1-up', x: 195, y: 482 }])
    fireEvent.wheel(canvas, { deltaY: 5000, clientX: 107.5, clientY: 231 })
    expect(ws.envelopes().slice(4)).toEqual([{ type: 'touch1-down', x: 195, y: 422 }, { type: 'touch1-move', x: 195, y: 0 }, { type: 'touch1-up', x: 195, y: 0 }])
    ws.send.mockClear()
    act(() => canvas.focus()); expect(canvas).toHaveClass('is-focused')
    fireEvent.keyDown(canvas, { key: 'B', code: 'KeyB', shiftKey: true, metaKey: true })
    expect(ws.envelopes()).toEqual([{ type: 'key', code: 'KeyB', modifiers: ['shift', 'command'] }])
    fireEvent.keyDown(canvas, { key: 'Escape', code: 'Escape' }); expect(canvas).not.toHaveFocus(); expect(canvas).not.toHaveClass('is-focused')
    fireEvent.keyDown(canvas, { key: 'b', code: 'KeyB' }); expect(ws.envelopes()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Home' })); fireEvent.click(screen.getByRole('button', { name: 'Lock' }))
    expect(ws.envelopes().slice(-2)).toEqual([{ type: 'button', button: 'home' }, { type: 'button', button: 'lock' }])
    fireEvent.click(screen.getByRole('button', { name: 'More' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Simulator' })); await flush()
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
    expect(screen.getByRole('button', { name: 'Home' })).toBeDisabled(); cleanup()
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

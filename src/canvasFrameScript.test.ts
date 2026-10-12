// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(`${process.cwd()}/server/static/canvas-frame.js`, 'utf8')
let listeners: Array<[string, EventListenerOrEventListenerObject]> = []
let observers: MutationObserver[] = []
let post: ReturnType<typeof vi.spyOn>
let elementAtPoint: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  const script = document.createElement('script')
  script.dataset.canvasFrame = 'settings'
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script)
  post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => { listeners.push([type, listener]); add(type, listener, options) })
  const NativeObserver = MutationObserver
  vi.stubGlobal('MutationObserver', class extends NativeObserver { constructor(callback: MutationCallback) { super(callback); observers.push(this) } })
  elementAtPoint = vi.fn()
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementAtPoint })
})
afterEach(() => {
  listeners.forEach(([type, listener]) => window.removeEventListener(type, listener)); listeners = []
  observers.forEach((observer) => observer.disconnect()); observers = []
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
const boot = () => window.eval(source)
const latest = () => post.mock.calls.at(-1)?.[0]
function hit(element: Element | null, extras = {}, messageSource: MessageEventSource | null = window) {
  elementAtPoint.mockReturnValue(element)
  window.dispatchEvent(new MessageEvent('message', { source: messageSource, data: { source: 'commando-canvas', type: 'hit-test', requestId: 'r1', x: 10, y: 20, ...extras } }))
  return latest()
}
function box(element: Element) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 30, height: 40, right: 40, bottom: 60, x: 10, y: 20, toJSON() {} })
}
describe('canvas frame script', () => {
  it('reports labels in document order, inherits nearest groups and adds document scroll offsets', async () => {
    document.body.innerHTML = '<section data-canvas-group="Accounts"><button data-canvas-label="Row" data-canvas-id="outlook"></button><div data-canvas-group="Nested"><b data-canvas-label="Title"></b></div></section><footer data-canvas-label="Footer"></footer>'
    document.querySelectorAll('[data-canvas-label]').forEach(box)
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(5)
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(100)
    boot()
    window.dispatchEvent(new Event('load'))
    expect(latest()).toEqual({ source: 'commando-canvas-frame', frameId: 'settings', type: 'labels', labels: [
      { name: 'Row', group: 'Accounts', id: 'outlook', rect: { x: 15, y: 120, w: 30, h: 40 } },
      { name: 'Title', group: 'Nested', rect: { x: 15, y: 120, w: 30, h: 40 } },
      { name: 'Footer', rect: { x: 15, y: 120, w: 30, h: 40 } },
    ] })
    post.mockClear()
    document.querySelector('button')!.setAttribute('data-canvas-label', 'Renamed')
    document.querySelector('footer')!.remove()
    await Promise.resolve()
    expect(post).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(latest().labels.map((label: { name: string }) => label.name)).toEqual(['Renamed', 'Title'])
    post.mockClear()
    window.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(100)
    expect(latest().type).toBe('labels')
    document.dispatchEvent(new Event('DOMContentLoaded'))
    expect(latest().type).toBe('labels')
  })
  it('hit-tests viewport CSS pixels and replies with nearest label and element document rect', () => {
    document.body.innerHTML = '<div data-canvas-label="Row" data-canvas-id="row"><span id="hit">Text</span></div>'
    const element = document.querySelector('span')!
    box(element); boot()
    const result = hit(element)
    expect(elementAtPoint).toHaveBeenCalledWith(10, 20)
    expect(result).toMatchObject({ source: 'commando-canvas-frame', frameId: 'settings', type: 'hit', requestId: 'r1', rect: { x: 10, y: 20, w: 30, h: 40 }, label: 'Row', labelId: 'row' })
    expect(document.querySelector(result.selector)).toBe(element)
    expect(result.selector.startsWith('#')).toBe(true)
    expect(hit(null)).toMatchObject({ requestId: 'r1', selector: null, rect: null })
  })
  it('prefers stable IDs, escapes unusual characters and falls back to a unique nth-of-type path', () => {
    document.body.innerHTML = '<div><button>A</button><button>B</button></div><div><button>C</button><button>D</button></div>'
    boot()
    const element = document.querySelectorAll('button')[3]
    let result = hit(element)
    expect(result.selector).toContain('nth-of-type(2)')
    expect(document.querySelector(result.selector)).toBe(element)
    element.id = '123: "quoted"'
    element.setAttribute('data-canvas-id', 'stable"\\\nvalue')
    result = hit(element)
    expect(result.selector.startsWith('[data-canvas-id=')).toBe(true)
    expect(document.querySelector(result.selector)).toBe(element)
    document.querySelector('div')!.id = 'region'
    element.removeAttribute('id'); element.removeAttribute('data-canvas-id')
    expect(document.querySelector(hit(element).selector)).toBe(element)
    element.id = '-'
    expect(document.querySelector(hit(element).selector)).toBe(element)
    element.setAttribute('data-canvas-id', 'duplicate')
    document.querySelector('button')!.setAttribute('data-canvas-id', 'duplicate')
    expect(hit(element).selector.startsWith('#')).toBe(true)
  })
  it('ignores foreign windows, wrong protocols and malformed hit coordinates', () => {
    boot(); post.mockClear()
    hit(document.body, {}, null)
    hit(document.body, { source: 'other' })
    hit(document.body, { x: Infinity })
    hit(document.body, { requestId: {} })
    expect(post).not.toHaveBeenCalled()
  })
  it('relays the redline SDK binding and applies only parent pending snapshots', () => {
    boot()
    const binding = (window as unknown as { __commandoRedlineQueue: (payload: string) => void }).__commandoRedlineQueue
    const payload = JSON.stringify({ question: 'Ship?', answer: 'Yes' })
    binding(payload)
    expect(latest()).toEqual({ source: 'commando-canvas-frame', frameId: 'settings', type: 'redline-queue', payload })
    const listener = vi.fn()
    window.addEventListener('commando:redline-pending', listener)
    const snapshot = { version: 1, controls: [{ queueKey: 'ship', response: { question: 'Ship?', answer: 'Yes' } }] }
    const data = { source: 'commando-canvas', type: 'redline-pending', snapshot }
    window.dispatchEvent(new MessageEvent('message', { source: null, data }))
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { ...data, source: 'other' } }))
    expect(listener).not.toHaveBeenCalled()
    window.dispatchEvent(new MessageEvent('message', { source: window, data }))
    expect((window as unknown as { __commandoRedlinePendingSnapshot: unknown }).__commandoRedlinePendingSnapshot).toEqual(snapshot)
    expect(listener.mock.calls[0][0].detail).toEqual(snapshot)
    window.dispatchEvent(new MessageEvent('message', { source: window, data }))
    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener('commando:redline-pending', listener)
  })
  it('does not initialize with an invalid frame id', () => {
    const script = document.currentScript as HTMLScriptElement
    script.dataset.canvasFrame = 'bad/id'
    boot(); window.dispatchEvent(new Event('load'))
    expect(post).not.toHaveBeenCalled()
  })
})

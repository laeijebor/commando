// @vitest-environment jsdom
/// <reference types="node" />
import { TextEncoder } from 'node:util'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(`${process.cwd()}/server/static/canvas-frame.js`, 'utf8')
let listeners: Array<[string, EventListenerOrEventListenerObject]> = []
let observers: MutationObserver[] = []
let post: ReturnType<typeof vi.spyOn>
let elementAtPoint: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('TextEncoder', TextEncoder)
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
  listeners.forEach(([type, listener]) => { window.removeEventListener(type, listener, true); window.removeEventListener(type, listener) }); listeners = []
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
  it('intercepts nested goto clicks only while live, relays Esc and modifier-wheel, and leaves ordinary scrolling native', () => {
    document.body.innerHTML = '<a href="#native" data-canvas-goto="accounts"><span>Go</span></a>'
    boot(); post.mockClear()
    const click = () => { const event = new MouseEvent('click', { bubbles: true, cancelable: true }); document.querySelector('span')!.dispatchEvent(event); return event }
    expect(click().defaultPrevented).toBe(false)
    const activate = { source: 'commando-canvas', type: 'interaction', live: true }
    window.dispatchEvent(new MessageEvent('message', { source: null, data: activate }))
    expect(click().defaultPrevented).toBe(false)
    window.dispatchEvent(new MessageEvent('message', { source: window, data: activate }))
    expect(click().defaultPrevented).toBe(true)
    expect(latest()).toMatchObject({ type: 'goto', target: 'accounts', frameId: 'settings' })
    const scroll = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 10 })
    document.body.dispatchEvent(scroll); expect(scroll.defaultPrevented).toBe(false)
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -12, clientX: 20, clientY: 30, ...modifier })
      document.body.dispatchEvent(wheel); expect(wheel.defaultPrevented).toBe(true)
      expect(latest()).toMatchObject({ type: 'zoom', deltaY: -12, deltaMode: 0, x: 20, y: 30 })
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(latest()).toMatchObject({ type: 'escape' })
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { ...activate, live: false } }))
    post.mockClear(); expect(click().defaultPrevented).toBe(false)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(post).not.toHaveBeenCalled()
  })
  it('reports labels in document order, inherits nearest groups in viewport coordinates', async () => {
    document.body.innerHTML = '<section data-canvas-group="Accounts"><button data-canvas-label="Row" data-canvas-id="outlook"></button><div data-canvas-group="Nested"><b data-canvas-label="Title"></b></div></section><footer data-canvas-label="Footer"></footer>'
    document.querySelectorAll('[data-canvas-label]').forEach(box)
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(5)
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(100)
    boot()
    window.dispatchEvent(new Event('load'))
    expect(latest()).toEqual({ source: 'commando-canvas-frame', frameId: 'settings', type: 'labels', labels: [
      { name: 'Row', group: 'Accounts', id: 'outlook', rect: { x: 10, y: 20, w: 30, h: 40 } },
      { name: 'Title', group: 'Nested', rect: { x: 10, y: 20, w: 30, h: 40 } },
      { name: 'Footer', rect: { x: 10, y: 20, w: 30, h: 40 } },
    ], hotspots: [] })
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
  it('reports click-through links and author hotspots with optional tooltips', () => {
    document.body.innerHTML = '<a data-canvas-goto="accounts">Go</a><button data-canvas-hotspot="Toggles dark mode">Theme</button>' +
      '<button data-canvas-hotspot>Bare</button><a data-canvas-goto="../bad" data-canvas-hotspot="Tip">Odd</a>'
    document.querySelectorAll('a, button').forEach(box)
    boot(); window.dispatchEvent(new Event('load'))
    const rect = { x: 10, y: 20, w: 30, h: 40 }
    expect(latest().hotspots).toEqual([{ rect, goto: 'accounts' }, { rect, tip: 'Toggles dark mode' }, { rect }])
  })
  it('skips hotspots that are disabled, invisible, transparent, clipped away or covered', () => {
    document.body.innerHTML = '<button data-canvas-hotspot="a" style="visibility:hidden">A</button><button data-canvas-hotspot="b" style="opacity:0">B</button>' +
      '<div style="opacity:0"><button data-canvas-hotspot="c">C</button></div><div style="overflow:hidden" id="clip"><button data-canvas-hotspot="d">D</button></div>' +
      '<button data-canvas-goto="accounts" disabled>Off</button><button data-canvas-hotspot="e">E</button><button data-canvas-hotspot="f">F</button>'
    document.querySelectorAll('button').forEach(box)
    vi.spyOn(document.getElementById('clip')!, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 100, width: 50, height: 50, right: 150, bottom: 150, x: 100, y: 100, toJSON() {} })
    const rect = { x: 10, y: 20, w: 30, h: 40 }
    boot(); window.dispatchEvent(new Event('load'))
    expect(latest().hotspots).toEqual([{ rect, tip: 'e' }, { rect, tip: 'f' }])
    elementAtPoint.mockImplementation(() => document.querySelectorAll('button')[6]) // F covers E's centre
    window.dispatchEvent(new Event('load'))
    expect(latest().hotspots).toEqual([{ rect, tip: 'f' }])
  })
  it('does not clip by a short body with overflow hidden, since that clips the viewport instead', () => {
    document.body.style.overflow = 'hidden'
    document.body.innerHTML = '<nav style="position:fixed"><button data-canvas-goto="accounts">Tab</button></nav>'
    box(document.querySelector('button')!)
    vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 390, height: 10, right: 390, bottom: 10, x: 0, y: 0, toJSON() {} })
    boot(); window.dispatchEvent(new Event('load'))
    expect(latest().hotspots).toHaveLength(1)
    document.body.style.overflow = ''
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

it('debounces window and nested non-bubbling scroll reports, retaining document coordinates for hits', () => {
  document.body.innerHTML = '<div id="scroll"><b data-canvas-label="Row"></b></div>'
  const row = document.querySelector('b')!; box(row)
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(100)
  boot(); post.mockClear()
  window.dispatchEvent(new Event('scroll')); document.querySelector('div')!.dispatchEvent(new Event('scroll'))
  vi.advanceTimersByTime(99); expect(post).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1); expect(latest().labels[0].rect.y).toBe(20)
  expect(hit(row).rect.y).toBe(120)
})
it('caps emitted labels and excludes oversized names and unsafe geometry', () => {
  document.body.innerHTML = Array.from({ length: 1005 }, () => '<b data-canvas-label="Row"></b>').join('')
  document.querySelectorAll('b').forEach(box)
  document.querySelector('b')!.setAttribute('data-canvas-label', 'x'.repeat(201))
  boot(); window.dispatchEvent(new Event('load'))
  expect(latest().labels).toHaveLength(999)
})

it('drops reports that exceed the total UTF-8 payload budget', () => {
  document.body.innerHTML = Array.from({ length: 1000 }, () => `<b data-canvas-label="${'雪'.repeat(200)}" data-canvas-group="${'雪'.repeat(200)}"></b>`).join('')
  boot(); window.dispatchEvent(new Event('load'))
  expect(post).not.toHaveBeenCalled()
})

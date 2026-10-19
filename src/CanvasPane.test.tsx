// @vitest-environment jsdom
/// <reference types="node" />
import { canvasPendingSnapshotForPage } from './canvasFrameBridge'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPane } from '../shared/protocol'
import { CanvasPane } from './CanvasPane'
import { WebPaneCard } from './WebPaneCard'
import { publishCanvasChange } from './webPanesApi'
import { parseCanvasManifest } from '../shared/canvas-manifest'

// Vitest skips CSS, so the layout contract is read from source.
const canvasPaneCss = readFileSync(`${process.cwd()}/src/canvas-pane.css`, 'utf8')
const artifactId = '0123456789abcdef'
const example = {
  title: 'Settings board',
  sections: [{ id: 'section', title: 'Settings, regrouped', ticket: 'GIZMO-6094', status: 'ready-for-dev', frames: ['settings', 'accounts'] }],
  frames: [{ id: 'settings', title: 'Settings', platform: 'Mobile', src: 'Settings.html', x: 0, y: 0, focus: 1, interactive: true },
    { id: 'accounts', title: 'Accounts', src: 'Accounts.html', x: 960, y: 0, variant: { title: 'Needs attention', context: 'Connected accounts', description: 'Token expired' } }],
  annotations: [{ id: 'dev', kind: 'development', title: 'Account details', text: 'Open the account', items: ['Show expired token'], x: 1450, y: 250, target: { frame: 'accounts', label: 'Outlook row' } },
    { id: 'warn', kind: 'important', text: 'Do not lose data', x: -30, y: -205 }],
}
const fetcher = vi.fn()
beforeEach(() => {
  vi.stubGlobal('fetch', fetcher)
  fetcher.mockReset().mockImplementation(async () => ({ ok: true, text: async () => JSON.stringify(example), json: async () => ({ notes: [], threads: [], knownUpTo: 0, dropped: 0 }) }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function(this: HTMLElement) { return parseFloat(this.style.width) || 330 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(165)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const push = (changed: string[], id = artifactId) => act(() => publishCanvasChange({ artifactId: id, changed }))
describe('CanvasPane', () => {
  it('opens read-only history, keeps overview, ignores live updates and restores the live camera and tools', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 } })
    const snapshot = { id: '11111111-1111-1111-1111-111111111111', createdAt: Date.now(), comments: 3, partial: false, manifestTitle: 'Previous round' }
    const previous = { ...example, title: 'Previous round', frames: example.frames.map((f) => ({ ...f, x: f.x + 300 })) }
    fetcher.mockImplementation(async (url: string) => ({ ok: true, text: async () => JSON.stringify(url.includes('/canvas-snapshots/') ? previous : example), json: async () => ({ snapshots: [snapshot], notes: [], threads: [], knownUpTo: 0, dropped: 0 }) }))
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" webPaneId="w-history" token="owner" />)
    await screen.findByTitle('Settings')
    const world = container.querySelector('.canvas-world') as HTMLElement
    fireEvent.wheel(container.querySelector('.canvas-viewport')!, { deltaX: 30, deltaY: 20 })
    const liveCamera = world.style.transform
    fireEvent.click(screen.getByRole('tab', { name: 'Threads' }))
    fireEvent.click(screen.getByLabelText('History'))
    const liveItem = await screen.findByRole('menuitemradio', { name: 'Live' })
    expect(liveItem).toHaveAttribute('aria-checked', 'true')
    const historyRequest = fetcher.mock.calls.find(([url]) => url.endsWith('/snapshots'))!
    expect(historyRequest[1].headers.Authorization).toBe('Bearer owner')
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /3 comments/ }))
    expect(await screen.findByText(/Viewing snapshot from/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTitle('Settings').closest('.canvas-frame')).toHaveStyle({ left: '300px' }))
    expect(screen.getByTitle('Settings')).toHaveAttribute('src', `/redline/canvas-snapshots/${artifactId}/${snapshot.id}/Settings.html?canvas-frame=settings`)
    expect(screen.getByRole('button', { name: 'Comment tool' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Export Settings from overview' }).at(-1)!)
    expect(screen.getByRole('menuitem', { name: 'Download PNG' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Download HTML' })).toBeEnabled()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Settings, regrouped status' })).toBeDisabled()
    expect(screen.queryByRole('tab', { name: 'Threads' })).not.toBeInTheDocument()
    expect(container.querySelector('.canvas-pin')).not.toBeInTheDocument()
    fireEvent.doubleClick(screen.getByTitle('Settings').closest('.canvas-frame')!)
    expect(screen.getByTitle('Settings').closest('.canvas-frame')).not.toHaveClass('is-live')
    const label = screen.getByTitle('Settings').closest('.canvas-frame')!.querySelector('.canvas-frame-label') as HTMLElement
    label.setPointerCapture = vi.fn()
    fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientX: 0, clientY: 0 }); fireEvent.pointerMove(label, { pointerId: 1, clientX: 40, clientY: 40 }); fireEvent.pointerUp(label, { pointerId: 1 })
    expect(label.setPointerCapture).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '★ 1 · Settings' }))
    expect(world.style.transform).not.toBe(liveCamera)
    const reads = fetcher.mock.calls.length, source = screen.getByTitle('Settings').getAttribute('src')
    push(['Settings.html', 'canvas.json']); expect(fetcher).toHaveBeenCalledTimes(reads); expect(screen.getByTitle('Settings')).toHaveAttribute('src', source)
    fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))
    await waitFor(() => expect(screen.getByTitle('Settings')).toHaveAttribute('src', `/redline/artifacts/${artifactId}/Settings.html?canvas-frame=settings`))
    expect(world.style.transform).toBe(liveCamera)
    expect(screen.queryByText(/Viewing snapshot from/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Comment tool' })).toBeEnabled(); expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: 'Threads' })).toBeInTheDocument()
  })

  it('enters only interactive frames, leaves on background/Esc, routes live wheel and suspends live input for comments', async () => {
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" webPaneId="w-m4" />)
    const settings = await screen.findByTitle('Settings'), accounts = screen.getByTitle('Accounts')
    const viewport = container.querySelector('.canvas-viewport')!, world = container.querySelector('.canvas-world') as HTMLElement
    fireEvent.doubleClick(accounts.closest('.canvas-frame')!)
    expect(screen.getByRole('status', { name: 'Canvas hint' })).toHaveTextContent('Static frame')
    expect(accounts.closest('.canvas-frame')).not.toHaveClass('is-live')
    fireEvent.doubleClick(settings.closest('.canvas-frame')!)
    expect(settings.closest('.canvas-frame')).toHaveClass('is-live')
    expect(screen.getByText('Live — Esc to leave')).toBeInTheDocument()
    const transform = world.style.transform
    fireEvent.wheel(settings, { deltaY: 40 }); expect(world.style.transform).toBe(transform)
    fireEvent.wheel(settings, { deltaY: -10, metaKey: true }); expect(world.style.transform).not.toBe(transform)
    fireEvent.click(screen.getByRole('button', { name: 'Comment tool' }))
    expect(settings.closest('.canvas-frame')).not.toHaveClass('is-live')
    fireEvent.click(screen.getByRole('button', { name: 'Comment tool' }))
    expect(settings.closest('.canvas-frame')).toHaveClass('is-live')
    fireEvent.click(viewport); expect(settings.closest('.canvas-frame')).not.toHaveClass('is-live')
    fireEvent.doubleClick(settings.closest('.canvas-frame')!); fireEvent.keyDown(container.querySelector('.canvas-pane')!, { key: 'Escape' })
    expect(settings.closest('.canvas-frame')).not.toHaveClass('is-live')
  })
  it('Play validates window/target/live identity, flies to static targets and Back restores the previous live frame', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    const settings = await screen.findByTitle('Settings') as HTMLIFrameElement, accounts = screen.getByTitle('Accounts') as HTMLIFrameElement
    const go = (target: unknown, source: MessageEventSource | null = settings.contentWindow, frameId = 'settings') => act(() => window.dispatchEvent(new MessageEvent('message', { source, data: { source: 'commando-canvas-frame', type: 'goto', frameId, target } })))
    go('accounts'); expect(screen.queryByText('Live — Esc to leave')).not.toBeInTheDocument()
    const play = screen.getByRole('button', { name: 'Play' })
    fireEvent.click(play)
    expect(play).toHaveAttribute('aria-pressed', 'true')
    expect(settings.closest('.canvas-frame')).toHaveClass('is-live')
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    go('accounts', window); go('missing'); go({}); go('accounts', accounts.contentWindow)
    expect(settings.closest('.canvas-frame')).toHaveClass('is-live')
    const before = (container.querySelector('.canvas-world') as HTMLElement).style.transform
    go('accounts')
    expect(settings.closest('.canvas-frame')).not.toHaveClass('is-live')
    expect(accounts.closest('.canvas-frame')).not.toHaveClass('is-live')
    expect((container.querySelector('.canvas-world') as HTMLElement).style.transform).not.toBe(before)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(settings.closest('.canvas-frame')).toHaveClass('is-live')
    act(() => window.dispatchEvent(new MessageEvent('message', { source: settings.contentWindow, data: { source: 'commando-canvas-frame', type: 'escape', frameId: 'settings' } })))
    expect(play).toHaveAttribute('aria-pressed', 'false'); expect(settings.closest('.canvas-frame')).not.toHaveClass('is-live')
    fireEvent.doubleClick(settings.closest('.canvas-frame')!); go('accounts')
    expect(settings.closest('.canvas-frame')).not.toHaveClass('is-live')
    expect(play).toHaveAttribute('aria-pressed', 'false')
  })
  it('relays modifier zoom from the live iframe, ignores malformed and inactive messages', async () => {
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    const frame = await screen.findByTitle('Settings') as HTMLIFrameElement
    const world = container.querySelector('.canvas-world') as HTMLElement
    const zoom = (extras = {}) => act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { source: 'commando-canvas-frame', type: 'zoom', frameId: 'settings', deltaY: -10, deltaMode: 0, x: 10, y: 20, ...extras } })))
    const before = world.style.transform
    zoom(); expect(world.style.transform).toBe(before)
    fireEvent.doubleClick(frame.closest('.canvas-frame')!)
    zoom({ x: Infinity }); expect(world.style.transform).toBe(before)
    zoom(); expect(world.style.transform).not.toBe(before)
  })
  it('snaps label drags in world pixels, persists the loaded hash, and preserves iframe identity through self-write reload', async () => {
    vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 } })
    let board = structuredClone(example)
    fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)), move = body.moves[0]
        board.frames[0].x = move.x; board.frames[0].y = move.y
        return { ok: true, json: async () => ({ ...parseCanvasManifest(board), contentHash: 'b'.repeat(64) }) }
      }
      return { ok: true, text: async () => JSON.stringify(board), headers: new Headers({ ETag: `"${'a'.repeat(64)}"` }) }
    })
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" token="owner" />)
    const frame = await screen.findByTitle('Settings'), wrapper = frame.closest('.canvas-frame')!, label = wrapper.querySelector('.canvas-frame-label') as HTMLElement
    label.setPointerCapture = vi.fn()
    const scale = Number(/scale\(([^)]+)\)/.exec((container.querySelector('.canvas-world') as HTMLElement).style.transform)![1])
    const source = frame.getAttribute('src')
    fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 23 * scale, clientY: 37 * scale })
    expect(wrapper).toHaveStyle({ left: '20px', top: '40px' })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0)
    fireEvent.pointerUp(label, { pointerId: 1 })
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1))
    const [url, init] = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(url).toBe(`/api/redline/artifacts/${artifactId}/canvas/frames`)
    expect(JSON.parse(init.body)).toEqual({ manifest: 'canvas.json', expectedHash: 'a'.repeat(64), moves: [{ id: 'settings', x: 20, y: 40 }] })
    expect(init.headers.Authorization).toBe('Bearer owner')
    push(['canvas.json']); await waitFor(() => expect(wrapper).toHaveStyle({ left: '20px', top: '40px' }))
    expect(screen.getByTitle('Settings')).toBe(frame); expect(frame).toHaveAttribute('src', source)
    fireEvent.pointerDown(label, { button: 0, pointerId: 2, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(label, { pointerId: 2, clientX: 50, clientY: 40 })
    fireEvent.pointerCancel(label, { pointerId: 2 })
    expect(wrapper).toHaveStyle({ left: '20px', top: '40px' })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
  })
  it('reloads on a stale drag write and reports the conflict without remounting the iframe', async () => {
    vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 } })
    let changed = false
    fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') { changed = true; return { ok: false, status: 409, json: async () => ({ error: 'Canvas changed on disk; reloaded. Try again.' }) } }
      return { ok: true, text: async () => JSON.stringify({ ...example, frames: example.frames.map((f) => ({ ...f, x: changed ? f.x + 100 : f.x })) }), headers: new Headers({ ETag: `"${'a'.repeat(64)}"` }) }
    })
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    const frame = await screen.findByTitle('Settings'), label = frame.closest('.canvas-frame')!.querySelector('.canvas-frame-label') as HTMLElement
    label.setPointerCapture = vi.fn()
    fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 20, clientY: 20 }); fireEvent.pointerUp(label, { pointerId: 1 })
    expect(await screen.findByRole('alert')).toHaveTextContent('Canvas changed on disk')
    await waitFor(() => expect(frame.closest('.canvas-frame')).toHaveStyle({ left: '100px' }))
    expect(screen.getByTitle('Settings')).toBe(frame)
  })
  it('does not let an older manifest fetch overwrite a completed move', async () => {
    vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 } })
    let reads = 0, finishOld!: (response: unknown) => void
    fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return { ok: true, json: async () => ({ ...parseCanvasManifest({ ...example, frames: example.frames.map((f) => f.id === 'settings' ? { ...f, x: 30, y: 30 } : f) }), contentHash: 'b'.repeat(64) }) }
      if (++reads === 2) return new Promise((resolve) => { finishOld = resolve })
      return { ok: true, text: async () => JSON.stringify(example), headers: new Headers({ ETag: `"${'a'.repeat(64)}"` }) }
    })
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    const frame = await screen.findByTitle('Settings'), wrapper = frame.closest('.canvas-frame')!, label = wrapper.querySelector('.canvas-frame-label') as HTMLElement
    label.setPointerCapture = vi.fn()
    push(['canvas.json'])
    fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 20, clientY: 20 }); fireEvent.pointerUp(label, { pointerId: 1 })
    await waitFor(() => expect(wrapper).toHaveStyle({ left: '30px' }))
    await act(async () => { finishOld({ ok: true, text: async () => JSON.stringify(example), headers: new Headers({ ETag: `"${'a'.repeat(64)}"` }) }) })
    expect(wrapper).toHaveStyle({ left: '30px', top: '30px' }); expect(screen.getByTitle('Settings')).toBe(frame)
  })
  it('spans the card grid and gives the viewport the remaining flex height', async () => {
    const webPane: WebPane = { id: 'w-12345678', url: 'http://localhost/', content: { kind: 'canvas', artifactId, manifest: 'canvas.json' }, sessionId: '$1', windowId: '@1', anchorPaneId: '%1', placement: 'right', engine: 'webkit', status: 'open', openedBy: 'user', createdAt: 0 }
    const { container } = render(<WebPaneCard webPane={webPane} onClose={vi.fn()} onConfirm={vi.fn()} />)
    await screen.findByTitle('Settings')
    const pane = container.querySelector('.web-pane > .canvas-pane')!
    expect(pane.parentElement).toHaveClass('web-pane')
    expect(pane.parentElement!.children).toHaveLength(1)
    expect(pane.querySelector(':scope > .canvas-toolbar')).toBeInTheDocument()
    expect(pane.querySelector(':scope > .canvas-body > .canvas-viewport')).toBeInTheDocument()
    expect(canvasPaneCss.match(/\.web-pane\s*>\s*\.canvas-pane\s*\{([^}]+)\}/)?.[1]).toMatch(/grid-row:\s*1\s*\/\s*-1/)
    const paneRule = canvasPaneCss.match(/(?:^|})\s*\.canvas-pane\s*\{([^}]+)\}/)?.[1]
    expect(paneRule).toMatch(/display:\s*flex/)
    expect(paneRule).toMatch(/flex-direction:\s*column/)
    const viewportRule = canvasPaneCss.match(/\.canvas-viewport\s*\{([^}]+)\}/)?.[1]
    expect(viewportRule).toMatch(/flex:\s*1/)
    expect(viewportRule).toMatch(/min-height:\s*0/)
  })
  it('renders sections, status, frame roles, variants, notes and frame-target connectors', async () => {
    const title = vi.fn(), { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" artifactUrl="http://127.0.0.1:4410/redline/artifacts/0123456789abcdef/" onTitle={title} />)
    expect(await screen.findByText('[GIZMO-6094] Settings, regrouped')).toBeInTheDocument()
    expect(screen.getByText('Ready for dev')).toHaveClass('status-ready-for-dev')
    expect(screen.getByText('[Mobile]')).toBeInTheDocument()
    expect(screen.getByText('★ Focus 1')).toBeInTheDocument()
    expect(screen.getByText('▶ Interactive')).toBeInTheDocument()
    expect(screen.getByText('Static')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText('Connected accounts')).toBeInTheDocument()
    expect(screen.getByText('Token expired')).toBeInTheDocument()
    expect(screen.getByText('Development')).toBeInTheDocument()
    expect(screen.getByText('Important')).toBeInTheDocument()
    expect(container.querySelector('.canvas-note')).toHaveTextContent('Account details')
    expect(screen.getByText('Show expired token')).toBeInTheDocument()
    const frame = screen.getByTitle('Settings')
    expect(fetcher).toHaveBeenCalledWith(`http://127.0.0.1:4410/redline/artifacts/${artifactId}/canvas.json`, expect.any(Object))
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame).toHaveAttribute('loading', 'lazy')
    expect(frame.closest('.canvas-frame')).toHaveClass('is-focus')
    expect(container.querySelector('.canvas-connectors path')).toHaveAttribute('d', expect.stringContaining(' C '))
    expect(title).toHaveBeenCalledWith('Settings board')
    const notes = screen.getByRole('button', { name: 'Notes' })
    expect(notes).toHaveAttribute('aria-pressed', 'true'); fireEvent.click(notes)
    expect(notes).toHaveAttribute('aria-pressed', 'false')
    expect(container.querySelector('.canvas-world')).toHaveClass('hide-notes')
    expect(screen.getByTitle('Accounts')).toBeInTheDocument()
  })
  it('renders errors and keeps usable frames', async () => {
    fetcher.mockImplementation(async () => ({ ok: true, text: async () => JSON.stringify({ ...example, frames: [...example.frames, { ...example.frames[0], id: 'bad', src: '../outside.html' }] }) }))
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('frames[2].src: must be a relative path inside the canvas folder')
    expect(screen.getAllByTitle('Settings')).toHaveLength(1)
    expect(screen.getByTitle('Accounts')).toBeInTheDocument()
  })
  it('fits focus initially, fits all on demand, and supports cursor zoom and wheel pan', async () => {
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    await screen.findByTitle('Settings')
    const layer = container.querySelector('.canvas-world') as HTMLElement, viewport = container.querySelector('.canvas-viewport')!
    const focused = layer.style.transform
    expect(focused).toContain('scale(0.6272727272727273)')
    fireEvent.click(screen.getByText('Fit')); expect(layer.style.transform).not.toBe(focused)
    fireEvent.wheel(viewport, { deltaX: 25, deltaY: 10 }); const panned = layer.style.transform
    fireEvent.wheel(viewport, { deltaY: -20, ctrlKey: true, clientX: 50, clientY: 80 }); expect(layer.style.transform).not.toBe(panned)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' })); expect(screen.getByLabelText('Zoom')).toHaveTextContent('%')
  })
  it('promotes the world to a compositor layer only while the camera moves', async () => {
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    await screen.findByTitle('Settings')
    const layer = container.querySelector('.canvas-world') as HTMLElement
    await waitFor(() => expect(layer).not.toHaveClass('is-moving'))
    fireEvent.wheel(container.querySelector('.canvas-viewport')!, { deltaX: 25, deltaY: 10 })
    expect(layer).toHaveClass('is-moving')
    await waitFor(() => expect(layer).not.toHaveClass('is-moving'))
    expect(canvasPaneCss).toMatch(/\.canvas-world\.is-moving \{ will-change: transform; \}/)
    expect(canvasPaneCss).toMatch(/\.canvas-viewport\.is-panning \.canvas-world \{ pointer-events: none; \}/)
  })
  it('fits all content without focus, including measured tall annotations', async () => {
    fetcher.mockImplementation(async () => ({ ok: true, text: async () => JSON.stringify({ ...example, frames: example.frames.map((frame) => ({ ...frame, focus: undefined })) }) }))
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('canvas-note') ? 900 : 165 })
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    await screen.findByTitle('Settings')
    const transform = (container.querySelector('.canvas-world') as HTMLElement).style.transform
    const [, x, y, scale] = /translate\(([-.\d]+)px, ([-.\d]+)px\) scale\(([-.\d]+)\)/.exec(transform)!
    expect(Number(y) + (250 + 900) * Number(scale)).toBeLessThanOrEqual(576.001)
    expect(Number(x) + (1450 + 300) * Number(scale)).toBeLessThanOrEqual(776.001)
  })
  it('pans by dragging the background and leaves frames inert', async () => {
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      pointerId: number
      constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 }
    })
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    const settings = await screen.findByTitle('Settings')
    const viewport = container.querySelector('.canvas-viewport') as HTMLElement, world = container.querySelector('.canvas-world') as HTMLElement
    viewport.setPointerCapture = vi.fn()
    const before = world.style.transform
    fireEvent.pointerDown(settings.closest('.canvas-frame')!, { button: 0, pointerId: 1, clientX: 10, clientY: 20 })
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 40, clientY: 60 })
    expect(world.style.transform).toBe(before)
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 1, clientX: 10, clientY: 20 })
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 40, clientY: 60 })
    expect(world.style.transform).not.toBe(before)
    expect(viewport).toHaveClass('is-panning')
    expect(viewport.setPointerCapture).toHaveBeenCalledWith(1)
    fireEvent.pointerUp(viewport, { pointerId: 1 }); expect(viewport).not.toHaveClass('is-panning')
  })
  it('reloads only changed frames, preserves iframe nodes and sources on manifest edits, reloads all on asset changes', async () => {
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    const settings = await screen.findByTitle('Settings'), accounts = screen.getByTitle('Accounts')
    const settingsSrc = settings.getAttribute('src'), accountsSrc = accounts.getAttribute('src')
    push(['Settings.html'], 'other'); expect(settings).toHaveAttribute('src', settingsSrc)
    push(['Settings.html']); expect(settings.getAttribute('src')).toContain('canvas-reload=1'); expect(accounts).toHaveAttribute('src', accountsSrc)
    fetcher.mockImplementation(async () => ({ ok: true, text: async () => JSON.stringify({ ...example, frames: example.frames.map((frame) => ({ ...frame, x: frame.x + 40 })) }) }))
    push(['canvas.json']); await waitFor(() => expect(settings.closest('.canvas-frame')).toHaveStyle({ left: '40px' }))
    expect(screen.getByTitle('Settings')).toBe(settings); expect(screen.getByTitle('Accounts')).toBe(accounts)
    expect(settings.getAttribute('src')).toContain('canvas-reload=1'); expect(accounts).toHaveAttribute('src', accountsSrc)
    push(['assets/icon.svg']); expect(settings.getAttribute('src')).toContain('canvas-reload=2'); expect(accounts.getAttribute('src')).toContain('canvas-reload=1')
    expect(settingsSrc).toBe(`/redline/artifacts/${artifactId}/Settings.html?canvas-frame=settings`)
  })
  it('reports missing and unparsable manifests', async () => {
    fetcher.mockResolvedValueOnce({ ok: false, status: 404 })
    const view = render(<CanvasPane artifactId={artifactId} manifest="board.json" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('board.json: could not load (404)')
    view.unmount()
    fetcher.mockResolvedValueOnce({ ok: true, text: async () => '{' })
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('canvas.json: must be valid JSON')
  })
  it('branches WebPaneCard to canvas and closes via its toolbar', async () => {
    const onClose = vi.fn(), webPane: WebPane = { id: 'w-12345678', url: 'http://localhost/', content: { kind: 'canvas', artifactId, manifest: 'canvas.json' }, sessionId: '$1', windowId: '@1', anchorPaneId: '%1', placement: 'right', engine: 'webkit', status: 'open', openedBy: 'user', createdAt: 0 }
    render(<WebPaneCard webPane={webPane} onClose={onClose} onConfirm={vi.fn()} />)
    await screen.findByTitle('Settings')
    fireEvent.click(screen.getByRole('button', { name: 'Close canvas tab' })); expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Change URL' })).not.toBeInTheDocument()
  })
})

const labelRect = { x: 10, y: 20, w: 100, h: 40 }
function report(iframe: HTMLElement, frameId: string, labels: unknown[], extras = {}, source: MessageEventSource | null = (iframe as HTMLIFrameElement).contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent('message', { source, data: { source: 'commando-canvas-frame', type: 'labels', frameId, labels, ...extras } })))
}
describe('canvas overview and frame bridge', () => {
  it('accepts only matching iframe windows and validated label reports', async () => {
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    const settings = await screen.findByTitle('Settings'), accounts = screen.getByTitle('Accounts')
    const labels = [{ name: 'Secret label', rect: labelRect }]
    report(settings, 'settings', labels, {}, window)
    report(accounts, 'settings', labels)
    report(settings, 'settings', labels, { source: 'wrong' })
    report(settings, 'settings', [{ name: 'Secret label', rect: { ...labelRect, w: -1 } }])
    expect(screen.queryByRole('button', { name: 'Secret label' })).not.toBeInTheDocument()
    report(settings, 'settings', labels)
    expect(screen.getByRole('button', { name: 'Secret label' })).toBeInTheDocument()
    push(['Settings.html'])
    expect(screen.queryByRole('button', { name: 'Secret label' })).not.toBeInTheDocument()
    expect(settings.getAttribute('src')).toContain('canvas-frame=settings&canvas-reload=1')
  })
  it('shows grouped/shared labels, filters, selects, cycles and projects highlights through camera changes', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    const settings = await screen.findByTitle('Settings'), accounts = screen.getByTitle('Accounts')
    report(settings, 'settings', [{ name: 'Outlook row', group: 'Accounts region', id: 'row', rect: labelRect }, { name: 'Only here', rect: labelRect }])
    report(accounts, 'accounts', [{ name: 'Outlook row', rect: { ...labelRect, x: 30 } }])
    expect(screen.getByText('Accounts region')).toBeInTheDocument()
    const rows = screen.getAllByRole('button', { name: /Outlook row/ })
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('×2')
    fireEvent.pointerEnter(rows[1])
    expect(container.querySelector('.canvas-highlight.is-hover')).toBeInTheDocument()
    fireEvent.click(rows[1]); fireEvent.pointerLeave(rows[1])
    expect(rows[1]).toHaveAttribute('aria-pressed', 'true')
    const highlight = container.querySelector('.canvas-highlight')!
    expect(highlight).toHaveTextContent('Outlook row')
    expect(highlight).toHaveStyle({ left: '347px', top: '277px', width: '106px', height: '46px' })
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(highlight).toHaveStyle({ width: '131px', height: '56px' })
    fireEvent.wheel(container.querySelector('.canvas-viewport')!, { deltaX: 20, deltaY: 30 })
    expect(highlight).toHaveStyle({ left: '314.5px', top: '242px' })
    fireEvent.click(rows[0]); expect(rows[1]).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(rows[0]); expect(rows[2]).toHaveAttribute('aria-pressed', 'true')
    report(settings, 'settings', [{ name: 'Renamed', id: 'row', rect: labelRect }])
    fireEvent.click(screen.getByRole('button', { name: 'Renamed' }))
    report(settings, 'settings', [{ name: 'Other', rect: labelRect }, { name: 'Renamed again', id: 'row', rect: { ...labelRect, x: 50 } }])
    expect(container.querySelector('.canvas-highlight')).toHaveTextContent('Renamed again')
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter labels' }), { target: { value: 'ONLY' } })
    expect(screen.getByText('No matching labels')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Threads' }))
    expect(screen.getByText('No comments yet')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
  it('defaults overview off below 420px and permits an explicit toggle', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(419)
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    await screen.findByTitle('Settings')
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Toggle overview' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(screen.getByRole('complementary')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })
  it('updates connectors to label edges, reverts on reload and lets Notes reveal hidden cards', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    const accounts = await screen.findByTitle('Accounts')
    const path = container.querySelector('.canvas-connectors path')!, fallback = path.getAttribute('d')
    report(accounts, 'accounts', [{ name: 'Outlook row', rect: labelRect }])
    expect(path.getAttribute('d')).not.toBe(fallback)
    expect(container.querySelector('.canvas-connectors circle')).toHaveAttribute('cx', '1070')
    push(['Accounts.html'])
    expect(path.getAttribute('d')).toBe(fallback)
    expect(container.querySelector('.canvas-connectors circle')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Account details' }))
    expect(container.querySelector('.canvas-world')).not.toHaveClass('hide-notes')
    fireEvent.click(screen.getByRole('button', { name: '★ 1 · Settings' }))
    expect(screen.getByLabelText('Zoom')).toHaveTextContent('57%')
  })
})

it('hydrates only the matching canvas frame when source and SDK queueKey are shared', () => {
  const a = 'http://localhost/Shared.html?canvas-frame=a', b = 'http://localhost/Shared.html?canvas-frame=b'
  const answer = { queueKey: 'ship', shape: { question: 'Ship?', kind: 'approve' as const, options: ['Yes', 'No'] }, response: { question: 'Ship?', answer: 'Yes' }, sentAt: 1 }
  const note = { id: 1, selector: 'html', tag: 'body', rect: { x: 0, y: 0, width: 1, height: 1 }, comment: '', pageUrl: a, queueKey: 'ship', response: answer.response }
  const snapshot = { notes: [note, { ...note, id: 2, pageUrl: b, response: { question: 'Ship?', answer: 'No' } }], knownUpTo: 2, dropped: 0, sent: { page: a, answers: [answer] } }
  expect(canvasPendingSnapshotForPage(snapshot, a + '&canvas-reload=2')).toMatchObject({ controls: [{ response: { answer: 'Yes' } }], sent: [answer] })
  const other = canvasPendingSnapshotForPage(snapshot, b)
  expect(other.controls).toHaveLength(1); expect(other.controls[0].response.answer).toBe('No'); expect(other.sent).toBeUndefined()
})
it('remounts the canvas when WebPaneCard changes artifact/manifest identity', async () => {
  const pane: WebPane = { id: 'w-12345678', url: 'http://localhost/', content: { kind: 'canvas', artifactId, manifest: 'canvas.json' }, sessionId: '$1', windowId: '@1', anchorPaneId: '%1', placement: 'right', engine: 'webkit', status: 'open', openedBy: 'user', createdAt: 0 }
  const props = { webPane: pane, wsToken: '', onClose: vi.fn(), onConfirm: vi.fn() }
  const view = render(<WebPaneCard {...props} />)
  await screen.findByTitle('Settings')
  fireEvent.click(screen.getByRole('button', { name: 'Comment tool' }))
  expect(screen.getByRole('button', { name: 'Comment tool' })).toHaveAttribute('aria-pressed', 'true')
  const node = view.container.querySelector('.canvas-pane')
  view.rerender(<WebPaneCard {...props} webPane={{ ...pane, content: { kind: 'canvas', artifactId, manifest: 'second.json' } }} />)
  await screen.findByTitle('Settings')
  expect(view.container.querySelector('.canvas-pane')).not.toBe(node)
  expect(screen.getByRole('button', { name: 'Comment tool' })).toHaveAttribute('aria-pressed', 'false')
})
it('registers Escape once through manifest refreshes and ignores outside targets', async () => {
  const add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener')
  const view = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" webPaneId="w-test" />)
  await screen.findByTitle('Settings')
  fireEvent.click(screen.getByRole('button', { name: 'Comment tool' }))
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(screen.getByRole('button', { name: 'Comment tool' })).toHaveAttribute('aria-pressed', 'true')
  push(['canvas.json']); await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('canvas.json')).length).toBe(2))
  expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
  expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0)
  fireEvent.keyDown(view.container.querySelector('.canvas-pane')!, { key: 'Escape' })
  expect(screen.getByRole('button', { name: 'Comment tool' })).toHaveAttribute('aria-pressed', 'false')
})

it('opens the shared screen-space export menu from labels and overview, and closes on camera changes', async () => {
  const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
  await screen.findByTitle('Settings')
  const trigger = screen.getByRole('button', { name: 'Export Settings' })
  fireEvent.click(trigger)
  expect(screen.getByRole('menu', { name: 'Export Settings' }).closest('.canvas-world')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  const overviewExport = screen.getAllByRole('button', { name: 'Export Settings from overview' }).at(-1)!
  fireEvent.click(overviewExport)
  expect(screen.getByRole('menu', { name: 'Export Settings' }).closest('.canvas-export-overlay')).not.toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Download PNG' })).toBeEnabled()
  fireEvent.wheel(container.querySelector('.canvas-viewport')!, { deltaX: 10, deltaY: 20 })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  fireEvent.click(trigger); fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
it('keeps compact toolbar controls accessible at 380px', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(380)
  render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
  await screen.findByTitle('Settings')
  for (const [name, icon] of [['Play', '▶'], ['Notes', '▤'], ['Comment tool', '💬']]) {
    const button = screen.getByRole('button', { name })
    expect(button).toHaveTextContent(icon)
    expect(button).toHaveAttribute('title', name)
    expect(button.textContent).not.toContain(name)
  }
  expect(screen.getByLabelText('History')).toHaveTextContent('🕘')
  expect(screen.getByLabelText('History')).toHaveAttribute('title', 'History')
  expect(canvasPaneCss.match(/\.canvas-toolbar button\s*\{([^}]+)\}/)?.[1]).toMatch(/white-space:\s*nowrap/)
  expect(canvasPaneCss.match(/\.canvas-toolbar-title\s*\{([^}]+)\}/)?.[1]).toMatch(/min-width:\s*0/)
})

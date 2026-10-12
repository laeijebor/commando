// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPane } from '../shared/protocol'
import { CanvasPane } from './CanvasPane'
import { WebPaneCard } from './WebPaneCard'
import { publishCanvasChange } from './webPanesApi'

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
  fetcher.mockReset().mockImplementation(async () => ({ ok: true, text: async () => JSON.stringify(example) }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function(this: HTMLElement) { return parseFloat(this.style.width) || 330 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(165)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const push = (changed: string[], id = artifactId) => act(() => publishCanvasChange({ artifactId: id, changed }))
describe('CanvasPane', () => {
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

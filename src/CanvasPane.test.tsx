// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPane } from '../shared/protocol'
import { CanvasPane } from './CanvasPane'
import { WebPaneCard } from './WebPaneCard'
import { publishCanvasChange } from './webPanesApi'

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
    expect(screen.getByText('Account details')).toBeInTheDocument()
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
    expect(settingsSrc).toBe(`/redline/artifacts/${artifactId}/Settings.html`)
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

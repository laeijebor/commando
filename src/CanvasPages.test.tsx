// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasPane } from './CanvasPane'
import { canvasPageStatus } from './CanvasPages'

const artifactId = 'fedcba9876543210'
const paged = {
  title: 'Trainer audit',
  pages: [
    { id: 'today', title: 'Today and the rail',
      frames: [{ id: 'today', title: 'Today', src: 'today.html', x: 0, y: 0, focus: 1, interactive: true }],
      sections: [{ id: 's-today', title: 'Today', status: 'ready-for-review', frames: ['today'] }] },
    { id: 'client', title: 'Client profile',
      frames: [{ id: 'overview', title: 'Client overview', src: 'overview.html', x: 5000, y: 3000, interactive: true },
        { id: 'manage', title: 'Manage menu', src: 'manage.html', x: 6600, y: 3000 }],
      sections: [{ id: 's-client', title: 'Client', status: 'idea', frames: ['overview', 'manage'] }],
      annotations: [{ id: 'your-call', kind: 'question', text: 'Option A or B?', options: ['A', 'B'], x: 5000, y: 2600 }] },
  ],
}
const fetcher = vi.fn()
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  fetcher.mockReset().mockImplementation(async () => ({ ok: true, text: async () => JSON.stringify(paged), json: async () => ({ notes: [], threads: [], knownUpTo: 0, dropped: 0 }) }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(330)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(165)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const world = (container: HTMLElement) => (container.querySelector('.canvas-world') as HTMLElement).style.transform
const pageRow = (name: RegExp) => within(screen.getByRole('complementary')).getByRole('button', { name })

describe('canvas pages', () => {
  it('loads only the open page, keeps each page’s camera and remembers the page across reopening', async () => {
    const { container, unmount } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    await screen.findByTitle('Today')
    expect(screen.queryByTitle('Client overview')).not.toBeInTheDocument()
    expect(pageRow(/Today and the rail/)).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /Pages/ })).toHaveTextContent('2 · 3 frames')
    fireEvent.wheel(container.querySelector('.canvas-viewport')!, { deltaX: 40, deltaY: 10 })
    const todayCamera = world(container)

    fireEvent.click(pageRow(/Client profile/))
    expect(await screen.findByTitle('Client overview')).toBeInTheDocument()
    expect(screen.queryByTitle('Today')).not.toBeInTheDocument()
    expect(within(screen.getByRole('complementary')).queryByText('Today')).not.toBeInTheDocument()
    expect(screen.getByText(/Client overview/, { selector: '.canvas-o-frame span' })).toBeInTheDocument()

    fireEvent.click(pageRow(/Today and the rail/))
    expect(await screen.findByTitle('Today')).toBeInTheDocument()
    expect(world(container)).toBe(todayCamera)

    fireEvent.click(pageRow(/Client profile/))
    unmount()
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    expect(await screen.findByTitle('Client overview')).toBeInTheDocument()
  })

  it('collapses the page list and resizes it from the divider with the keyboard', async () => {
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    await screen.findByTitle('Today')
    const divider = screen.getByRole('separator', { name: 'Resize pages list' })
    fireEvent.keyDown(divider, { key: 'ArrowDown' })
    expect(localStorage.getItem('commando:canvas-pages-height')).toBe(String(165 + 24))
    fireEvent.click(screen.getByRole('button', { name: /Pages/ }))
    expect(screen.queryByRole('button', { name: /Client profile/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('follows a prototype link onto another page during Play', async () => {
    const { container } = render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    const today = await screen.findByTitle('Today') as HTMLIFrameElement
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    const before = world(container)
    act(() => window.dispatchEvent(new MessageEvent('message', { source: today.contentWindow, data: { source: 'commando-canvas-frame', type: 'goto', frameId: 'today', target: 'overview' } })))
    expect(await screen.findByTitle('Client overview')).toBeInTheDocument()
    expect(screen.getByTitle('Client overview').closest('.canvas-frame')).toHaveClass('is-live')
    expect(world(container)).not.toBe(before)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByTitle('Today')).toBeInTheDocument()
  })

  it('lists every page’s questions grouped by page, badges the page, and opens a question’s page', async () => {
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" webPaneId="w-pages" token="owner" />)
    await screen.findByTitle('Today')
    expect(pageRow(/Client profile/)).toHaveTextContent('?1')
    fireEvent.click(screen.getByRole('tab', { name: /Questions/ }))
    const panel = screen.getByRole('tabpanel')
    expect(within(panel).getByText('Client profile')).toHaveClass('canvas-o-head')
    fireEvent.click(within(panel).getByRole('button', { name: /Option A or B\?/ }))
    expect(await screen.findByTitle('Client overview')).toBeInTheDocument()
    expect(pageRow(/Client profile/)).toHaveAttribute('aria-current', 'page')
  })

  it('offers a toolbar page menu when the tile is too narrow for the sidebar', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(380)
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    await screen.findByTitle('Today')
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    const picker = screen.getByRole('button', { name: 'Page: Today and the rail' })
    expect(picker).toHaveTextContent('1/2')
    fireEvent.click(picker)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /2 · Client profile/ }))
    expect(await screen.findByTitle('Client overview')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Page: Client profile' })).toHaveTextContent('2/2')
  })

  it('shows no page list for a canvas without pages', async () => {
    fetcher.mockImplementation(async () => ({ ok: true, text: async () => JSON.stringify({ title: 'Flat', frames: paged.pages[0].frames }), json: async () => ({ notes: [], threads: [] }) }))
    render(<CanvasPane artifactId={artifactId} manifest="canvas.json" />)
    await screen.findByTitle('Today')
    expect(screen.queryByRole('button', { name: /Pages/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Page:/ })).not.toBeInTheDocument()
  })

  it('rates a page by its least advanced section', () => {
    expect(canvasPageStatus([])).toBeUndefined()
    const section = (status: 'idea' | 'shipped' | 'ready-for-dev') => ({ id: status, title: status, status, frames: [] })
    expect(canvasPageStatus([section('shipped'), section('ready-for-dev')])).toBe('ready-for-dev')
    expect(canvasPageStatus([section('shipped'), section('idea')])).toBe('idea')
  })
})

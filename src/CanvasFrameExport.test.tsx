// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef, useState } from 'react'
import { CanvasFrameExport } from './CanvasFrameExport'

const frame = { id: 'settings', title: 'Settings', src: 'Settings one.html', x: 0, y: 0, w: 390, h: 844 }
const props = { frame, baseUrl: '/redline/artifacts/0123456789abcdef/', apiUrl: '/api/redline/artifacts/0123456789abcdef/canvas/frames', manifest: 'custom.json', token: 'owner' }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function ExportHarness(exportProps: Omit<Parameters<typeof CanvasFrameExport>[0], 'anchor' | 'overlay' | 'onClose'>) {
  const overlay = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return <div><div className="canvas-world" style={{ transform: 'scale(0.11)' }}>
    <button aria-label="Export Settings" onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>⤓</button>
  </div><div ref={overlay} className="canvas-export-overlay">{anchor && overlay.current && <CanvasFrameExport {...exportProps} anchor={anchor} overlay={overlay.current} onClose={() => setAnchor(null)} />}</div></div>
}
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Export Settings' }))
describe('frame export menu', () => {
  it('renders outside the scaled world and closes on Escape or outside click', () => {
    render(<ExportHarness {...props} />); openMenu()
    const menu = screen.getByRole('menu')
    expect(menu.closest('.canvas-world')).toBeNull()
    expect(menu.closest('.canvas-export-overlay')).not.toBeNull()
    fireEvent.pointerDown(menu)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    openMenu(); fireEvent.click(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    openMenu(); fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
  it('clamps the measured menu inside the overlay near the bottom/right edge', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(380)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(190)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(90)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      return (this.tagName === 'BUTTON' ? { left: 470, top: 370, bottom: 390 } : { left: 100, top: 100 }) as DOMRect
    })
    render(<ExportHarness {...props} />); openMenu()
    expect(screen.getByRole('menu')).toHaveStyle({ left: '182px', top: '176px' })
  })
  it('downloads original HTML and fetches PNG with owner auth, then releases the blob URL', async () => {
    const blob = new Blob(['png'], { type: 'image/png' }), fetcher = vi.fn(async () => ({ ok: true, blob: async () => blob }))
    vi.stubGlobal('fetch', fetcher)
    const create = vi.fn(() => 'blob:png'), revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
    const clicks: Array<{ href: string; download: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) { clicks.push({ href: this.href, download: this.download }) })
    render(<ExportHarness {...props} />); openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download HTML' }))
    await waitFor(() => expect(clicks).toEqual([{ href: 'blob:png', download: 'Settings one.html' }]))
    expect(fetcher).toHaveBeenCalledWith(props.baseUrl + 'Settings%20one.html', { cache: 'no-store' })
    openMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Download PNG' }))
    await waitFor(() => expect(clicks).toEqual([{ href: 'blob:png', download: 'Settings one.html' }, { href: 'blob:png', download: 'settings.png' }]))
    expect(fetcher).toHaveBeenCalledWith(`${props.apiUrl}/settings.png?manifest=custom.json`, { credentials: 'same-origin', headers: { Authorization: 'Bearer owner' } })
    expect(create).toHaveBeenCalledWith(blob)
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:png'), { timeout: 1500 })
  })
  it('shows a clear missing-browser error and permits retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'No Chromium-family browser found. Install Google Chrome.' }) })))
    render(<ExportHarness {...props} />); openMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Download PNG' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No Chromium-family browser found')
    expect(screen.getByRole('menuitem', { name: 'Download PNG' })).toBeEnabled()
  })
  it('exports snapshot HTML and disables PNG so it cannot silently export the live frame', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['html']) }))
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => 'blob:html'), revokeObjectURL: vi.fn() }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ExportHarness {...props} snapshot baseUrl="/redline/canvas-snapshots/artifact/round/" />); openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download HTML' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/redline/canvas-snapshots/artifact/round/Settings%20one.html', { cache: 'no-store' }))
    openMenu()
    expect(screen.getByRole('menuitem', { name: 'Download PNG' })).toBeDisabled()
  })
})

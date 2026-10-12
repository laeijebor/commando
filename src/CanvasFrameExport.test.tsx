// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasFrameExport } from './CanvasFrameExport'

const frame = { id: 'settings', title: 'Settings', src: 'Settings one.html', x: 0, y: 0, w: 390, h: 844 }
const props = { frame, baseUrl: '/redline/artifacts/0123456789abcdef/', apiUrl: '/api/redline/artifacts/0123456789abcdef/canvas/frames', manifest: 'custom.json', token: 'owner' }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const openMenu = () => fireEvent.click(screen.getByLabelText('Export Settings', { selector: 'summary' }))
describe('frame export menu', () => {
  it('downloads original HTML and fetches PNG with owner auth, then releases the blob URL', async () => {
    const blob = new Blob(['png'], { type: 'image/png' }), fetcher = vi.fn(async () => ({ ok: true, blob: async () => blob }))
    vi.stubGlobal('fetch', fetcher)
    const create = vi.fn(() => 'blob:png'), revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
    const clicks: Array<{ href: string; download: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) { clicks.push({ href: this.href, download: this.download }) })
    render(<CanvasFrameExport {...props} />); openMenu()
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
    render(<CanvasFrameExport {...props} />); openMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Download PNG' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No Chromium-family browser found')
    expect(screen.getByRole('menuitem', { name: 'Download PNG' })).toBeEnabled()
  })
  it('exports snapshot HTML and disables PNG so it cannot silently export the live frame', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['html']) }))
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => 'blob:html'), revokeObjectURL: vi.fn() }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<CanvasFrameExport {...props} snapshot baseUrl="/redline/canvas-snapshots/artifact/round/" />); openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download HTML' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/redline/canvas-snapshots/artifact/round/Settings%20one.html', { cache: 'no-store' }))
    openMenu()
    expect(screen.getByRole('menuitem', { name: 'Download PNG' })).toBeDisabled()
  })
})

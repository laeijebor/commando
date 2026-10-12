// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasHistory } from './CanvasHistory'

const props = { apiUrl: '/api/redline/artifacts/0123456789abcdef/canvas/snapshots', token: 'owner', selected: null, disabled: false, onSelect: vi.fn() }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('canvas history menu', () => {
  it('starts closed, shows Live first and exposes partial snapshots with date/title details', async () => {
    const snapshot = { id: 'round', createdAt: 10, comments: 1, partial: true, manifestTitle: 'Old board' }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ snapshots: [snapshot] }) })))
    const select = vi.fn()
    render(<CanvasHistory {...props} onSelect={select} />)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('History'))
    const item = await screen.findByRole('menuitemradio', { name: /1 comment · partial/ })
    expect(screen.getAllByRole('menuitemradio')[0]).toHaveTextContent('Live')
    expect(item.getAttribute('title')).toContain('Old board')
    fireEvent.click(item); expect(select).toHaveBeenCalledWith(snapshot); expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
  it('reports failed history loads, reloads on reopening, and disables switching while edits are busy', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }).mockResolvedValueOnce({ ok: true, json: async () => ({ snapshots: [] }) })
    vi.stubGlobal('fetch', fetcher)
    render(<CanvasHistory {...props} disabled />)
    fireEvent.click(screen.getByLabelText('History'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load history (401)')
    expect(screen.getByRole('menuitemradio', { name: 'Live' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('History')); fireEvent.click(screen.getByLabelText('History'))
    expect(await screen.findByText('No snapshots yet')).toBeInTheDocument(); expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('ignores an old list response after changing artifacts', async () => {
    let finish!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { finish = resolve })))
    const { rerender } = render(<CanvasHistory {...props} />)
    fireEvent.click(screen.getByLabelText('History'))
    rerender(<CanvasHistory {...props} apiUrl="/other/snapshots" />)
    finish({ ok: true, json: async () => ({ snapshots: [{ id: 'stale', createdAt: 1, comments: 99, partial: false, manifestTitle: 'Stale' }] }) })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(screen.queryByText(/99 comments/)).not.toBeInTheDocument()
  })
})

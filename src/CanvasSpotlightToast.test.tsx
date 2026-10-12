// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CanvasSpotlightToast } from './CanvasSpotlightToast'
import { publishCanvasSpotlights } from './webPanesApi'
const id = 'w-12345678', request = { id: 'sr-12345678', label: 'Row', message: 'Changed', requestedBy: 'claude', requestedAt: 1 }
beforeEach(() => publishCanvasSpotlights({}))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); publishCanvasSpotlights({}) })
it('dismisses without showing and receives the pending snapshot when mounted later', async () => {
  publishCanvasSpotlights({ [id]: request })
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, json: async () => ({ decision: 'dismissed' }) }))
  vi.stubGlobal('fetch', fetcher)
  const show = vi.fn()
  render(<CanvasSpotlightToast webPaneId={id} token="owner" onShow={show} />)
  expect(screen.getByRole('alertdialog')).toHaveTextContent('claude wants to show you Row — Changed')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  expect(show).not.toHaveBeenCalled()
  expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({ decision: 'dismiss' })
})
it('surfaces a failed decision and replaces superseded/closed requests', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Already superseded' }) })))
  const show = vi.fn()
  render(<CanvasSpotlightToast webPaneId={id} token="owner" onShow={show} />)
  act(() => publishCanvasSpotlights({ [id]: request }))
  fireEvent.click(screen.getByRole('button', { name: 'Show me' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Already superseded')
  expect(show).not.toHaveBeenCalled()
  act(() => publishCanvasSpotlights({ [id]: { ...request, id: 'sr-87654321', label: 'New' } }))
  expect(screen.getByRole('alertdialog')).toHaveTextContent('New')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  act(() => publishCanvasSpotlights({}))
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})

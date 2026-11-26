// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { SnapshotCopyBanner } from './SnapshotCopyBanner'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('leaves cancellation untouched and keeps restore errors available for retry', async () => {
  const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce(null).mockReturnValue('/tmp/existing')
  const fetcher = vi.fn(async () => Response.json({ error: 'Destination already exists; choose a new folder' }, { status: 409 }))
  vi.stubGlobal('fetch', fetcher)
  render(<SnapshotCopyBanner webPaneId="w-12345678" savedAt={1} token="owner" />)
  fireEvent.click(screen.getByRole('button', { name: 'Restore to folder…' }))
  expect(fetcher).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Restore to folder…' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Destination already exists')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Restore to folder…' })).toBeEnabled())
  expect(prompt).toHaveBeenCalledTimes(2)
})

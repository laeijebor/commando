// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitDiffModal } from './GitDiffModal'
import type { GitDiffApiClient, GitDiffSummary } from './gitApi'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const summary: GitDiffSummary = {
  isRepo: true,
  root: '/repo',
  branch: 'feature',
  target: 'main',
  additions: 3,
  deletions: 1,
  files: [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1, binary: false }],
}

function fakeApi(): GitDiffApiClient {
  return {
    summary: vi.fn(async (_paneId: string, target?: string) => ({ ...summary, target: target ?? 'main' })),
    fileDiff: vi.fn(async (_paneId: string, file: string) => ({ file, diff: 'DIFF' })),
    branches: vi.fn(async () => ({
      isRepo: true,
      current: 'feature',
      branches: ['main', 'origin/main', 'origin/release-2', 'feature'],
    })),
  }
}

function renderModal(api = fakeApi(), onClose = vi.fn()) {
  render(
    <GitDiffModal paneId="%1" panePath="/repo" api={api} initialSummary={summary} onClose={onClose} />,
  )
  return { api, onClose }
}

describe('GitDiffModal engine and layout toggles', () => {
  it('re-requests the diff with the chosen engine and layout, and persists them', async () => {
    const { api } = renderModal()
    const fileDiff = api.fileDiff as ReturnType<typeof vi.fn>
    await waitFor(() => expect(fileDiff).toHaveBeenCalled())
    expect(fileDiff.mock.lastCall?.[2]).toMatchObject({ engine: 'difftastic', display: 'side-by-side' })

    fireEvent.click(screen.getByRole('button', { name: 'delta' }))
    await waitFor(() => {
      expect(fileDiff.mock.lastCall?.[2]).toMatchObject({ engine: 'delta', display: 'side-by-side' })
    })

    fireEvent.click(screen.getByRole('button', { name: 'inline' }))
    await waitFor(() => {
      expect(fileDiff.mock.lastCall?.[2]).toMatchObject({ engine: 'delta', display: 'inline' })
    })

    expect(window.localStorage.getItem('commando-diff-engine')).toBe('delta')
    expect(window.localStorage.getItem('commando-diff-display')).toBe('inline')
  })
})

describe('GitDiffModal target combobox', () => {
  it('suggests branches excluding the current one and filters as you type', async () => {
    renderModal()
    const input = screen.getByRole('combobox', { name: 'Diff target branch' })

    fireEvent.focus(input)
    await screen.findByRole('listbox')
    // On focus every branch is offered (no filtering by the prefilled draft),
    // except the current branch.
    expect(screen.queryByRole('button', { name: 'feature' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'main' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'origin/release-2' })).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'release' } })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'main' })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'origin/release-2' })).toBeInTheDocument()
  })

  it('applies a clicked suggestion as the diff target', async () => {
    const { api } = renderModal()
    const input = screen.getByRole('combobox', { name: 'Diff target branch' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'origin/m' } })
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'origin/main' }))

    expect(input).toHaveValue('origin/main')
    await waitFor(() => {
      expect(api.summary).toHaveBeenCalledWith('%1', 'origin/main')
    })
  })

  it('selects the highlighted suggestion with arrow keys and Enter', async () => {
    const { api } = renderModal()
    const input = screen.getByRole('combobox', { name: 'Diff target branch' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'origin' } })
    await screen.findByRole('listbox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue('origin/release-2')
    await waitFor(() => {
      expect(api.summary).toHaveBeenCalledWith('%1', 'origin/release-2')
    })
  })

  it('closes only the dropdown on Escape, then the modal', async () => {
    const { onClose } = renderModal()
    const input = screen.getByRole('combobox', { name: 'Diff target branch' })

    fireEvent.focus(input)
    await screen.findByRole('listbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

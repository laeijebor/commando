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

function fakeApi(nextSummary: GitDiffSummary = summary): GitDiffApiClient {
  return {
    summary: vi.fn(async (_paneId: string, target?: string) => ({
      ...nextSummary,
      target: target ?? nextSummary.target ?? 'main',
    })),
    fileDiff: vi.fn(async (_paneId: string, file: string) => ({ file, diff: 'DIFF' })),
    search: vi.fn(async (_paneId: string, query: string) => ({
      query,
      matches: [],
      totalMatches: 0,
      matchingFiles: 0,
      truncated: false,
    })),
    branches: vi.fn(async () => ({
      isRepo: true,
      current: 'feature',
      branches: ['main', 'origin/main', 'origin/release-2', 'feature'],
    })),
  }
}

function renderModal(api = fakeApi(), onClose = vi.fn(), initialSummary = summary) {
  render(
    <GitDiffModal paneId="%1" panePath="/repo" api={api} initialSummary={initialSummary} onClose={onClose} />,
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

describe('GitDiffModal changed file navigation', () => {
  const nestedSummary: GitDiffSummary = {
    ...summary,
    files: [
      { path: 'src/components/Button.tsx', status: 'M', additions: 3, deletions: 1, binary: false },
      { path: 'src/api/client.ts', status: 'A', additions: 20, deletions: 0, binary: false },
      { path: 'README.md', status: 'M', additions: 1, deletions: 1, binary: false },
    ],
  }

  it('shows an expanded folder tree by default and exposes full paths in tooltips', async () => {
    renderModal(fakeApi(nestedSummary), vi.fn(), nestedSummary)

    expect(screen.getByRole('button', { name: 'Tree view' })).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole('tree', { name: 'Changed file tree' })).toBeInTheDocument()
    expect(screen.getByLabelText('Collapse folder src')).toBeInTheDocument()
    expect(screen.getByLabelText('Collapse folder src/components')).toBeInTheDocument()

    fireEvent.mouseEnter(screen.getByText('Button.tsx').closest('button')!)
    expect(screen.getByRole('tooltip')).toHaveTextContent('src/components/Button.tsx')
  })

  it('collapses folders and persists the alternate flat list view', async () => {
    const view = render(
      <GitDiffModal
        paneId="%1"
        panePath="/repo"
        api={fakeApi(nestedSummary)}
        initialSummary={nestedSummary}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByLabelText('Collapse folder src'))
    expect(screen.queryByText('Button.tsx')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Expand folder src')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'List view' }))
    expect(screen.queryByRole('tree', { name: 'Changed file tree' })).not.toBeInTheDocument()
    expect(screen.getByText('src/components/Button.tsx')).toBeInTheDocument()
    expect(window.localStorage.getItem('commando-diff-file-view')).toBe('list')

    view.unmount()
    renderModal(fakeApi(nestedSummary), vi.fn(), nestedSummary)
    expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('resizes the file panel with pointer and keyboard controls and restores its width', () => {
    const view = render(
      <GitDiffModal
        paneId="%1"
        panePath="/repo"
        api={fakeApi(nestedSummary)}
        initialSummary={nestedSummary}
        onClose={vi.fn()}
      />,
    )
    const panel = screen.getByRole('complementary', { name: 'Changed files' })
    const handle = screen.getByRole('separator', { name: 'Resize changed files panel' })

    expect(panel).toHaveStyle({ width: '300px' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(panel).toHaveStyle({ width: '308px' })
    expect(window.localStorage.getItem('commando-diff-file-panel-width')).toBe('308')

    fireEvent.pointerDown(handle, { button: 0, clientX: 300 })
    fireEvent.pointerMove(window, { clientX: 380 })
    fireEvent.pointerUp(window)
    expect(panel).toHaveStyle({ width: '388px' })
    expect(window.localStorage.getItem('commando-diff-file-panel-width')).toBe('388')

    fireEvent.doubleClick(handle)
    expect(panel).toHaveStyle({ width: '300px' })
    view.unmount()

    window.localStorage.setItem('commando-diff-file-panel-width', '420')
    renderModal(fakeApi(nestedSummary), vi.fn(), nestedSummary)
    expect(screen.getByRole('complementary', { name: 'Changed files' })).toHaveStyle({ width: '420px' })
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

  it('offers an auto option that returns to the branch-point default', async () => {
    const { api } = renderModal()
    const input = screen.getByRole('combobox', { name: 'Diff target branch' })

    fireEvent.focus(input)
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'main' }))
    await waitFor(() => expect(api.summary).toHaveBeenCalledWith('%1', 'main'))

    fireEvent.focus(input)
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'auto - branch point' }))
    expect(input).toHaveValue('')
    await waitFor(() => {
      const calls = (api.summary as ReturnType<typeof vi.fn>).mock.calls
      expect(calls[calls.length - 1]).toEqual(['%1', undefined])
    })
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

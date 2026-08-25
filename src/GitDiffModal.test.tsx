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
      files: [],
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

  it('keeps an explicit PR comparison fixed across summary and file requests', async () => {
    const api = fakeApi()
    const view = render(
      <GitDiffModal
        paneId="%1"
        panePath="/repo"
        api={api}
        initialSummary={summary}
        comparison={{
          base: 'base-oid',
          head: 'head-oid',
          baseLabel: 'main',
          headLabel: 'feature/pr-diff',
        }}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => expect(api.summary).toHaveBeenCalledWith('%1', 'base-oid', 'head-oid'))
    await waitFor(() => expect(api.fileDiff).toHaveBeenCalledWith(
      '%1',
      'a.ts',
      expect.objectContaining({ target: 'base-oid', head: 'head-oid' }),
    ))
    expect(screen.getByTitle('head-oid')).toHaveTextContent('feature/pr-diff')
    expect(screen.getByTitle('base-oid')).toHaveTextContent('main')
    expect(screen.queryByRole('combobox', { name: 'Diff target branch' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search diff contents' }), {
      target: { value: 'needle' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'all' }))
    await waitFor(() => expect(api.search).toHaveBeenCalledWith(
      '%1',
      'needle',
      'base-oid',
      'head-oid',
    ))

    view.rerender(
      <GitDiffModal
        paneId="%1"
        panePath="/repo"
        api={api}
        initialSummary={summary}
        comparison={{
          base: 'new-base-oid',
          head: 'head-oid',
          baseLabel: 'release',
          headLabel: 'feature/pr-diff',
        }}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(api.summary).toHaveBeenCalledWith('%1', 'new-base-oid', 'head-oid'))
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

  it('filters file paths in both tree and list views while preserving matching ancestors', async () => {
    renderModal(fakeApi(nestedSummary), vi.fn(), nestedSummary)
    await screen.findByText('Button.tsx')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter changed file paths' }), {
      target: { value: 'components/button' },
    })

    await waitFor(() => expect(screen.queryByText('client.ts')).not.toBeInTheDocument())
    expect(screen.getByText('Button.tsx')).toBeInTheDocument()
    expect(screen.queryByText('README.md')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Folder src, expanded by search')).toBeInTheDocument()
    expect(screen.getByLabelText('Folder src/components, expanded by search')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'List view' }))
    expect(screen.getByText('src/components/Button.tsx')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter changed file paths' }), {
      target: { value: 'does-not-exist' },
    })
    expect(await screen.findByText('No changed files match this search')).toBeInTheDocument()
  })
})

describe('GitDiffModal content search', () => {
  it('highlights ANSI-spanning matches in the current diff and navigates between them', async () => {
    const api = fakeApi()
    ;(api.fileDiff as ReturnType<typeof vi.fn>).mockResolvedValue({
      file: 'a.ts',
      diff: 'prefix \u001b[31mNeed\u001b[32mle\u001b[0m suffix needle',
    })
    renderModal(api)
    await waitFor(() => expect(api.fileDiff).toHaveBeenCalled())

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search diff contents' }), {
      target: { value: 'needle' },
    })

    await waitFor(() => {
      expect(document.querySelectorAll('[data-diff-search-match]')).toHaveLength(2)
    })
    expect(screen.getByRole('status')).toHaveTextContent('1 / 2')
    expect(document.querySelector('[data-diff-search-match="0"]')).toHaveClass('active')

    fireEvent.click(screen.getByRole('button', { name: 'Next diff match' }))
    expect(screen.getByRole('status')).toHaveTextContent('2 / 2')
    expect(document.querySelector('[data-diff-search-match="1"]')).toHaveClass('active')
    fireEvent.click(screen.getByRole('button', { name: 'Previous diff match' }))
    expect(screen.getByRole('status')).toHaveTextContent('1 / 2')
  })

  it('searches all changed files, narrows the tree, and exposes per-file match counts', async () => {
    const nestedSummary: GitDiffSummary = {
      ...summary,
      files: [
        { path: 'src/components/Button.tsx', status: 'M', additions: 3, deletions: 1, binary: false },
        { path: 'src/api/client.ts', status: 'A', additions: 20, deletions: 0, binary: false },
        { path: 'README.md', status: 'M', additions: 1, deletions: 1, binary: false },
      ],
    }
    const api = fakeApi(nestedSummary)
    ;(api.fileDiff as ReturnType<typeof vi.fn>).mockImplementation(async (_paneId: string, file: string) => ({
      file,
      diff: file.includes('Button') ? 'needle and needle' : 'needle',
    }))
    ;(api.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: 'needle',
      files: [
        { file: 'src/components/Button.tsx', matches: 2 },
        { file: 'README.md', matches: 1 },
      ],
      matches: [
        { file: 'src/components/Button.tsx', line: 3, side: 'added', preview: 'needle and needle', occurrences: 2 },
        { file: 'README.md', line: 1, side: 'added', preview: 'needle', occurrences: 1 },
      ],
      totalMatches: 3,
      matchingFiles: 2,
      truncated: false,
    })
    renderModal(api, vi.fn(), nestedSummary)
    await screen.findByText('Button.tsx')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search diff contents' }), {
      target: { value: 'needle' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'all' }))

    await waitFor(() => expect(api.search).toHaveBeenCalledWith('%1', 'needle', undefined))
    await waitFor(() => expect(screen.queryByText('client.ts')).not.toBeInTheDocument())
    expect(screen.getByText('Button.tsx')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('3 across 2 files')
    expect(document.querySelectorAll('.git-diff-file-search-count')).toHaveLength(2)

    fireEvent.click(screen.getByText('README.md').closest('button')!)
    await waitFor(() => expect(api.fileDiff).toHaveBeenCalledWith(
      '%1',
      'README.md',
      expect.objectContaining({ engine: 'difftastic' }),
    ))
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

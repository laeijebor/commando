// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneGitStats } from './PaneGitStats'
import type { GitDiffApiClient, GitDiffSummary } from './gitApi'

afterEach(cleanup)

function apiWithSummary(summary: GitDiffSummary): GitDiffApiClient {
  return {
    summary: vi.fn().mockResolvedValue(summary),
    fileDiff: vi.fn().mockResolvedValue({ file: '', diff: '' }),
    search: vi.fn().mockResolvedValue({ query: '', matches: [], totalMatches: 0, matchingFiles: 0, truncated: false }),
    branches: vi.fn().mockResolvedValue({ isRepo: true, branches: [] }),
  }
}

describe('PaneGitStats', () => {
  it('links to the open pull request alongside Git changes', async () => {
    render(
      <PaneGitStats
        paneId="%1"
        panePath="/repo"
        connected
        api={apiWithSummary({
          isRepo: true,
          target: 'main',
          additions: 3,
          deletions: 1,
          files: [{ path: 'src/App.tsx', status: 'M', additions: 3, deletions: 1, binary: false }],
          pullRequest: {
            number: 42,
            title: 'Show pull requests in pane footers',
            url: 'https://github.com/example/commando/pull/42',
            isDraft: false,
          },
        })}
      />,
    )

    expect(await screen.findByRole('button', { name: 'Git changes vs main: 1 files, +3 -1' }))
      .toBeVisible()
    const link = screen.getByRole('link', {
      name: 'Open pull request #42: Show pull requests in pane footers',
    })
    expect(link).toHaveTextContent('PR #42')
    expect(link).toHaveAttribute('href', 'https://github.com/example/commando/pull/42')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('keeps the Git indicator when no pull request is available', async () => {
    render(
      <PaneGitStats
        paneId="%1"
        panePath="/repo"
        connected
        api={apiWithSummary({ isRepo: true, target: 'HEAD', additions: 0, deletions: 0, files: [] })}
      />,
    )

    expect(await screen.findByRole('button', { name: 'Git changes vs HEAD: 0 files, +0 -0' }))
      .toBeVisible()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

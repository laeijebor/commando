// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrQuickLook } from './PrQuickLook'
import type { PrsApiClient, PrSummary } from './prsApi'

afterEach(cleanup)
const pr = {
  number: 12,
  title: 'Quick look',
  state: 'open',
  author: 'leo',
  headRefName: 'feature',
  baseRefName: 'main',
  additions: 1,
  deletions: 1,
  commitCount: 1,
  changedFiles: 2,
  reviews: [],
  requestedReviewers: [],
  unresolvedThreads: 1,
  url: 'https://github.com/acme/widgets/pull/12',
} as unknown as PrSummary

function setup() {
  const api = {
    details: vi
      .fn()
      .mockResolvedValue({
        body: '# Complete description\n\nFull body\n\n<sub>Badge text</sub>\n\n<script>window.bad = true</script>\n\n<a href="javascript:alert(1)">Unsafe link</a>',
        conversation: [
          {
            id: '1',
            author: 'reviewer',
            body: '**Complete comment**',
            createdAt: '2026-01-01',
            kind: 'inline comment',
            path: 'a.ts',
            url: pr.url,
          },
        ],
        checks: [{ name: 'build', state: 'pass', url: pr.url }],
      }),
    diff: vi.fn().mockResolvedValue({
      base: '1'.repeat(40),
      head: '2'.repeat(40),
      truncated: false,
      files: [
        { path: 'a.ts', additions: 1, deletions: 1, patch: '@@\n-old\n+new' },
        { path: 'image.png', additions: 0, deletions: 0, patch: null },
      ],
    }),
  }
  const onClose = vi.fn()
  render(
    <PrQuickLook
      pr={pr}
      repo="acme/widgets"
      api={api as unknown as PrsApiClient}
      onClose={onClose}
      actions={null}
    />,
  )
  return { api, onClose }
}

describe('PR quick look', () => {
  it('renders GitHub HTML while removing scripts and unsafe link protocols', async () => {
    setup()
    expect(await screen.findByText('Badge text')).toHaveProperty('tagName', 'SUB')
    expect(document.querySelector('.pr-quick-markdown script')).toBeNull()
    expect(screen.getByText('Unsafe link')).not.toHaveAttribute('href')
  })

  it('renders complete Markdown, checks, conversation, and lazily loaded diff files', async () => {
    const { api } = setup()
    expect(await screen.findByRole('heading', { name: 'Complete description' })).toBeVisible()
    expect(api.diff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'Checks' }))
    expect(screen.getByRole('link', { name: 'build' })).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Conversation' }))
    expect(screen.getByText('Complete comment')).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: /Diff/ }))
    expect(await screen.findByText('+new')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /image.png/ }))
    expect(screen.getByText(/GitHub did not provide a text patch/)).toBeVisible()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter diff files' }), {
      target: { value: 'nope' },
    })
    expect(screen.getByText('No matching files.')).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Description' }))
    fireEvent.click(screen.getByRole('tab', { name: /Diff/ }))
    expect(api.diff).toHaveBeenCalledTimes(1)
  })

  it('supports keyboard tabs, Escape, and focus restoration', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { onClose } = setup()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close PR quick look' })).toHaveFocus())
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Description' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Checks' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    cleanup()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})

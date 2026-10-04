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

function setup(
  overrides: Partial<PrSummary> = {},
  target?: string,
  conversation?: import('../shared/pr-quick-look').PrConversationEntry[],
) {
  const api = {
    details: vi.fn().mockResolvedValue({
      body: '# Complete description\n\nFull body\n\n<sub>Badge text</sub>\n\n<script>window.bad = true</script>\n\n<a href="javascript:alert(1)">Unsafe link</a>',
      conversation: conversation ?? [
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
      ...(target ? { mergeTarget: { branch: target, oid: 'a'.repeat(40) } } : {}),
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
    conflicts: vi.fn().mockResolvedValue({
      state: 'clean',
      baseRefName: 'release',
      headRefName: 'feature',
      baseOid: 'a'.repeat(40),
      headOid: 'b'.repeat(40),
      files: [],
      messages: [],
      truncated: false,
      fetchedAt: Date.now(),
    }),
  }
  const onClose = vi.fn()
  render(
    <PrQuickLook
      pr={{ ...pr, ...overrides }}
      repo="acme/widgets"
      api={api as unknown as PrsApiClient}
      onClose={onClose}
      actions={null}
    />,
  )
  return { api, onClose }
}

describe('PR quick look', () => {
  it('renders replies inside their original comment and suppresses empty reply review wrappers', async () => {
    const entry = {
      author: 'reviewer',
      body: 'Original inline finding',
      url: pr.url,
      createdAt: '2026-01-01',
      kind: 'inline comment',
      path: 'same-file.ts',
    }
    setup({}, undefined, [
      { ...entry, id: '2:10', commentId: 10 },
      { ...entry, id: '2:20', commentId: 20, body: 'Different finding on the same file' },
      { ...entry, id: '1:30', kind: 'commented', reviewId: 30, body: '', createdAt: '2026-01-02' },
      {
        ...entry,
        id: '2:40',
        commentId: 40,
        reviewId: 30,
        replyTo: 10,
        body: 'Fix for the original finding',
        createdAt: '2026-01-02',
      },
    ])
    await screen.findByRole('heading', { name: 'Complete description' })
    fireEvent.click(screen.getByRole('tab', { name: 'Conversation' }))
    const parent = screen.getByText('Original inline finding').closest('.pr-quick-comment')!
    expect(parent).toContainElement(screen.getByText('Fix for the original finding'))
    expect(screen.getByText('Fix for the original finding').closest('.pr-quick-reply')).not.toBeNull()
    expect(
      screen.getByText('Different finding on the same file').closest('.pr-quick-comment'),
    ).not.toContainElement(screen.getByText('Fix for the original finding'))
    expect(screen.queryByText('No review body.')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Conversation/ })).toHaveTextContent('3 entries · 1 reply')
  })

  it('highlights the actual non-main merge target and inspects conflicts on demand', async () => {
    const { api } = setup({ baseRefName: 'release', conflicting: true })
    expect(screen.getByRole('note')).toHaveTextContent('Merges into release, not main.')
    expect(screen.getByRole('note')).toHaveTextContent('Diff tab still compares against origin/main')
    expect(api.conflicts).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'View conflicts' }))
    expect(await screen.findByText('No merge conflicts')).toBeVisible()
    expect(api.conflicts).toHaveBeenCalledWith('acme/widgets', 12)
    expect(screen.queryByRole('button', { name: 'View conflicts' })).not.toBeInTheDocument()
  })

  it('uses the freshly fetched merge target if the PR was retargeted after the HUD polled', async () => {
    setup({}, 'stacked-base')
    expect(await screen.findByRole('note')).toHaveTextContent('Merges into stacked-base, not main.')
  })

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

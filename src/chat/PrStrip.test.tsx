// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanePrSummary, PrsApiClient } from '../prsApi'
import type { PrAutofixStatus, PrSummary } from '../../shared/pr-types'
import { PrStrip } from './PrStrip'

const targetId = '123e4567-e89b-42d3-a456-426614174000'
function pr(number: number, state: PanePrSummary['state'] = 'open'): PanePrSummary {
  return { repo: 'acme/widgets', number, state, title: `Change ${number}`, url: `https://github.com/acme/widgets/pull/${number}`, isDraft: false,
    createdAt: '', updatedAt: '', additions: 125, deletions: 16, conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null,
    checks: { state: 'fail', total: 9, failed: 2, pending: 1, skipped: 3, runs: [], truncated: false } }
}
const head = 'a'.repeat(40)
function mergeable(number: number, patch: Partial<PrSummary> = {}): PanePrSummary {
  const base = pr(number)
  const preview = { number, title: base.title, url: base.url, state: 'open', isDraft: false, author: 'me', bodyExcerpt: '', additions: 1, deletions: 1, changedFiles: 1,
    commitCount: 1, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null, reviews: [], requestedReviewers: [], conflicting: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: null, createdAt: '', updatedAt: '', headRefName: 'feature', baseRefName: 'main',
    headRefOid: head, baseRefOid: 'b'.repeat(40), viewerIsAuthor: true, viewerReviewRequested: false, commandoMarker: null, ...patch } satisfies PrSummary
  return { ...base, preview }
}
const status = (patch: Partial<PrAutofixStatus> = {}): PrAutofixStatus => ({ repo: 'acme/widgets', number: 12, targetId, enabled: true, status: 'watching', rounds: 0, lastEventAt: null, ...patch })
function setup(prs = [pr(12)], current: PrAutofixStatus | null = null, onOpenPr?: (repo: string, number: number, tab: string) => void) {
  const api = {
    pane: vi.fn(async () => ({ targetId, totalCount: prs.length, pullRequests: prs, truncated: false, fetchedAt: Date.now() })),
    autofixStatus: vi.fn(async () => current),
    setAutofix: vi.fn(async (_repo: string, _number: number, enabled: boolean, _pane: string) => status({ enabled, status: enabled ? 'watching' : 'stopped', ...(!enabled ? { reason: 'Disabled' } : {}) })),
    list: vi.fn(async () => { throw new Error('unused') }),
    merge: vi.fn(async (_repo: string, _number: number, _head: string, _base?: string) => ({ merged: true as const })),
  } satisfies Pick<PrsApiClient, 'pane' | 'list' | 'merge' | 'autofixStatus' | 'setAutofix'>
  render(<PrStrip paneId="%1" api={api} connected {...(onOpenPr ? { onOpenPr } : {})} />)
  return api
}
afterEach(cleanup)
async function openCi() {
  fireEvent.click(await screen.findByRole('button', { name: 'CI monitoring for PR #12' }))
  await screen.findByText('CI monitoring')
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
  return screen.getByRole('dialog')
}

describe('chat PR strip', () => {
  it('renders open PRs first, diffs and external links, and collapses more than two PRs', async () => {
    setup([pr(10, 'merged'), pr(11, 'closed'), pr(12), pr(13)])
    const section = await screen.findByRole('region', { name: 'Linked pull requests' })
    expect(within(section).getAllByRole('link').map((link) => link.textContent)).toEqual(['#12 Change 12', '#13 Change 13'])
    expect(screen.getAllByText('+125')).toHaveLength(2)
    expect(screen.getAllByText('−16')).toHaveLength(2)
    const link = screen.getByRole('link', { name: '#12 Change 12' })
    expect(link).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/12')
    expect(link).toHaveAttribute('target', '_blank')
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }))
    expect(screen.getByText('Merged').closest('.chat-pr-row')).toHaveClass('merged')
    expect(screen.getByText('Closed').closest('.chat-pr-row')).toHaveClass('closed')
    expect(screen.queryByRole('button', { name: 'CI monitoring for PR #10' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.queryByText('Merged')).not.toBeInTheDocument()
  })

  it('shows the shared HUD status chips for open PRs only', async () => {
    const open = { ...pr(12), unresolvedThreads: 7, unansweredThreads: 2, conflicting: true }
    setup([open, { ...pr(10, 'merged'), unresolvedThreads: 4 }])
    const row = (await screen.findByRole('link', { name: '#12 Change 12' })).closest('.chat-pr-row') as HTMLElement
    for (const chip of ['✗ 2 failing', '2 unanswered', '5 unresolved', '⚠ conflicts']) expect(within(row).getByText(chip)).toBeInTheDocument()
    const merged = screen.getByText('Merged').closest('.chat-pr-row') as HTMLElement
    expect(within(merged).queryByText(/unresolved|unanswered|failing/)).not.toBeInTheDocument()
  })

  it('opens a PR in the side panel on a plain click and leaves modified clicks to the browser', async () => {
    const onOpenPr = vi.fn()
    setup([pr(12)], null, onOpenPr)
    const link = await screen.findByRole('link', { name: '#12 Change 12' })
    expect(fireEvent.click(link)).toBe(false)
    expect(onOpenPr).toHaveBeenCalledWith('acme/widgets', 12, 'Description')
    expect(fireEvent.click(link, { metaKey: true })).toBe(true)
    expect(onOpenPr).toHaveBeenCalledTimes(1)
  })

  it('opens the matching PR sub-tab from each status chip and keeps GitHub links for modified clicks', async () => {
    const onOpenPr = vi.fn()
    setup([{ ...pr(12), unresolvedThreads: 7, unansweredThreads: 2, conflicting: true }], null, onOpenPr)
    const url = 'https://github.com/acme/widgets/pull/12'
    const chips = [
      ['Open diff for PR #12: +125 -16', `${url}/files`, 'Diff'],
      ['Open checks for PR #12: ✗ 2 failing', `${url}/checks`, 'Checks'],
      ['Open conversation for PR #12: 2 unanswered', url, 'Conversation'],
      ['Open conversation for PR #12: 5 unresolved', url, 'Conversation'],
      ['Open conflicts for PR #12: ⚠ conflicts', url, 'Conflicts'],
    ] as const
    await screen.findByRole('link', { name: '#12 Change 12' })
    for (const [name, href, tab] of chips) {
      const chip = screen.getByRole('link', { name })
      expect(chip).toHaveAttribute('href', href)
      expect(chip).toHaveAttribute('target', '_blank')
      onOpenPr.mockClear()
      expect(fireEvent.click(chip)).toBe(false)
      expect(onOpenPr).toHaveBeenCalledWith('acme/widgets', 12, tab)
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) expect(fireEvent.click(chip, modifier)).toBe(true)
      expect(onOpenPr).toHaveBeenCalledTimes(1)
    }
  })

  it('leaves the status chips as plain text without an in-app opener', async () => {
    setup([{ ...pr(12), unresolvedThreads: 2, conflicting: true }])
    const row = (await screen.findByRole('link', { name: '#12 Change 12' })).closest('.chat-pr-row') as HTMLElement
    expect(within(row).getAllByRole('link')).toHaveLength(1)
    for (const chip of ['✗ 2 failing', '2 unanswered', '⚠ conflicts']) expect(within(row).getByText(chip).tagName).toBe('SPAN')
  })

  it('shows grouped check counts, a checks link, and toggles monitoring through the API', async () => {
    const api = setup()
    const dialog = await openCi()
    for (const [label, count] of [['Passed', '3'], ['Failed', '2'], ['Pending', '1'], ['Skipped', '3']]) {
      expect(within(dialog).getByText(label).parentElement).toHaveTextContent(count)
    }
    expect(within(dialog).getByRole('link', { name: 'Open checks for PR #12' })).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/12/checks')
    const checkbox = screen.getByRole('checkbox', { name: 'Auto-fix CI & address comments' })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox).toBeChecked())
    expect(api.setAutofix).toHaveBeenCalledWith('acme/widgets', 12, true, '%1')
    expect(screen.getByRole('status')).toHaveTextContent('Watching for CI failures and new comments')
    fireEvent.click(checkbox)
    await waitFor(() => expect(checkbox).not.toBeChecked())
    expect(api.setAutofix).toHaveBeenLastCalledWith('acme/widgets', 12, false, '%1')
    expect(screen.getByRole('status')).toHaveTextContent('Stopped · Disabled')
  })

  it('omits zero count rows and closes with Escape or an outside click', async () => {
    const passing = pr(12)
    passing.checks = { state: 'pass', total: 1, failed: 0, pending: 0, runs: [{ name: 'test', state: 'pass' }], truncated: false }
    setup([passing])
    let dialog = await openCi()
    expect(within(dialog).getByText('Passed')).toBeInTheDocument()
    for (const label of ['Failed', 'Pending', 'Skipped']) expect(within(dialog).queryByText(label)).not.toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('CI monitoring')).not.toBeInTheDocument())
    dialog = await openCi()
    fireEvent.mouseDown(document.body)
    fireEvent.mouseUp(document.body)
    fireEvent.click(document.body)
    await waitFor(() => expect(screen.queryByText('CI monitoring')).not.toBeInTheDocument())
  })

  it.each([
    [status({ status: 'fix-requested', rounds: 2 }), 'Fix requested · round 2/5'],
    [status({ status: 'capped', rounds: 5 }), 'Stopped after 5 rounds'],
    [status({ status: 'stopped', enabled: false, reason: 'PR merged' }), 'Stopped · PR merged'],
  ])('shows persisted status and last event time', async (current, text) => {
    setup([pr(12)], { ...current, lastEventAt: 1000 })
    await openCi()
    expect(screen.getByRole('status')).toHaveTextContent(text)
    expect(screen.getByText(/Last event:/)).toHaveAttribute('dateTime', '1970-01-01T00:00:01.000Z')
  })

  it('shows API errors without optimistically enabling monitoring', async () => {
    const api = setup()
    api.setAutofix.mockRejectedValue(new Error('Pane no longer exists'))
    await openCi()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Pane no longer exists')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('merges a mergeable PR from the CI menu and refreshes the pane', async () => {
    const api = setup([mergeable(12)])
    await openCi()
    const button = screen.getByRole('button', { name: 'Merge PR' })
    expect(button).toBeEnabled()
    const calls = api.pane.mock.calls.length
    fireEvent.click(button)
    await waitFor(() => expect(api.merge).toHaveBeenCalledWith('acme/widgets', 12, head, 'main'))
    await waitFor(() => expect(api.pane.mock.calls.length).toBeGreaterThan(calls))
  })

  it.each([
    [mergeable(12, { mergeStateStatus: 'BLOCKED' }), 'GitHub reports unmet merge requirements'],
    [mergeable(12, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), 'Resolve merge conflicts on GitHub first'],
    [pr(12), 'Checking merge readiness'],
  ])('disables merging and explains why when GitHub blocks it', async (blocked, reason) => {
    const api = setup([blocked])
    await openCi()
    const button = screen.getByRole('button', { name: 'Merge PR' })
    expect(button).toBeDisabled()
    expect(screen.getByText(reason)).toBeInTheDocument()
    fireEvent.click(button)
    expect(api.merge).not.toHaveBeenCalled()
  })

  it('shows merge failures in the CI menu', async () => {
    const api = setup([mergeable(12)])
    api.merge.mockRejectedValue(new Error('The PR has new commits. Resync and try again.'))
    await openCi()
    fireEvent.click(screen.getByRole('button', { name: 'Merge PR' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The PR has new commits. Resync and try again.')
  })

  it('renders nothing when no PRs are linked', async () => {
    const api = setup([])
    await waitFor(() => expect(api.pane).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Linked pull requests' })).not.toBeInTheDocument()
  })
})

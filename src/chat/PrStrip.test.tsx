// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanePrSummary, PrsApiClient } from '../prsApi'
import type { PrAutofixStatus } from '../../shared/pr-types'
import { PrStrip } from './PrStrip'

const targetId = '123e4567-e89b-42d3-a456-426614174000'
function pr(number: number, state: PanePrSummary['state'] = 'open'): PanePrSummary {
  return { repo: 'acme/widgets', number, state, title: `Change ${number}`, url: `https://github.com/acme/widgets/pull/${number}`, isDraft: false,
    createdAt: '', updatedAt: '', additions: 125, deletions: 16, conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null,
    checks: { state: 'fail', total: 9, failed: 2, pending: 1, skipped: 3, runs: [], truncated: false } }
}
const status = (patch: Partial<PrAutofixStatus> = {}): PrAutofixStatus => ({ repo: 'acme/widgets', number: 12, targetId, enabled: true, status: 'watching', rounds: 0, lastEventAt: null, ...patch })
function setup(prs = [pr(12)], current: PrAutofixStatus | null = null) {
  const api = {
    pane: vi.fn(async () => ({ targetId, totalCount: prs.length, pullRequests: prs, truncated: false, fetchedAt: Date.now() })),
    autofixStatus: vi.fn(async () => current),
    setAutofix: vi.fn(async (_repo: string, _number: number, enabled: boolean, _pane: string) => status({ enabled, status: enabled ? 'watching' : 'stopped', ...(!enabled ? { reason: 'Disabled' } : {}) })),
  } satisfies Pick<PrsApiClient, 'pane' | 'autofixStatus' | 'setAutofix'>
  render(<PrStrip paneId="%1" api={api} connected />)
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

  it('shows grouped check counts, a checks link, and toggles monitoring through the API', async () => {
    const api = setup()
    const dialog = await openCi()
    for (const [label, count] of [['Passed', '3'], ['Failed', '2'], ['Pending', '1'], ['Skipped', '3']]) {
      expect(within(dialog).getByText(label).parentElement).toHaveTextContent(count)
    }
    expect(screen.getByRole('link', { name: 'Open checks for PR #12' })).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/12/checks')
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

  it('renders nothing when no PRs are linked', async () => {
    const api = setup([])
    await waitFor(() => expect(api.pane).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Linked pull requests' })).not.toBeInTheDocument()
  })
})

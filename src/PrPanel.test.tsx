// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { PrPanel } from './PrPanel'
import { useRepoPrs } from './prStore'
import type { PanePrSummary, PrsApiClient, PrSummary } from './prsApi'

const pr = { number: 12, title: 'Panel PR', url: 'https://github.com/acme/widgets/pull/12', state: 'open', isDraft: false,
  author: 'leo', headRefName: 'feature', baseRefName: 'main', headRefOid: 'b', baseRefOid: 'a',
  updatedAt: '2026-10-12', createdAt: '2026-10-11', reviews: [], requestedReviewers: [], checks: null,
  additions: 1, deletions: 0, unresolvedThreads: 0, commitCount: 1, changedFiles: 1, viewerIsAuthor: true,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } as unknown as PrSummary
const source: PanePrSummary = { ...pr, repo: 'acme/widgets', preview: pr }
function fixture() {
  return {
    details: vi.fn().mockResolvedValue({ body: '# Full description', headOid: 'b', mergeTarget: { branch: 'main', oid: 'a' }, conversation: [], checks: [] }),
    diff: vi.fn().mockResolvedValue({ head: 'b', base: 'a', files: [], truncated: false }),
    list: vi.fn().mockResolvedValue({ repo: 'acme/widgets', pullRequests: [pr] }),
    pane: vi.fn().mockResolvedValue({ targetId: 'target', pullRequests: [source] }),
    conflicts: vi.fn().mockResolvedValue({ state: 'clean', baseRefName: 'main', headRefName: 'feature', baseOid: 'a', headOid: 'b', files: [], messages: [], truncated: false, fetchedAt: Date.now() }),
    merge: vi.fn().mockResolvedValue({ merged: true }),
  }
}
afterEach(() => { cleanup(); vi.useRealTimers() })

it('renders Description without a modal shell, preserves local sub-tab state, and honours HUD selections', async () => {
  const api = fixture()
  const element = (visible = true, selection?: { tab: 'Description' | 'Diff'; revision: number }) => <PrPanel paneId="%12" source={source} api={api as unknown as PrsApiClient} visible={visible} selection={selection} />
  const view = render(element())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Description' })).toHaveAttribute('aria-selected', 'true')
  await screen.findByRole('heading', { name: 'Full description' })
  expect(screen.queryByRole('button', { name: /Close PR|Jump to pane/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Copy branch' })).toBeVisible()
  fireEvent.click(screen.getByRole('tab', { name: 'Checks' }))
  view.rerender(element(false))
  view.rerender(element())
  expect(screen.getByRole('tab', { name: 'Checks' })).toHaveAttribute('aria-selected', 'true')
  view.rerender(element(true, { tab: 'Diff', revision: 1 }))
  await waitFor(() => expect(screen.getByRole('tab', { name: /Diff/ })).toHaveAttribute('aria-selected', 'true'))
  expect(await screen.findByText('No changes vs origin/main.')).toBeVisible()
  view.rerender(element(true, { tab: 'Description', revision: 2 }))
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Description' })).toHaveAttribute('aria-selected', 'true'))
})

it('reuses matching details, diff and conflict snapshots across panel hides and reveals', async () => {
  const api = fixture()
  const element = (visible: boolean) => <PrPanel paneId="%12" source={source} api={api as unknown as PrsApiClient} visible={visible} />
  const view = render(element(true))
  await screen.findByRole('heading', { name: 'Full description' })
  view.rerender(element(false))
  view.rerender(element(true))
  expect(api.details).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('tab', { name: /Diff/ }))
  await screen.findByText('No changes vs origin/main.')
  view.rerender(element(false))
  view.rerender(element(true))
  expect(api.details).toHaveBeenCalledTimes(1)
  expect(api.diff).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('tab', { name: 'Conflicts' }))
  await screen.findByText('No merge conflicts')
  view.rerender(element(false))
  view.rerender(element(true))
  expect(api.details).toHaveBeenCalledTimes(1)
  expect(api.conflicts).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conflicts' }))
  await waitFor(() => expect(api.conflicts).toHaveBeenCalledTimes(2))
})

it('explicit refresh forces matching details to reload and retries the diff', async () => {
  const api = fixture()
  api.diff.mockRejectedValueOnce(new Error('Diff offline'))
  render(<PrPanel paneId="%12" source={source} api={api as unknown as PrsApiClient} visible />)
  await screen.findByRole('heading', { name: 'Full description' })
  fireEvent.click(screen.getByRole('tab', { name: /Diff/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Diff offline')
  expect(api.details).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh PR' }))
  await screen.findByText('No changes vs origin/main.')
  expect(api.details).toHaveBeenCalledTimes(2)
  expect(api.diff).toHaveBeenCalledTimes(2)
})

it('does not poll hidden views or fetch changed details until revealed', async () => {
  vi.useFakeTimers()
  const api = fixture()
  const element = (visible: boolean, updatedAt = pr.updatedAt) => <PrPanel paneId="%12" source={{ ...source, updatedAt, preview: { ...pr, updatedAt } }} api={api as unknown as PrsApiClient} visible={visible} />
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(element(true)) })
  expect(api.details).toHaveBeenCalledTimes(1)
  view.rerender(element(false, '2026-10-13'))
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
  expect(api.details).toHaveBeenCalledTimes(1)
  expect(api.diff).not.toHaveBeenCalled()
  await act(async () => { view.rerender(element(true, '2026-10-13')) })
  expect(api.details).toHaveBeenCalledTimes(2)
})

it('resolves older pane data using the existing list API and keeps merge guards', async () => {
  const api = fixture()
  render(<PrPanel paneId="%12" source={{ ...source, preview: undefined, isDraft: true }} api={api as unknown as PrsApiClient} visible />)
  await screen.findByRole('heading', { name: 'Full description' })
  expect(api.list).toHaveBeenCalledWith('acme/widgets', 'all', { scope: 'everyone' })
  expect(screen.getByRole('button', { name: 'Merge PR' })).toBeDisabled()
})

it('uses already loaded HUD data when pane preview is absent', async () => {
  const api = fixture() as unknown as PrsApiClient
  function HudSource() { useRepoPrs('acme/widgets', 'open', api); return null }
  const view = render(<HudSource />)
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1))
  view.rerender(<><HudSource /><PrPanel paneId="%12" source={{ ...source, preview: undefined }} api={api} visible /></>)
  await screen.findByRole('heading', { name: 'Full description' })
  expect(api.list).toHaveBeenCalledTimes(1)
})

it('keeps sub-tabs and accessibility targets independent across mounted PRs', async () => {
  const api = fixture()
  const next = { ...source, number: 13, title: 'Other PR', preview: { ...pr, number: 13, title: 'Other PR' } }
  const view = render(<><PrPanel paneId="%12" source={source} api={api as unknown as PrsApiClient} visible /><PrPanel paneId="%12" source={next} api={api as unknown as PrsApiClient} visible /></>)
  await screen.findByRole('heading', { name: 'Other PR' })
  const panels = [...view.container.querySelectorAll<HTMLElement>('.pr-quick-embedded')]
  fireEvent.click(within(panels[0]).getByRole('tab', { name: 'Checks' }))
  expect(within(panels[1]).getByRole('tab', { name: 'Description' })).toHaveAttribute('aria-selected', 'true')
  const ids = [...view.container.querySelectorAll('[id]')].map((node) => node.id)
  expect(new Set(ids).size).toBe(ids.length)
})

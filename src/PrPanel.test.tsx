// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PrPanel } from './PrPanel'
import { useRepoPrs } from './prStore'
import type { PanePrSummary, PrsApiClient, PrSummary } from './prsApi'

const quickLookCss = readFileSync('src/pr-quick-look.css', 'utf8')

const pr = { number: 12, title: 'Panel PR', url: 'https://github.com/acme/widgets/pull/12', state: 'open', isDraft: false,
  author: 'leo', headRefName: 'feature', baseRefName: 'main', headRefOid: 'b', baseRefOid: 'a',
  updatedAt: '2026-10-12', createdAt: '2026-10-11', reviews: [], requestedReviewers: [], checks: null,
  additions: 1, deletions: 0, unresolvedThreads: 0, commitCount: 1, changedFiles: 1, viewerIsAuthor: true,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } as unknown as PrSummary
const source: PanePrSummary = { number: pr.number, title: pr.title, url: pr.url, state: pr.state, isDraft: pr.isDraft,
  createdAt: pr.createdAt, updatedAt: pr.updatedAt, additions: pr.additions, deletions: pr.deletions, checks: pr.checks,
  conflicting: pr.conflicting, unresolvedThreads: pr.unresolvedThreads, threadsTruncated: pr.threadsTruncated,
  reviewDecision: pr.reviewDecision, repo: 'acme/widgets', preview: pr }
function fixture() {
  return {
    gitApi: {
      summary: vi.fn().mockResolvedValue({ isRepo: true, root: '/repo', branch: 'feature', target: 'a', files: [] }),
      fileDiff: vi.fn().mockResolvedValue({ file: 'src/app.ts', diff: 'LOCAL PR DIFF' }),
      search: vi.fn().mockResolvedValue({ query: 'DIFF', matches: [], files: [], totalMatches: 0, matchingFiles: 0, truncated: false }),
      branches: vi.fn().mockResolvedValue({ isRepo: true, branches: [] }),
      repo: vi.fn().mockResolvedValue({ isRepo: true }),
    },
    renderDiff: vi.fn().mockResolvedValue('Delta output'),
    details: vi.fn().mockResolvedValue({ body: '# Full description', headOid: 'b', mergeTarget: { branch: 'main', oid: 'a' }, conversation: [], checks: [] }),
    diff: vi.fn().mockResolvedValue({ head: 'b', base: 'a', files: [], truncated: false }),
    list: vi.fn().mockResolvedValue({ repo: 'acme/widgets', pullRequests: [pr] }),
    pane: vi.fn().mockResolvedValue({ targetId: 'target', pullRequests: [source] }),
    conflicts: vi.fn().mockResolvedValue({ state: 'clean', baseRefName: 'main', headRefName: 'feature', baseOid: 'a', headOid: 'b', files: [], messages: [], truncated: false, fetchedAt: Date.now() }),
    merge: vi.fn().mockResolvedValue({ merged: true }),
  }
}
afterEach(() => { cleanup(); vi.useRealTimers() })

it('keeps the panel container and independent Conflicts file and patch layouts', async () => {
  const api = fixture()
  const path = 'src/skills/posthog-experiment/SKILL.md'
  api.conflicts.mockResolvedValue({ state: 'conflicting', baseRefName: 'main', headRefName: 'feature', baseOid: 'a', headOid: 'b',
    files: [{ path, kind: 'content', content: '<<<<<<< HEAD\nconflict\n=======\nPR\n>>>>>>> feature', truncated: false }],
    messages: [], truncated: false, fetchedAt: Date.now() })
  const { container } = render(<PrPanel panePath="/repo" gitApi={api.gitApi} paneId="%12" source={source} api={api as unknown as PrsApiClient} visible />)
  await screen.findByRole('heading', { name: 'Full description' })
  expect(container.firstChild).toHaveClass('pr-quick-embedded')
  expect(quickLookCss).toMatch(/\.pr-quick-embedded\s*\{[^}]*container:\s*pr-quick-panel\s*\/\s*inline-size;/)
  expect(quickLookCss).toContain('@container pr-quick-panel (min-width: 720px)')
  expect(quickLookCss).toMatch(/@container pr-quick-panel[^}]*\.pr-conflict-files-layout\s*\{\s*flex-direction: row;/)
  expect(quickLookCss).toMatch(/\.pr-quick-embedded \.pr-quick-diff > pre\s*\{[^}]*overflow: auto;/)

  fireEvent.click(screen.getByRole('tab', { name: 'Conflicts' }))
  await screen.findByText('conflict')
  const files = container.querySelector('.pr-conflict-files-layout')!
  expect(files.querySelector('.pr-quick-files')).not.toBeNull()
  expect(files.querySelector('.pr-quick-diff > header')).not.toBeNull()
  expect(files.querySelector('.pr-quick-diff > pre .pr-conflict-marker')).toHaveTextContent('<<<<<<< HEAD')
})

it('renders Description without a modal shell, preserves local sub-tab state, and honours HUD selections', async () => {
  const api = fixture()
  const element = (visible = true, selection?: { tab: 'Description' | 'Diff'; revision: number }) => <PrPanel panePath="/repo" gitApi={api.gitApi} paneId="%12" source={source} api={api as unknown as PrsApiClient} visible={visible} selection={selection} />
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
  expect(await screen.findByText('No changes vs a')).toBeVisible()
  view.rerender(element(true, { tab: 'Description', revision: 2 }))
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Description' })).toHaveAttribute('aria-selected', 'true'))
})

it('reuses matching details and conflict snapshots across panel hides and reveals', async () => {
  const api = fixture()
  const element = (visible: boolean) => <PrPanel panePath="/repo" gitApi={api.gitApi} paneId="%12" source={source} api={api as unknown as PrsApiClient} visible={visible} />
  const view = render(element(true))
  await screen.findByRole('heading', { name: 'Full description' })
  view.rerender(element(false))
  view.rerender(element(true))
  expect(api.details).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('tab', { name: /Diff/ }))
  await screen.findByText('No changes vs a')
  view.rerender(element(false))
  view.rerender(element(true))
  expect(api.details).toHaveBeenCalledTimes(1)
  expect(api.diff).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('tab', { name: 'Conflicts' }))
  await screen.findByText('No merge conflicts')
  view.rerender(element(false))
  view.rerender(element(true))
  expect(api.details).toHaveBeenCalledTimes(1)
  expect(api.conflicts).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh conflicts' }))
  await waitFor(() => expect(api.conflicts).toHaveBeenCalledTimes(2))
})

it.each(['summary', 'fileDiff'] as const)('keeps the local %s error and provides a GitHub hint without a remote fallback', async (request) => {
  const api = fixture()
  api.gitApi.summary.mockResolvedValue({ isRepo: true, root: '/repo', files: [
    { path: 'src/app.ts', status: 'M', additions: 1, deletions: 0, binary: false },
  ] })
  api.gitApi[request].mockRejectedValue(new Error('Head commit is unavailable'))
  render(<PrPanel panePath="/repo" gitApi={api.gitApi} paneId="%12" source={source} api={api as unknown as PrsApiClient} visible selection={{ tab: 'Diff', revision: 1 }} />)
  const error = await screen.findByRole('alert')
  expect(error).toHaveTextContent('Head commit is unavailable')
  expect(error).toHaveTextContent('Comparison commits must be available')
  expect(within(error).getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', `${pr.url}/files`)
  expect(api.diff).not.toHaveBeenCalled()
})

it('uses the Changes view for a merged PR and fetches pinned comparisons only while visible', async () => {
  const api = fixture()
  api.gitApi.summary.mockResolvedValue({ isRepo: true, root: '/repo', files: [
    { path: 'src/app.ts', status: 'M', additions: 1, deletions: 0, binary: false },
  ] })
  const merged = { ...source, state: 'merged' as const, preview: { ...pr, state: 'merged' as const } }
  const element = (visible: boolean, head = 'b') => <PrPanel panePath="/repo" gitApi={api.gitApi} paneId="%12"
    source={{ ...merged, preview: { ...merged.preview, headRefOid: head } }} api={api as unknown as PrsApiClient} visible={visible} selection={{ tab: 'Diff', revision: 1 }} />
  const view = render(element(false))
  expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true')
  expect(api.gitApi.summary).not.toHaveBeenCalled()
  expect(api.gitApi.fileDiff).not.toHaveBeenCalled()
  expect(api.gitApi.search).not.toHaveBeenCalled()
  view.rerender(element(true))
  await screen.findByText('LOCAL PR DIFF')
  expect(screen.getByText('Structural diff')).toBeVisible()
  expect(screen.getByTitle('/repo')).toBeVisible()
  expect(screen.getByRole('group', { name: 'Diff engine' })).toBeVisible()
  expect(screen.getByRole('group', { name: 'Diff layout' })).toBeVisible()
  expect(screen.getByRole('tree', { name: 'Changed file tree' })).toBeVisible()
  expect(screen.getByRole('searchbox', { name: 'Filter changed file paths' })).toBeVisible()
  expect(screen.getByRole('searchbox', { name: 'Search diff contents' })).toBeVisible()
  expect(screen.getByTitle('b')).toHaveTextContent('feature')
  expect(screen.getByTitle('a')).toHaveTextContent('main')
  expect(api.gitApi.summary).toHaveBeenCalledExactlyOnceWith('%12', 'a', 'b')
  expect(api.gitApi.fileDiff).toHaveBeenCalledWith('%12', 'src/app.ts', expect.objectContaining({ target: 'a', head: 'b' }))
  expect(api.diff).not.toHaveBeenCalled()
  expect(api.renderDiff).not.toHaveBeenCalled()
  view.rerender(element(false, 'c'))
  expect(api.gitApi.summary).toHaveBeenCalledTimes(1)
  view.rerender(element(true, 'c'))
  await waitFor(() => expect(api.gitApi.summary).toHaveBeenCalledWith('%12', 'a', 'c'))
})

it('does not poll hidden views or fetch changed details until revealed', async () => {
  vi.useFakeTimers()
  const api = fixture()
  const element = (visible: boolean, updatedAt = pr.updatedAt) => <PrPanel panePath="/repo" gitApi={api.gitApi} paneId="%12" source={{ ...source, updatedAt, preview: { ...pr, updatedAt } }} api={api as unknown as PrsApiClient} visible={visible} />
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
  render(<PrPanel panePath="/repo" gitApi={api.gitApi} paneId="%12" source={{ ...source, preview: undefined, isDraft: true }} api={api as unknown as PrsApiClient} visible />)
  await screen.findByRole('heading', { name: 'Full description' })
  expect(api.list).toHaveBeenCalledWith('acme/widgets', 'all', { scope: 'everyone' })
  expect(screen.getByRole('button', { name: 'Merge PR' })).toBeDisabled()
})

it('uses already loaded HUD data when pane preview is absent', async () => {
  const api = fixture()
  function HudSource() { useRepoPrs('acme/widgets', 'open', api as unknown as PrsApiClient); return null }
  const view = render(<HudSource />)
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1))
  view.rerender(<><HudSource /><PrPanel panePath="/repo" gitApi={api.gitApi} paneId="%12" source={{ ...source, preview: undefined }} api={api as unknown as PrsApiClient} visible /></>)
  await screen.findByRole('heading', { name: 'Full description' })
  expect(api.list).toHaveBeenCalledTimes(1)
})

it('keeps sub-tabs and accessibility targets independent across mounted PRs', async () => {
  const api = fixture()
  const next = { ...source, number: 13, title: 'Other PR', preview: { ...pr, number: 13, title: 'Other PR' } }
  const view = render(<><PrPanel panePath="/repo" gitApi={api.gitApi} paneId="%12" source={source} api={api as unknown as PrsApiClient} visible /><PrPanel panePath="/repo" gitApi={api.gitApi} paneId="%12" source={next} api={api as unknown as PrsApiClient} visible /></>)
  await screen.findByRole('heading', { name: 'Other PR' })
  const panels = [...view.container.querySelectorAll<HTMLElement>('.pr-quick-embedded')]
  fireEvent.click(within(panels[0]).getByRole('tab', { name: 'Checks' }))
  expect(within(panels[1]).getByRole('tab', { name: 'Description' })).toHaveAttribute('aria-selected', 'true')
  const ids = [...view.container.querySelectorAll('[id]')].map((node) => node.id)
  expect(new Set(ids).size).toBe(ids.length)
})

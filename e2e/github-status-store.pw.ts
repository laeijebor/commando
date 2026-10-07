import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'
import type { PrSummary } from '../src/prsApi'

const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5346)
let vite: ViteDevServer
test.beforeAll(async () => {
  vite = await createServer({ server: { host: '127.0.0.1', port, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:9', '/ws': { target: 'ws://127.0.0.1:9', ws: true } } } })
  await vite.listen()
})
test.afterAll(async () => { await vite?.close() })

test('sidebar, session pills, and HUD share the latest GitHub status in both directions', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const pane: TmuxPane = {
    id: '%12', targetId: '550e8400-e29b-41d4-a716-446655440012', index: 0, windowId: '@1', sessionId: '$1',
    title: 'GitHub status fixture', command: 'zsh', path: '/tmp/github-status-fixture', active: true, dead: false,
    width: 80, height: 24, cursorX: 0, cursorY: 0, alternateSavedX: 0, alternateSavedY: 0,
    alternateOn: false, cursorVisible: true, cursorShape: 'block', cursorBlinking: false,
    scrollRegionUpper: 0, scrollRegionLower: 23, wrapFlag: true, originFlag: false, insertFlag: false,
    keypadFlag: false, keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
  }
  const snapshot: CommandoSnapshot = {
    revision: 1, capturedAt: Date.now(), ports: [], panes: [pane],
    sessions: [{ id: '$1', name: 'Shared GitHub status', attached: true, activeWindowId: '@1', windowIds: ['@1'] }],
    windows: [{ id: '@1', index: 0, sessionId: '$1', name: 'work', active: true, layout: '', paneIds: ['%12'] }],
  }
  const pr: PrSummary = {
    number: 12, title: 'One shared PR status', url: 'https://github.com/acme/widgets/pull/12', state: 'open', isDraft: false,
    author: 'leo', bodyExcerpt: 'The sidebar and HUD must agree.', additions: 42, deletions: 7, changedFiles: 1, commitCount: 1,
    unresolvedThreads: 0, unansweredThreads: 0, threadsTruncated: false, reviewDecision: 'approved', reviews: [], requestedReviewers: [],
    conflicting: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: null,
    createdAt: '', updatedAt: '', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
    viewerIsAuthor: true, viewerReviewRequested: false, commandoMarker: { targetId: pane.targetId!, relation: 'created' },
  }
  let phase = 0
  let paneRequests = 0
  let repoRequests = 0
  let merged = false
  await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
    socket.onMessage(() => {})
  })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    let json: unknown = {}
    if (url.pathname === '/api/auth/bootstrap') json = { enabled: false, needsOwner: false, ownerEmail: null }
    else if (url.pathname === '/api/snapshot') json = snapshot
    else if (url.pathname === '/api/session-management/preferences') json = { preferences: { version: 1, groups: [], ungroupedSessionIds: ['$1'], groupingMode: 'manual' } }
    else if (url.pathname === '/api/session-management/archives') json = { archives: [] }
    else if (url.pathname === '/api/git/summary') json = { isRepo: false }
    else if (url.pathname === '/api/prs/repo') json = { repo: 'acme/widgets' }
    else if (url.pathname === '/api/prs/prefs') json = { prefs: { version: 1, pinnedRepos: [], recentRepos: [], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } }
    else if (url.pathname === '/api/prs/repos') json = { repos: [{ nameWithOwner: 'acme/widgets', pinned: false }] }
    else if (url.pathname === '/api/prs/pane') {
      paneRequests += 1
      const summary = phase >= 2 ? { ...pr, conflicting: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } : pr
      json = { list: { targetId: pane.targetId, totalCount: 1, truncated: false, fetchedAt: phase >= 2 ? 500 : 100,
        pullRequests: [{ ...summary, repo: 'acme/widgets', preview: summary }] } }
    } else if (url.pathname === '/api/prs') {
      repoRequests += 1
      const summary = phase === 0 ? { ...pr, unresolvedThreads: 1, unansweredThreads: 1 } : pr
      json = { list: { repo: 'acme/widgets', filter: 'open', viewer: 'leo', totalCount: merged ? 0 : 1, truncated: false,
        mineTruncated: false, fetchedAt: phase >= 3 ? 600 : phase >= 1 ? 300 : 200, pullRequests: merged ? [] : [summary] } }
    } else if (url.pathname === '/api/prs/merge') { merged = true; json = { merged: true } }
    await route.fulfill({ json })
  })
  await page.clock.install()
  await page.goto(`http://127.0.0.1:${port}/#token=github-status-fixture`)
  const sidebar = page.getByRole('region', { name: 'Open pull requests in Shared GitHub status' })
  await expect(sidebar.getByRole('link', { name: pr.title })).toBeVisible()
  await page.getByRole('tab', { name: 'PRs', exact: true }).click()
  const hud = page.locator('.hud-tab-content .prs-section')
  await expect(hud.getByText('1 unanswered', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('1 unanswered', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'PR #12 in Shared GitHub status: 1 unresolved comment thread' })).toBeVisible()
  const beforeRefresh = paneRequests
  phase = 1
  await hud.getByRole('button', { name: 'Resync pull requests' }).click()
  await expect(hud.getByText('1 unanswered', { exact: true })).toHaveCount(0)
  await expect(sidebar.getByText('1 unanswered', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'PR #12 in Shared GitHub status: Ready to merge' })).toBeVisible()
  expect(paneRequests).toBe(beforeRefresh)
  expect(repoRequests).toBe(2)

  phase = 2
  await page.clock.fastForward(5 * 60_000)
  await expect(sidebar.getByText('⚠ conflicts', { exact: true })).toBeVisible()
  await expect(hud.getByText('⚠ conflicts', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'PR #12 in Shared GitHub status: Merge conflicts' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('shared-github-status.png') })

  phase = 3
  await hud.getByRole('button', { name: 'Resync pull requests' }).click()
  await expect(sidebar.getByText('⚠ conflicts', { exact: true })).toHaveCount(0)
  await hud.locator('.pr-card').hover()
  await page.clock.runFor(400)
  await page.getByRole('dialog', { name: 'Details for #12' }).getByRole('button', { name: 'Merge PR', exact: true }).click()
  await expect(hud.getByText('No open pull requests')).toBeVisible()
  await expect(page.getByRole('button', { name: /PR #12 in Shared GitHub status:/ })).toHaveCount(0)
  await expect(sidebar.getByText('No open pull requests in this session.')).toBeVisible()
  expect(errors).toEqual([])
})

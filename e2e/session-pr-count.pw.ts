import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'
import type { PanePrSummary } from '../src/prsApi'

const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5297)
let vite: ViteDevServer
test.beforeAll(async () => {
  vite = await createServer({ server: { host: '127.0.0.1', port, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:9', '/ws': { target: 'ws://127.0.0.1:9', ws: true } } } })
  await vite.listen()
})
test.afterAll(async () => { await vite?.close() })

test('session counts include inactive panes and update after a PR merges', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const pane: TmuxPane = {
    id: '%1', targetId: '550e8400-e29b-41d4-a716-446655440001', index: 0, windowId: '@1', sessionId: '$1',
    title: 'Agent', command: 'zsh', path: '/tmp/session-pr-count', active: true, dead: false,
    width: 80, height: 24, cursorX: 0, cursorY: 0, alternateSavedX: 0, alternateSavedY: 0,
    alternateOn: false, cursorVisible: true, cursorShape: 'block', cursorBlinking: false,
    scrollRegionUpper: 0, scrollRegionLower: 23, wrapFlag: true, originFlag: false, insertFlag: false,
    keypadFlag: false, keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
  }
  const snapshot: CommandoSnapshot = {
    revision: 1, capturedAt: Date.now(), ports: [],
    panes: [pane, { ...pane, id: '%2', targetId: '550e8400-e29b-41d4-a716-446655440002', index: 1 },
      { ...pane, id: '%3', targetId: '550e8400-e29b-41d4-a716-446655440003', sessionId: '$2', windowId: '@2' }],
    sessions: [
      { id: '$1', name: 'work', attached: true, activeWindowId: '@1', windowIds: ['@1'] },
      { id: '$2', name: 'Long inactive session with open PRs', attached: false, activeWindowId: '@2', windowIds: ['@2'] },
    ],
    windows: [
      { id: '@1', index: 0, sessionId: '$1', name: 'work', active: true, layout: '', paneIds: ['%1', '%2'] },
      { id: '@2', index: 0, sessionId: '$2', name: 'other', active: true, layout: '', paneIds: ['%3'] },
    ],
  }
  const pr = (number: number, state: PanePrSummary['state'] = 'open'): PanePrSummary => ({
    repo: 'acme/app', number, state, title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`,
    isDraft: number === 2, createdAt: '', updatedAt: '', additions: 0, deletions: 0, checks: null,
    conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null,
  })
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
    else if (url.pathname === '/api/session-management/preferences') json = { preferences: { version: 1, groups: [], ungroupedSessionIds: ['$1', '$2'], groupingMode: 'manual' } }
    else if (url.pathname === '/api/session-management/archives') json = { archives: [] }
    else if (url.pathname === '/api/git/summary') json = { isRepo: false }
    else if (url.pathname === '/api/prs/repo') json = { repo: null }
    else if (url.pathname === '/api/prs/pane') {
      const id = url.searchParams.get('paneId')
      const pullRequests = id === '%3' ? [pr(5)] : [pr(1, merged ? 'merged' : 'open'), ...(id === '%1' ? [pr(2), pr(3, 'closed')] : [])]
      json = { list: { targetId: pane.targetId, totalCount: pullRequests.length, pullRequests, truncated: false, fetchedAt: Date.now() } }
    } else if (url.pathname === '/api/prs/prefs') json = { prefs: { version: 1, pinnedRepos: [], recentRepos: [], lastRepo: null, lastFilter: 'open', lastScope: 'mine' } }
    else if (url.pathname === '/api/prs/repos') json = { repos: [] }
    await route.fulfill({ json })
  })
  await page.clock.install()
  await page.goto(`http://127.0.0.1:${port}/#token=session-pr-count-fixture`)
  await expect(page.getByRole('img', { name: '2 open pull requests in work' })).toBeVisible()
  const inactiveBadge = page.getByRole('img', { name: '1 open pull request in Long inactive session with open PRs' })
  await expect(inactiveBadge).toBeVisible()
  const row = inactiveBadge.locator('..')
  const rowBounds = await row.boundingBox()
  const badgeBounds = await inactiveBadge.boundingBox()
  expect(badgeBounds!.x + badgeBounds!.width).toBeLessThanOrEqual(rowBounds!.x + rowBounds!.width)
  await page.screenshot({ path: testInfo.outputPath('session-pr-counts.png') })
  merged = true
  await page.clock.fastForward(5 * 60_000)
  await expect(page.getByRole('img', { name: '1 open pull request in work' })).toBeVisible()
  await expect(inactiveBadge).toBeVisible()
  expect(errors).toEqual([])
})

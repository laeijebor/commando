import { expect, test, type WebSocketRoute } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'
import type { PrList, PrSummary } from '../src/prsApi'

// Real App and CSS, with all daemon traffic fulfilled inside the browser test.
const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5287)
const baseUrl = `http://127.0.0.1:${port}`
let vite: ViteDevServer

test.beforeAll(async () => {
  vite = await createServer({
    server: {
      host: '127.0.0.1', port, strictPort: true,
      // Fail closed if a route is missed; never proxy to a shared daemon.
      proxy: {
        '/api': 'http://127.0.0.1:9',
        '/screenshots': 'http://127.0.0.1:9',
        '/ws': { target: 'ws://127.0.0.1:9', ws: true },
      },
    },
  })
  await vite.listen()
})
test.afterAll(async () => { await vite?.close() })

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  const size = viewport.width === 390 ? 'narrow' : 'desktop'
  test(`${size}: producing session survives navigation and rename, with branch fallback`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
    const errors: string[] = []
    const unexpectedRoutes: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })

    const panes: TmuxPane[] = [12, 21].map((id, index) => ({
      id: `%${id}`, targetId: `550e8400-e29b-41d4-a716-4466554400${id}`,
      index: 0, windowId: index ? '@5' : '@2', sessionId: index ? '$6' : '$3',
      title: index ? 'review-agent' : 'editor', command: 'zsh', path: '/tmp/pr-session-fixture',
      active: true, dead: false, width: 80, height: 24, cursorX: 0, cursorY: 0,
      alternateSavedX: 0, alternateSavedY: 0, alternateOn: false, cursorVisible: true,
      cursorShape: 'block', cursorBlinking: false, scrollRegionUpper: 0, scrollRegionLower: 23,
      wrapFlag: true, originFlag: false, insertFlag: false, keypadFlag: false,
      keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
    }))
    const snapshot: CommandoSnapshot = {
      revision: 1, capturedAt: Date.now(), ports: [], panes,
      sessions: panes.map((pane, index) => ({
        id: pane.sessionId, name: index ? 'release-review' : 'workspace-editor',
        attached: !index, activeWindowId: pane.windowId, windowIds: [pane.windowId],
      })),
      windows: panes.map((pane) => ({
        id: pane.windowId, index: 0, sessionId: pane.sessionId, name: pane.title,
        active: true, layout: `dbde,80x24,0,0,${pane.id.slice(1)}`, paneIds: [pane.id],
      })),
    }
    const pr: PrSummary = {
      number: 128, title: 'Show the producing session in PR footers',
      url: 'https://github.com/acme/widgets/pull/128', state: 'open', isDraft: false,
      author: 'leo', bodyExcerpt: 'Keep the source session visible while reviewing work across sessions.',
      additions: 42, deletions: 7, changedFiles: 4, commitCount: 2,
      unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null,
      reviews: [], requestedReviewers: [], conflicting: false,
      checks: { state: 'pass', runs: [{ name: 'Tests', state: 'pass' }], failed: 0, pending: 0, total: 1, truncated: false },
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
      headRefName: 'fix/pr-session-label', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
      viewerIsAuthor: true, viewerReviewRequested: false,
      commandoMarker: { version: 1, targetId: panes[1].targetId, relation: 'created' },
    }
    const list: PrList = {
      repo: 'acme/widgets', filter: 'open', viewer: 'leo', totalCount: 1,
      pullRequests: [pr], truncated: false, mineTruncated: false, fetchedAt: Date.now(),
    }
    let socket: WebSocketRoute | undefined
    let listRequests = 0
    const publishSnapshot = () => {
      snapshot.revision += 1
      socket!.send(JSON.stringify({ type: 'snapshot', snapshot }))
    }
    await page.routeWebSocket((url) => url.pathname === '/ws', (route) => {
      socket = route
      route.send(JSON.stringify({ type: 'snapshot', snapshot }))
      route.onMessage(() => {})
    })
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      let json: unknown
      if (path === '/api/auth/bootstrap') json = { enabled: false, needsOwner: false, ownerEmail: null }
      else if (path === '/api/snapshot') json = snapshot
      else if (path === '/api/git/summary') json = { isRepo: false }
      else if (path === '/api/session-management/preferences') json = { preferences: { version: 1, groups: [], ungroupedSessionIds: ['$3', '$6'] } }
      else if (path === '/api/prs/prefs') json = { prefs: { version: 1, pinnedRepos: [], recentRepos: ['acme/widgets'], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } }
      else if (path === '/api/prs/repos') json = { repos: [{ nameWithOwner: 'acme/widgets', pinned: true }] }
      else if (path === '/api/prs/repo') json = { repo: 'acme/widgets' }
      else if (path === '/api/prs/pane') json = { list: { targetId: panes.find((pane) => pane.id === new URL(route.request().url()).searchParams.get('paneId'))?.targetId, pullRequests: [], totalCount: 0, truncated: false, fetchedAt: Date.now() } }
      else if (path === '/api/prs') { listRequests += 1; json = { list } }
      else if (path === '/api/session-management/sessions/%246/rename') {
        snapshot.sessions[1].name = route.request().postDataJSON().name
        publishSnapshot()
        json = { ok: true }
      } else {
        unexpectedRoutes.push(`${route.request().method()} ${path}`)
        await route.abort()
        return
      }
      await route.fulfill({ json })
    })

    const openPanel = async (name: 'HUD' | 'session tree') => {
      if (size === 'narrow') {
        const closePanel = page.locator('aside.panel-open').getByRole('button', { name: /^Hide (HUD|session tree)$/ })
        if (await closePanel.count()) await closePanel.click()
        await page.getByRole('button', { name: `Open ${name}`, exact: true }).click()
        await expect(page.locator('aside.panel-open')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
      }
    }
    await page.goto(`${baseUrl}/#token=pr-session-fixture`)
    await expect(page.locator('.managed-session.selected strong')).toHaveText('workspace-editor')
    await openPanel('HUD')
    await page.getByRole('tab', { name: 'PRs', exact: true }).click()
    const card = page.locator('.pr-card').filter({ hasText: '#128' })
    const label = card.locator('.pr-foot .pr-branch')
    await expect(label).toHaveText('release-review')
    await expect(label).toHaveAttribute('title', `Session: release-review\nBranch: ${pr.headRefName}`)
    await page.screenshot({ path: testInfo.outputPath(`${size}-live.png`) })

    await card.hover()
    const popover = page.getByRole('dialog', { name: 'Details for #128' })
    await expect(popover).toBeVisible()
    await expect(popover.locator('.pr-pop-row.mono')).toContainText(pr.headRefName)
    await popover.getByRole('button', { name: 'Copy branch', exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(pr.headRefName)
    await page.screenshot({ path: testInfo.outputPath(`${size}-popover.png`) })

    for (const action of ['session click', 'session keyboard', 'pane pill']) {
      const sessionButton = card.getByRole('button', { name: 'release-review', exact: true })
      if (action === 'session click') await sessionButton.click()
      else if (action === 'session keyboard') {
        await sessionButton.focus()
        await expect(sessionButton).toBeFocused()
        await sessionButton.press('Enter')
      } else await card.getByRole('button', { name: 'Jump to producing pane for PR #128' }).click()
      await expect(page.locator('.managed-session.selected strong')).toHaveText('release-review')
      await expect(page.locator('[data-pane-id="%21"]')).toBeVisible()
      await expect(page.locator('[data-pane-id="%21"]')).toHaveClass(/is-jump-highlighted/)
      await expect(page.getByRole('textbox', { name: 'review-agent terminal input', exact: true })).toBeFocused()
      await expect(label).toHaveText('release-review')
      await openPanel('session tree')
      await page.locator('.managed-session-main').filter({ hasText: 'workspace-editor' }).click()
      await openPanel('HUD')
      await expect(label).toHaveText('release-review')
    }

    const requestsBeforeRename = listRequests
    await openPanel('session tree')
    await page.getByRole('button', { name: 'Actions for release-review', exact: true }).click()
    page.once('dialog', (dialog) => dialog.accept('release-review-renamed'))
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    await openPanel('HUD')
    await expect(label).toHaveText('release-review-renamed')
    await expect(page.locator('.managed-session.selected strong')).toHaveText('workspace-editor')

    await page.screenshot({ path: testInfo.outputPath(`${size}-renamed.png`) })
    const longName = 'release-review-with-a-very-long-producing-session-name-'.repeat(4)
    snapshot.sessions[1].name = longName
    publishSnapshot()
    await expect(label).toHaveText(longName)
    await expect(label).toHaveAttribute('title', `Session: ${longName}\nBranch: ${pr.headRefName}`)
    await expect(label).toHaveCSS('text-overflow', 'ellipsis')
    const geometry = await label.evaluate((element) => {
      const card = element.closest('.pr-card')!
      const time = card.querySelector('.pr-time')!
      const bounds = element.getBoundingClientRect()
      const cardBounds = card.getBoundingClientRect()
      return {
        truncated: element.scrollWidth > element.clientWidth,
        labelContained: bounds.left >= cardBounds.left && bounds.right <= time.getBoundingClientRect().left,
        cardContained: cardBounds.left >= 0 && cardBounds.right <= innerWidth,
        documentContained: document.documentElement.scrollWidth <= innerWidth,
      }
    })
    expect(geometry).toEqual({ truncated: true, labelContained: true, cardContained: true, documentContained: true })
    await page.screenshot({ path: testInfo.outputPath(`${size}-long-name.png`) })

    snapshot.panes = snapshot.panes.filter((pane) => pane.id !== '%21')
    snapshot.windows = snapshot.windows.filter((window) => window.id !== '@5')
    snapshot.sessions = snapshot.sessions.filter((session) => session.id !== '$6')
    publishSnapshot()
    await expect(label).toHaveText(pr.headRefName)
    await expect(label).toHaveAttribute('title', pr.headRefName)
    await expect(card.locator('.pr-session-link')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Jump to producing pane for PR #128' })).toHaveCount(0)
    await expect(card.getByRole('button', { name: /Open diff/ })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`${size}-removed-target.png`) })
    expect(listRequests).toBe(requestsBeforeRename)
    expect(unexpectedRoutes).toEqual([])
    expect(errors).toEqual([])
  })
}

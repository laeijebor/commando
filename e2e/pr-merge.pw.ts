import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { PrSummary } from '../src/prsApi'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'

// Real cockpit and CSS; daemon/GitHub traffic is fulfilled locally.
const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5291)
const baseUrl = `http://127.0.0.1:${port}`
let vite: ViteDevServer
test.beforeAll(async () => {
  vite = await createServer({ server: {
    host: '127.0.0.1', port, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:9', '/ws': { target: 'ws://127.0.0.1:9', ws: true } },
  } })
  await vite.listen()
})
test.afterAll(async () => { await vite?.close() })

for (const width of [1440, 390]) {
  test(`${width}px: merge disabled, pending, error, and success states`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors: string[] = []
    const unexpectedRoutes: string[] = []
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
    const pr: PrSummary = {
      number: 12, title: 'Add merge action to PR details', url: 'https://github.com/acme/widgets/pull/12',
      state: 'open', isDraft: false, author: 'leo', bodyExcerpt: 'Merge directly from the PR popover.',
      additions: 42, deletions: 7, changedFiles: 3, commitCount: 2, unresolvedThreads: 0,
      threadsTruncated: false, reviewDecision: null, reviews: [], requestedReviewers: [],
      conflicting: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      headRefName: 'feat/pr-merge', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
      viewerIsAuthor: true, viewerReviewRequested: false, commandoMarker: null,
    }
    let merged = false
    let refuse = true
    let finishMerge: (() => void) | undefined
    const writes: unknown[] = []
    const pane: TmuxPane = {
      id: '%12', targetId: '550e8400-e29b-41d4-a716-446655440012',
      index: 0, windowId: '@2', sessionId: '$3', title: 'merge-fixture', command: 'zsh', path: '/tmp/pr-merge-fixture',
      active: true, dead: false, width: 80, height: 24, cursorX: 0, cursorY: 0,
      alternateSavedX: 0, alternateSavedY: 0, alternateOn: false, cursorVisible: true,
      cursorShape: 'block', cursorBlinking: false, scrollRegionUpper: 0, scrollRegionLower: 23,
      wrapFlag: true, originFlag: false, insertFlag: false, keypadFlag: false,
      keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
    }
    const snapshot: CommandoSnapshot = {
      revision: 1, capturedAt: Date.now(), ports: [], panes: [pane],
      sessions: [{ id: '$3', name: 'merge-fixture', attached: true, activeWindowId: '@2', windowIds: ['@2'] }],
      windows: [{ id: '@2', index: 0, sessionId: '$3', name: 'merge-fixture', active: true, layout: 'dbde,80x24,0,0,12', paneIds: ['%12'] }],
    }
    await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
      socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
      socket.onMessage(() => {})
    })
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      let json: unknown
      if (path === '/api/auth/bootstrap') json = { enabled: false, needsOwner: false, ownerEmail: null }
      else if (path === '/api/snapshot') json = snapshot
      else if (path === '/api/session-management/preferences') json = { preferences: { version: 1, groups: [], ungroupedSessionIds: ['$3'] } }
      else if (path === '/api/session-management/archives') json = { archives: [] }
      else if (path === '/api/git/summary') json = { isRepo: false }
      else if (path === '/api/prs/repo') json = { repo: 'acme/widgets' }
      else if (path === '/api/prs/pane') json = { list: { targetId: pane.targetId, pullRequests: [], totalCount: 0, truncated: false, fetchedAt: Date.now() } }
      else if (path === '/api/prs/prefs') json = { prefs: { version: 1, pinnedRepos: [], recentRepos: ['acme/widgets'], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } }
      else if (path === '/api/prs/repos') json = { repos: [{ nameWithOwner: 'acme/widgets', pinned: true }] }
      else if (path === '/api/prs') json = { list: {
        repo: 'acme/widgets', filter: 'open', viewer: 'leo', totalCount: merged ? 0 : 1,
        pullRequests: merged ? [] : [pr], truncated: false, mineTruncated: false, fetchedAt: Date.now(),
      } }
      else if (path === '/api/prs/merge') {
        writes.push(route.request().postDataJSON())
        await new Promise<void>((resolve) => { finishMerge = resolve })
        if (refuse) {
          await route.fulfill({ status: 409, json: { error: 'GitHub reports unmet merge requirements', code: 'not_mergeable' } })
          return
        }
        merged = true
        json = { merged: true }
      } else { unexpectedRoutes.push(path); await route.abort(); return }
      await route.fulfill({ json })
    })
    await page.goto(`${baseUrl}/#token=pr-merge-fixture`)
    await expect(page.locator('.managed-session.selected strong')).toHaveText('merge-fixture')
    if (width === 390) await page.getByRole('button', { name: 'Open HUD', exact: true }).click()
    await page.getByRole('tab', { name: 'PRs', exact: true }).click()
    const card = page.locator('.pr-card')
    await card.hover()
    const popover = page.getByRole('dialog', { name: 'Details for #12' })
    const button = popover.getByRole('button', { name: 'Merge PR', exact: true })
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('title', 'GitHub reports unmet merge requirements')
    await expect(button).toHaveCSS('opacity', '0.55')
    await page.screenshot({ path: testInfo.outputPath(`${width}-disabled.png`) })

    pr.mergeStateStatus = 'CLEAN'
    await page.getByRole('button', { name: 'Resync pull requests' }).click()
    await card.hover()
    await expect(button).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath(`${width}-ready.png`) })
    await button.click()
    await expect(popover.getByRole('button', { name: 'Merging…' })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath(`${width}-pending.png`) })
    expect(writes).toEqual([{ repo: 'acme/widgets', number: 12, headRefOid: pr.headRefOid, baseRefName: pr.baseRefName }])
    await expect.poll(() => Boolean(finishMerge)).toBe(true)
    finishMerge!()
    await expect(popover.getByRole('alert')).toHaveText('GitHub reports unmet merge requirements')
    await expect(button).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath(`${width}-error.png`) })

    refuse = false
    finishMerge = undefined
    await card.hover()
    await button.click()
    await expect.poll(() => Boolean(finishMerge)).toBe(true)
    finishMerge!()
    await expect(page.getByText('No open pull requests')).toBeVisible()
    expect(writes).toHaveLength(2)
    expect(errors).toEqual([])
    expect(unexpectedRoutes).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`${width}-merged.png`) })
  })
}

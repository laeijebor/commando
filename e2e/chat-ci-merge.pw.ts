import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { ChatState } from '../shared/agent-chat'
import type { PrSummary } from '../src/prsApi'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'

// Real cockpit and CSS; daemon/GitHub traffic is fulfilled locally.
const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5292)
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

test('merges from the chat PR strip CI menu once GitHub allows it', async ({ page }, testInfo) => {
  const errors: string[] = []
  const unexpectedRoutes: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const pane: TmuxPane = {
    id: '%12', targetId: '550e8400-e29b-41d4-a716-446655440012',
    index: 0, windowId: '@2', sessionId: '$3', title: 'chat-fixture', command: 'node', path: '/tmp/chat-ci-merge-fixture',
    active: true, dead: false, width: 80, height: 24, cursorX: 0, cursorY: 0,
    alternateSavedX: 0, alternateSavedY: 0, alternateOn: false, cursorVisible: true,
    cursorShape: 'block', cursorBlinking: false, scrollRegionUpper: 0, scrollRegionLower: 23,
    wrapFlag: true, originFlag: false, insertFlag: false, keypadFlag: false,
    keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
  }
  const snapshot: CommandoSnapshot = {
    revision: 1, capturedAt: Date.now(), ports: [], panes: [pane],
    sessions: [{ id: '$3', name: 'chat-fixture', attached: true, activeWindowId: '@2', windowIds: ['@2'] }],
    windows: [{ id: '@2', index: 0, sessionId: '$3', name: 'chat-fixture', active: true, layout: 'dbde,80x24,0,0,12', paneIds: ['%12'] }],
  }
  const chat: ChatState = {
    paneId: pane.id, targetId: pane.targetId, items: [], hostConnected: true,
    session: { paneId: pane.id, provider: 'claude', cwd: pane.path, status: 'idle', hostPid: 1, hostVersion: 1 },
  }
  const preview: PrSummary = {
    number: 12, title: 'Merge from the CI menu', url: 'https://github.com/acme/widgets/pull/12',
    state: 'open', isDraft: false, author: 'leo', bodyExcerpt: '', additions: 42, deletions: 7, changedFiles: 3, commitCount: 2,
    unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null, reviews: [], requestedReviewers: [],
    conflicting: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
    checks: { state: 'pass', total: 4, failed: 0, pending: 0, runs: [], truncated: false },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    headRefName: 'ci-menu', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
    viewerIsAuthor: true, viewerReviewRequested: false, commandoMarker: null,
  }
  let merged = false
  const writes: unknown[] = []
  const paneList = () => {
    const { number, title, url, isDraft, createdAt, updatedAt, conflicting, unresolvedThreads, threadsTruncated, reviewDecision, checks } = preview
    const state = merged ? 'merged' : 'open'
    return { targetId: pane.targetId, totalCount: 1, truncated: false, fetchedAt: Date.now(), pullRequests: [{
      repo: 'acme/widgets', number, title, url, state, isDraft, createdAt, updatedAt, additions: 42, deletions: 7,
      conflicting, unresolvedThreads, threadsTruncated, reviewDecision, checks, preview: { ...preview, state },
    }] }
  }
  await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
    socket.send(JSON.stringify({ type: 'chat_snapshot', chats: [chat] }))
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
    else if (path === '/api/prs/pane') json = { list: paneList() }
    else if (path === '/api/prs/autofix') json = { status: null }
    else if (path === '/api/prs/prefs') json = { prefs: { version: 1, pinnedRepos: [], recentRepos: ['acme/widgets'], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } }
    else if (path === '/api/prs/repos') json = { repos: [{ nameWithOwner: 'acme/widgets', pinned: true }] }
    else if (path === '/api/prs/merge') {
      writes.push(route.request().postDataJSON())
      merged = true
      json = { merged: true }
    } else { unexpectedRoutes.push(path); await route.abort(); return }
    await route.fulfill({ json })
  })
  await page.goto(`${baseUrl}/#token=chat-ci-merge-fixture`)
  const strip = page.getByRole('region', { name: 'Linked pull requests' })
  await strip.getByRole('button', { name: 'CI monitoring for PR #12' }).click()
  const menu = page.getByRole('dialog', { name: 'CI monitoring for PR #12' })
  const button = menu.getByRole('button', { name: 'Merge PR', exact: true })
  await expect(button).toBeDisabled()
  await expect(menu.getByText('GitHub reports unmet merge requirements')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('blocked.png') })

  preview.mergeStateStatus = 'CLEAN'
  await page.reload()
  await strip.getByRole('button', { name: 'CI monitoring for PR #12' }).click()
  await expect(button).toBeEnabled()
  await expect(menu.getByText('GitHub reports unmet merge requirements')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('ready.png') })
  await button.click()
  await expect(strip.getByText('Merged')).toBeVisible()
  expect(writes).toEqual([{ repo: 'acme/widgets', number: 12, headRefOid: preview.headRefOid, baseRefName: 'main' }])
  await page.screenshot({ path: testInfo.outputPath('merged.png') })
  expect(errors).toEqual([])
  expect(unexpectedRoutes).toEqual([])
})

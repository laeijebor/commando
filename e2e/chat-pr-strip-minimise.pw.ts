import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { ChatState } from '../shared/agent-chat'
import type { PrSummary } from '../src/prsApi'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'

// Real cockpit and CSS; daemon/GitHub traffic is fulfilled locally.
const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5293)
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

test('minimises a long chat PR strip to one summary line and remembers it', async ({ page }, testInfo) => {
  const errors: string[] = []
  const unexpectedRoutes: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const pane: TmuxPane = {
    id: '%12', targetId: '550e8400-e29b-41d4-a716-446655440013',
    index: 0, windowId: '@2', sessionId: '$3', title: 'chat-fixture', command: 'node', path: '/tmp/chat-pr-strip-fixture',
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
  const now = new Date().toISOString()
  const pullRequests = Array.from({ length: 12 }, (_, index) => {
    const number = 580 + index
    const state = index < 2 ? 'merged' : 'open'
    const checks = { state: index === 5 ? 'fail' : 'pass', total: 4, failed: index === 5 ? 1 : 0, pending: 0, runs: [], truncated: false } as const
    return { repo: 'acme/widgets', number, title: `feat(frontend): change number ${number}`, url: `https://github.com/acme/widgets/pull/${number}`,
      state, isDraft: false, createdAt: now, updatedAt: now, additions: 400 + index, deletions: 12, conflicting: false,
      unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null, checks }
  })
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
    else if (path === '/api/prs/pane') json = { list: { targetId: pane.targetId, totalCount: pullRequests.length, truncated: false, fetchedAt: Date.now(), pullRequests } }
    else if (path === '/api/prs/prefs') json = { prefs: { version: 1, pinnedRepos: [], recentRepos: ['acme/widgets'], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } }
    else if (path === '/api/prs/repos') json = { repos: [{ nameWithOwner: 'acme/widgets', pinned: true }] }
    else { unexpectedRoutes.push(path); await route.abort(); return }
    await route.fulfill({ json })
  })
  await page.goto(`${baseUrl}/#token=chat-pr-strip-fixture`)
  const strip = page.getByRole('region', { name: 'Linked pull requests' })
  const toggle = strip.getByRole('button', { name: '12 PRs · 10 open · 2 merged · 1 failing' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(strip.locator('.chat-pr-row')).toHaveCount(12)
  const expandedHeight = (await strip.boundingBox())?.height ?? 0
  await page.screenshot({ path: testInfo.outputPath('expanded.png') })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(strip.locator('.chat-pr-row')).toHaveCount(0)
  const minimisedHeight = (await strip.boundingBox())?.height ?? 0
  expect(minimisedHeight).toBeLessThan(40)
  expect(minimisedHeight).toBeLessThan(expandedHeight / 5)
  await page.screenshot({ path: testInfo.outputPath('minimised.png') })

  await page.reload()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(strip.locator('.chat-pr-row')).toHaveCount(0)
  await toggle.click()
  await expect(strip.locator('.chat-pr-row')).toHaveCount(12)
  expect(errors).toEqual([])
  expect(unexpectedRoutes).toEqual([])
})

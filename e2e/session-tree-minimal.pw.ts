import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { AgentStatus, CommandoSnapshot, PaneMark, SessionBrief, SessionIde, TmuxPane } from '../shared/protocol'
import type { PanePrSummary } from '../src/prsApi'

const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5298)
let vite: ViteDevServer
test.beforeAll(async () => {
  vite = await createServer({ server: { host: '127.0.0.1', port, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:9', '/ws': { target: 'ws://127.0.0.1:9', ws: true } } } })
  await vite.listen()
})
test.afterAll(async () => { await vite?.close() })

const basePane: TmuxPane = {
  id: '%0', targetId: '', index: 0, windowId: '@0', sessionId: '$0',
  title: 'Agent', command: 'zsh', path: '/tmp/session-tree-minimal', active: true, dead: false,
  width: 80, height: 24, cursorX: 0, cursorY: 0, alternateSavedX: 0, alternateSavedY: 0,
  alternateOn: false, cursorVisible: true, cursorShape: 'block', cursorBlinking: false,
  scrollRegionUpper: 0, scrollRegionLower: 23, wrapFlag: true, originFlag: false, insertFlag: false,
  keypadFlag: false, keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
}

// name, pane count, then per-pane agent status (null = no agent)
const fixture: Array<[string, Array<AgentStatus['status'] | null>]> = [
  ['Start other agents', ['done']],
  ['Show triggered agents progress', ['done']],
  ['chat providers', ['done']],
  ['Chat', ['working', 'done', null]],
  ['New accounts in friends rail', ['needs_input']],
  ['Bouse Touse', ['working']],
  ['Flag tidy ups', ['done', 'working']],
  ['Belt Road improvements', ['done']],
  ['LIVE_OPPONENT_CHALLENGE_OPEN', [null]],
]

test('session rows show one indicator, the name and muted glyphs without expanding', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const panes: TmuxPane[] = []
  const statuses: AgentStatus[] = []
  const snapshot: CommandoSnapshot = { revision: 1, capturedAt: Date.now(), ports: [], panes, sessions: [], windows: [] }
  fixture.forEach(([name, paneStatuses], sessionIndex) => {
    const sessionId = `$${sessionIndex + 1}`
    const windowId = `@${sessionIndex + 1}`
    const paneIds = paneStatuses.map((status, index) => {
      const id = `%${sessionIndex * 10 + index + 1}`
      panes.push({ ...basePane, id, targetId: `550e8400-e29b-41d4-a716-4466554400${String(sessionIndex * 10 + index).padStart(2, '0')}`, index, windowId, sessionId })
      if (status) statuses.push({ paneId: id, provider: 'claude', status, summary: '', source: 'hook', confidence: 'high', reason: '', updatedAt: 1 })
      return id
    })
    snapshot.sessions.push({ id: sessionId, name, attached: sessionIndex === 0, activeWindowId: windowId, windowIds: [windowId] })
    snapshot.windows.push({ id: windowId, index: 0, sessionId, name: 'zsh', active: true, layout: '', paneIds })
  })
  const paneOf = (session: string) => panes.find((pane) => pane.sessionId === snapshot.sessions.find((item) => item.name === session)!.id)!
  const marks: PaneMark[] = [{ targetId: paneOf('Belt Road improvements').targetId, label: 'Blocked', tone: 'red', markedAt: 1, activityCount: 2 }]
  const simPane = paneOf('New accounts in friends rail')
  const briefs: SessionBrief[] = [{
    paneId: simPane.id, targetId: simPane.targetId, sessionId: simPane.sessionId, sessionName: 'New accounts in friends rail',
    state: 'needs_input', headline: 'Friends rail', headlineSource: 'hook', updates: [], updatedAt: 1,
    simulator: { udid: 'SIM-1', label: 'New accounts · friends rail', task: 'friends rail', sessionName: 'New accounts in friends rail', ports: [], idle: false },
  }]
  const ides: SessionIde[] = [{ id: 'ide-1111111111111111', sessionIds: [paneOf('Show triggered agents progress').sessionId], workspacePath: '/worktree', state: 'ready', generation: 1, url: '/ide/ide-1111111111111111/' }]
  const pr = (number: number, patch: Partial<PanePrSummary>): PanePrSummary => ({
    repo: 'acme/app', number, state: 'open', title: `PR ${number}`, url: `https://github.com/acme/app/pull/${number}`,
    isDraft: false, createdAt: '', updatedAt: '', additions: 0, deletions: 0, checks: null,
    conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null, ...patch,
  })
  const prsByPane: Record<string, PanePrSummary[]> = {
    [paneOf('chat providers').id]: [pr(64, { unresolvedThreads: 2 })],
    [paneOf('Flag tidy ups').id]: [57, 58, 59].map((number) => pr(number, { conflicting: true })),
    [paneOf('Start other agents').id]: [pr(70, { isDraft: true })],
  }

  await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
    socket.send(JSON.stringify({ type: 'agent_status_snapshot', statuses }))
    socket.send(JSON.stringify({ type: 'pane_mark_snapshot', marks }))
    socket.send(JSON.stringify({ type: 'session_brief_snapshot', briefs }))
    socket.send(JSON.stringify({ type: 'session_ides', ides }))
    socket.onMessage(() => {})
  })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    let json: unknown = {}
    if (url.pathname === '/api/auth/bootstrap') json = { enabled: false, needsOwner: false, ownerEmail: null }
    else if (url.pathname === '/api/snapshot') json = snapshot
    else if (url.pathname === '/api/session-management/preferences') json = { preferences: { version: 1, groups: [{ id: 'commando', name: 'Commando', sessionIds: snapshot.sessions.map((session) => session.id) }], ungroupedSessionIds: [], groupingMode: 'manual' } }
    else if (url.pathname === '/api/session-management/archives') json = { archives: [{ id: 'archive-1', name: 'Old experiment', createdAt: 1, windowCount: 1, paneCount: 1 }] }
    else if (url.pathname === '/api/git/summary') json = { isRepo: false }
    else if (url.pathname === '/api/prs/repo') json = { repo: null }
    else if (url.pathname === '/api/prs/pane') {
      const pullRequests = prsByPane[url.searchParams.get('paneId') ?? ''] ?? []
      json = { list: { targetId: 'target', totalCount: pullRequests.length, pullRequests, truncated: false, fetchedAt: Date.now() } }
    } else if (url.pathname === '/api/prs/prefs') json = { prefs: { version: 1, pinnedRepos: [], recentRepos: [], lastRepo: null, lastFilter: 'open', lastScope: 'mine' } }
    else if (url.pathname === '/api/prs/repos') json = { repos: [] }
    await route.fulfill({ json })
  })
  await page.goto(`http://127.0.0.1:${port}/#token=session-tree-minimal-fixture`)

  const tree = page.locator('.managed-session-tree')
  await expect(tree.getByRole('button', { name: 'Flag tidy ups', exact: true })).toBeVisible()
  // One indicator column per row; sessions without an agent keep an inert placeholder.
  await expect(tree.locator('.managed-session-row')).toHaveCount(fixture.length)
  await expect(tree.locator('.managed-session-row > .session-indicator')).toHaveCount(fixture.length)
  await expect(tree.locator('button.session-indicator')).toHaveCount(fixture.length - 1)
  const indicator = (session: string) => tree.locator('article', { has: page.getByRole('button', { name: session, exact: true }) }).locator('.session-indicator')
  await expect(indicator('Chat')).toHaveClass(/working/)
  await expect(indicator('New accounts in friends rail')).toHaveClass(/needs_input/)
  await expect(indicator('Belt Road improvements')).toHaveClass(/mark tone-red has-activity/)
  // Muted glyphs: no PR numbers, no window or pane counts.
  await expect(tree.getByLabel('PR #64 in chat providers: 2 unresolved comment threads')).toHaveClass(/tone-amber/)
  const flagPr = tree.getByLabel(/^PR #\d+ in Flag tidy ups: Merge conflicts; 2 more/)
  await expect(flagPr).toHaveClass(/tone-red/)
  await expect(flagPr).toHaveText('3')
  await expect(tree.getByRole('button', { name: 'Open attached IDE for Show triggered agents progress' })).toBeVisible()
  await expect(tree.getByRole('button', { name: 'Show leased simulator for New accounts in friends rail' })).toBeVisible()
  await expect(tree).not.toContainText('#')
  await expect(tree).not.toContainText('windows /')
  // Archived sits below the session groups.
  const archived = tree.getByRole('button', { name: /Archived/ })
  const lastRow = tree.getByRole('button', { name: 'LIVE_OPPONENT_CHALLENGE_OPEN', exact: true })
  expect((await archived.boundingBox())!.y).toBeGreaterThan((await lastRow.boundingBox())!.y)
  await page.screenshot({ path: testInfo.outputPath('session-tree-minimal.png'), clip: { x: 0, y: 0, width: 420, height: 1000 } })
  await tree.getByRole('button', { name: 'Collapse Commando' }).hover()
  await page.screenshot({ path: testInfo.outputPath('session-tree-minimal-hover.png'), clip: { x: 0, y: 220, width: 240, height: 340 } })

  // Selecting a session no longer expands PR cards or window rows.
  await tree.getByRole('button', { name: 'chat providers', exact: true }).click()
  await expect(tree.getByRole('button', { name: 'chat providers', exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(tree.getByRole('region', { name: /Open pull requests/ })).toHaveCount(0)
  await expect(tree.locator('.managed-session-row')).toHaveCount(fixture.length)
  expect(errors).toEqual([])
})

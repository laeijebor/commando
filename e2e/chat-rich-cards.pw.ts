import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { ChatState } from '../shared/agent-chat'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'

// Real cockpit and CSS; daemon traffic is fulfilled locally.
const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5295)
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

const cwd = '/tmp/chat-rich-cards-fixture'
const PR = 'https://github.com/acme/widgets/pull/12'
const ISSUE = 'https://linear.app/acme/issue/ENG-42/fix-the-login-loop'

test('PR, Linear and slides references in a reply become chips and cards', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
  await page.setViewportSize({ width: 1100, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const pane: TmuxPane = {
    id: '%12', targetId: '550e8400-e29b-41d4-a716-446655440012',
    index: 0, windowId: '@2', sessionId: '$3', title: 'chat-fixture', command: 'node', path: cwd,
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
  const now = Date.now()
  const base = { turnId: 't1', status: 'completed' as const, createdAt: now, updatedAt: now }
  const deck = { folder: `${cwd}/launch-deck`, manifest: 'deck.html', title: 'Launch plan', slides: 8, first: 'Why we are doing this' }
  const text = [
    `I opened ${PR} for the fix; it closes ${ISSUE}.`,
    '',
    'The stack:',
    '',
    `- ${PR.replace('12', '13')} — the API`,
    `- [UI changes](${PR.replace('12', '14')}/files) — the screens`,
    '',
    'The talk for Thursday:',
    '',
    '- `launch-deck` — review before the meeting',
  ].join('\n')
  const chat: ChatState = {
    paneId: pane.id, targetId: pane.targetId, hostConnected: true,
    session: { paneId: pane.id, provider: 'claude', cwd, status: 'idle', hostPid: 1, hostVersion: 1 },
    items: [
      { ...base, id: 'u1', kind: 'user_message', text: 'Where are we?' },
      {
        ...base, id: 'a1', kind: 'assistant_message', text,
        resources: [{ ref: 'launch-deck', path: `${cwd}/launch-deck`, kind: 'folder', entries: 5, mtimeMs: now, deck }],
      },
    ],
  }
  const summaries: Record<string, unknown> = {
    12: { title: 'fix: stop the login redirect loop', state: 'open', author: 'leo', branch: 'fix-login-loop' },
    13: { title: 'feat(api): session refresh endpoint', state: 'merged', author: 'ada', branch: 'session-refresh' },
    14: { title: 'feat(web): refresh sessions quietly', state: 'draft', author: 'leo', branch: 'quiet-refresh' },
  }
  // PR 12 was opened from this pane, so it has a side-panel tab for Quick Look.
  const isoNow = new Date(now).toISOString()
  const linked = { repo: 'acme/widgets', number: 12, title: 'fix: stop the login redirect loop', url: PR, state: 'open', isDraft: false, createdAt: isoNow, updatedAt: isoNow,
    additions: 40, deletions: 12, conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null,
    checks: { state: 'pass', total: 2, failed: 0, pending: 0, runs: [], truncated: false } }
  const requests: string[] = []
  const actions: unknown[] = []
  await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
    socket.send(JSON.stringify({ type: 'chat_snapshot', chats: [chat] }))
    socket.onMessage(() => {})
  })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    requests.push(`${path}${url.search}`)
    let json: unknown
    if (path === '/api/auth/bootstrap') json = { enabled: false, needsOwner: false, ownerEmail: null }
    else if (path === '/api/snapshot') json = snapshot
    else if (path === '/api/session-management/preferences') json = { preferences: { version: 1, groups: [], ungroupedSessionIds: ['$3'] } }
    else if (path === '/api/session-management/archives') json = { archives: [] }
    else if (path === '/api/git/summary') json = { isRepo: false }
    else if (path === '/api/prs/pane') json = { list: { targetId: pane.targetId, totalCount: 1, truncated: false, fetchedAt: Date.now(), pullRequests: [linked] } }
    else if (path === '/api/prs/details') json = { details: { body: 'Stops the redirect loop.', conversation: [], checks: [] } }
    else if (path === '/api/prs/summary') json = { summary: summaries[url.searchParams.get('number') ?? ''] }
    else if (path === '/api/linear/lookup') {
      json = { issue: { identifier: 'ENG-42', title: 'Login loops after the session expires', url: ISSUE, state: { name: 'In Progress', color: '#f2c94c', type: 'started' }, assignee: 'Ada Lovelace' } }
    } else if (path === '/api/pane-management/panes/%2512/resource') {
      const body = route.request().postDataJSON() as { action: string }
      actions.push(body)
      json = { ok: true, performed: body.action, ...(body.action === 'slides' ? { webPaneId: 'w-0123abcd' } : {}) }
    } else { await route.abort(); return }
    await route.fulfill({ json })
  })
  await page.goto(`${baseUrl}/#token=chat-rich-cards-fixture`)

  const chatPane = page.getByTestId('chat-pane')
  await expect(chatPane.getByText('The talk for Thursday:')).toBeVisible()

  // Inline PR chip: title and state from the daemon's cached summary.
  const intro = chatPane.locator('p').filter({ hasText: 'I opened' })
  const prChip = intro.getByRole('button', { name: /acme\/widgets#12/ })
  await expect(prChip).toContainText('fix: stop the login redirect loop')
  await expect(prChip).toContainText('Open')

  // Inline Linear chip: identifier, title, state; it is a link to the issue.
  const issueChip = intro.getByRole('link', { name: /ENG-42/ })
  await expect(issueChip).toContainText('Login loops after the session expires')
  await expect(issueChip).toContainText('In Progress')
  await expect(issueChip).toHaveAttribute('href', ISSUE)

  // Only a PR linked to this pane opens Quick Look; the others link to GitHub.
  // A list of PRs becomes cards with state, author and branch.
  const prCards = chatPane.getByRole('list').filter({ hasText: 'acme/widgets#13' })
  await expect(prCards.getByRole('listitem')).toHaveCount(2)
  await expect(prCards.getByRole('listitem').first()).toContainText('feat(api): session refresh endpoint')
  await expect(prCards.getByRole('listitem').first()).toContainText('Merged')
  await expect(prCards.getByRole('listitem').last()).toContainText('acme/widgets#14 · leo · quiet-refresh')
  await expect(prCards.getByRole('listitem').last()).toContainText('the screens')
  await expect(prCards.getByRole('link', { name: 'GitHub' }).first()).toHaveAttribute('href', PR.replace('12', '13'))

  // A lone deck list item becomes a slides card.
  const slides = chatPane.getByRole('listitem').filter({ hasText: 'Launch plan' })
  await expect(slides).toContainText('8 slides')
  await expect(slides).toContainText('Why we are doing this')

  await mkdir(join(testInfo.outputDir), { recursive: true })
  await chatPane.screenshot({ path: testInfo.outputPath('rich-cards.png') })
  if (process.env.COMMANDO_E2E_SCREENSHOT) await chatPane.screenshot({ path: process.env.COMMANDO_E2E_SCREENSHOT })

  // Present opens the deck as a slides tile through the resource endpoint.
  await slides.getByRole('button', { name: 'Present' }).click()
  await expect.poll(() => actions.at(-1)).toEqual({ path: `${cwd}/launch-deck`, action: 'slides' })

  // The PR chip opens its Quick Look tab in the side panel, which loads that PR.
  const before = requests.length
  await prChip.click()
  await expect(page.getByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => requests.slice(before).some((request) => request.startsWith('/api/prs?repo=acme%2Fwidgets'))).toBe(true)

  // No PR was summarised twice; the linked one may come from the pane's PR list instead.
  const summarised = requests.filter((request) => request.startsWith('/api/prs/summary'))
  expect(new Set(summarised).size).toBe(summarised.length)
  expect(summarised).toEqual(expect.arrayContaining(['/api/prs/summary?repo=acme%2Fwidgets&number=13', '/api/prs/summary?repo=acme%2Fwidgets&number=14']))
  expect(errors).toEqual([])
})

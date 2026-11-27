import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { ChatState } from '../shared/agent-chat'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'

// Real cockpit and CSS; daemon traffic is fulfilled locally.
const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5294)
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

const cwd = '/tmp/chat-resource-fixture'

test('paths in a reply become chips and cards that act on the file', async ({ page, context }, testInfo) => {
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
  const text = [
    'All 14 are in `screenshots/onboarding` and the sheet is [compare.html](./.redline/compare.html).',
    'The old export at [old.zip](~/Desktop/old.zip) is gone.',
    '',
    'Files I wrote:',
    '',
    '- `src/OnboardingCarousel.tsx:42` — the carousel, replacing `<TournamentCardPage title={copy.tournament.title} subtitle={copy.tournament.subtitle} />` with the new hero',
    '  - Changed post-game polling to poll every `300 ms` for the first 4 rounds, then back off to `2 s` until the results settle',
    '- `.pr/architecture.svg` — the diagram',
    '- `screenshots/onboarding` — 14 images',
    '',
    '```',
    `${cwd}/fenced/path.ts`,
    '```',
  ].join('\n')
  const chat: ChatState = {
    paneId: pane.id, targetId: pane.targetId, hostConnected: true,
    session: { paneId: pane.id, provider: 'claude', cwd, status: 'idle', hostPid: 1, hostVersion: 1 },
    items: [
      { ...base, id: 'u1', kind: 'user_message', text: 'Where did you save the screenshots?' },
      {
        ...base, id: 'a1', kind: 'assistant_message', text,
        resources: [
          { ref: 'screenshots/onboarding', path: `${cwd}/screenshots/onboarding`, kind: 'folder', entries: 14, mtimeMs: now },
          { ref: './.redline/compare.html', path: `${cwd}/.redline/compare.html`, kind: 'file', size: 2048, mtimeMs: now },
          { ref: '~/Desktop/old.zip', path: '/Users/me/Desktop/old.zip', missing: true },
          { ref: 'src/OnboardingCarousel.tsx:42', path: `${cwd}/src/OnboardingCarousel.tsx`, kind: 'file', size: 4096, mtimeMs: now - 120_000, line: 42 },
          { ref: '.pr/architecture.svg', path: `${cwd}/.pr/architecture.svg`, kind: 'file', size: 43_000, mtimeMs: now - 60_000 },
          { ref: `${cwd}/fenced/path.ts`, path: `${cwd}/fenced/path.ts`, kind: 'file', size: 10, mtimeMs: now },
        ],
      },
    ],
  }
  const actions: unknown[] = []
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
    else if (path === '/api/pane-management/panes/%2512/resource') {
      const body = route.request().postDataJSON() as { action: string }
      actions.push(body)
      json = { ok: true, performed: body.action, ...(body.action === 'tile' ? { webPaneId: 'w-fixture' } : {}) }
    } else { await route.abort(); return }
    await route.fulfill({ json })
  })
  await page.goto(`${baseUrl}/#token=chat-resource-fixture`)

  const chatPane = page.getByTestId('chat-pane')
  await expect(chatPane.getByText('Files I wrote:')).toBeVisible()

  // Inline chip: the folder opens in Finder.
  const intro = chatPane.locator('p').filter({ hasText: 'All 14 are in' })
  await intro.getByRole('button', { name: 'screenshots/onboarding' }).click()
  await expect.poll(() => actions.at(-1)).toEqual({ path: `${cwd}/screenshots/onboarding`, action: 'open' })

  // A linked HTML file opens as a tile.
  await intro.getByRole('button', { name: 'compare.html' }).click()
  await expect.poll(() => actions.at(-1)).toEqual({ path: `${cwd}/.redline/compare.html`, action: 'tile' })

  // A missing link is shown, struck through, and only copies its path.
  const before = actions.length
  await chatPane.getByRole('button', { name: 'old.zip' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('/Users/me/Desktop/old.zip')
  expect(actions.length).toBe(before)

  // A list where every item starts with a path becomes cards.
  const cards = chatPane.locator('.chat-resource-cards')
  await expect(cards.locator('.chat-resource-card')).toHaveCount(3)
  const carousel = cards.getByRole('listitem').filter({ hasText: 'OnboardingCarousel.tsx' })
  await expect(carousel).toContainText('the carousel')
  // A long note wraps in full: nothing is clipped, and the nested bullet shows.
  const note = carousel.locator('.chat-resource-description')
  await expect(note.getByRole('listitem')).toContainText('until the results settle')
  expect(await note.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await carousel.getByRole('button', { name: 'Open in editor' }).click()
  await expect.poll(() => actions.at(-1)).toEqual({ path: `${cwd}/src/OnboardingCarousel.tsx`, action: 'editor', line: 42 })

  // The menu offers the rest; Reveal in Finder goes to the daemon.
  await cards.getByRole('listitem').filter({ hasText: 'architecture.svg' }).getByRole('button', { name: 'Resource actions' }).click()
  await page.getByRole('menuitem', { name: 'Reveal in Finder' }).click()
  await expect.poll(() => actions.at(-1)).toEqual({ path: `${cwd}/.pr/architecture.svg`, action: 'reveal' })

  // Paths in a fenced block stay code.
  await expect(chatPane.locator('pre').getByText(`${cwd}/fenced/path.ts`)).toBeVisible()
  await expect(chatPane.locator('pre').getByRole('button')).toHaveCount(0)

  await expect(chatPane.getByRole('status')).toHaveCount(0)
  await chatPane.screenshot({ path: testInfo.outputPath('resource-cards.png') })
  expect(errors).toEqual([])
})

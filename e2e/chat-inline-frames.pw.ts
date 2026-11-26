import { readFileSync } from 'node:fs'
import { expect as baseExpect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { ChatReplyEmbed, ChatState } from '../shared/agent-chat'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'

// Real cockpit, CSS and sandboxed frames; daemon traffic and the artifact route are fulfilled locally.
const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5296)
const baseUrl = `http://127.0.0.1:${port}`
const screenshots = process.env.COMMANDO_E2E_SCREENSHOT_DIR
let vite: ViteDevServer
test.beforeAll(async () => {
  vite = await createServer({ server: {
    host: '127.0.0.1', port, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:9', '/ws': { target: 'ws://127.0.0.1:9', ws: true } },
  } })
  await vite.listen()
})
test.afterAll(async () => { await vite?.close() })

// Frames load in their own processes; give them time on a busy machine.
const expect = baseExpect.configure({ timeout: 20_000 })
const relayScript = readFileSync(new URL('../server/static/embed-frame.js', import.meta.url))
const fixture = (name: string) => readFileSync(new URL(`./fixtures/inline-frames/${name}`, import.meta.url))
const cwd = '/tmp/chat-inline-frames'
const htmlId = '0123456789abcdef'
const canvasId = 'fedcba9876543210'
const mockup: ChatReplyEmbed = {
  src: '.canvas/settings/Accounts.html', kind: 'html', path: `${cwd}/.canvas/settings/Accounts.html`,
  url: `/redline/artifacts/${htmlId}/settings/Accounts.html`,
}
const board: ChatReplyEmbed = {
  src: '.canvas/settings', kind: 'canvas', path: `${cwd}/.canvas/settings`, url: `/redline/artifacts/${canvasId}/`, title: 'Settings board', frames: [
    { id: 'list', title: 'Accounts · list', url: `/redline/artifacts/${canvasId}/Accounts.html`, w: 1280, h: 800 },
    { id: 'teal', title: 'Accounts · teal', url: `/redline/artifacts/${canvasId}/Teal.html`, w: 390, h: 844 },
    { id: 'narrow', title: 'Accounts · narrow', url: `/redline/artifacts/${canvasId}/Accounts.html`, w: 640, h: 900 },
  ],
}

async function openChat(page: Page) {
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
  const earlier = Array.from({ length: 6 }, (_, index) => `Step ${index + 1}: regrouped the settings and checked the accounts list again.`).join('\n\n')
  const text = [
    "Here's a first pass. Toggles and Connect work; tell me what to change.",
    '',
    '![Connected accounts](.canvas/settings/Accounts.html)',
    '',
    'I also laid out three variants on a board:',
    '',
    '![Settings board](.canvas/settings)',
  ].join('\n')
  const chat: ChatState = {
    paneId: pane.id, targetId: pane.targetId, hostConnected: true,
    session: { paneId: pane.id, provider: 'claude', cwd, status: 'idle', hostPid: 1, hostVersion: 1 },
    items: [
      { ...base, id: 'u0', kind: 'user_message', text: 'Regroup the settings screen.' },
      { ...base, id: 'a0', kind: 'assistant_message', text: earlier },
      { ...base, id: 'u1', kind: 'user_message', text: 'Can you mock up the connected-accounts screen?' },
      { ...base, id: 'a1', kind: 'assistant_message', text, embeds: [mockup, board] },
    ],
  }
  const actions: Record<string, unknown>[] = []
  await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
    socket.send(JSON.stringify({ type: 'chat_snapshot', chats: [chat] }))
    socket.onMessage(() => {})
  })
  // Like the daemon's artifact route: a page asked for with ?chat-embed=1 gets the real Esc relay.
  await page.route('**/redline/artifacts/**', async (route) => {
    const url = new URL(route.request().url())
    const html = fixture(url.pathname.split('/').at(-1)!).toString('utf8')
    const body = url.searchParams.get('chat-embed') === '1' ? html.replace(/<\/body>/i, '<script src="/redline/embed-frame.js"></script></body>') : html
    await route.fulfill({ body, contentType: 'text/html; charset=utf-8' })
  })
  await page.route('**/redline/embed-frame.js', (route) => route.fulfill({ body: relayScript, contentType: 'text/javascript; charset=utf-8' }))
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let json: unknown
    if (path === '/api/auth/bootstrap') json = { enabled: false, needsOwner: false, ownerEmail: null }
    else if (path === '/api/snapshot') json = snapshot
    else if (path === '/api/session-management/preferences') json = { preferences: { version: 1, groups: [], ungroupedSessionIds: ['$3'] } }
    else if (path === '/api/session-management/archives') json = { archives: [] }
    else if (path === '/api/git/summary') json = { isRepo: false }
    else if (path === '/api/pane-management/panes/%2512/resource') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      actions.push(body)
      json = { ok: true, performed: body.action, webPaneId: 'w-fixture' }
    } else { await route.abort(); return }
    await route.fulfill({ json })
  })
  await page.goto(`${baseUrl}/#token=chat-inline-frames`)
  return { actions }
}

test('inline mock-ups go live on click, maximise over the chat and move to a tile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const { actions } = await openChat(page)
  const chatPane = page.getByTestId('chat-pane')
  const timeline = page.getByTestId('chat-timeline')
  const block = chatPane.getByRole('figure', { name: 'Connected accounts' })
  await expect(block).toBeVisible()
  const frame = page.frameLocator('iframe[title="Connected accounts"]')
  await expect(frame.getByRole('heading', { name: 'Connected accounts' })).toBeVisible()
  await expect(block.getByText('Live')).toHaveCount(0)

  // Static: the wheel over the frame scrolls the chat, not the page inside.
  await block.scrollIntoViewIfNeeded()
  const box = (await block.boundingBox())!
  const before = await timeline.evaluate((node) => node.scrollTop)
  await page.mouse.move(box.x + box.width / 2, box.y + 120)
  await page.mouse.wheel(0, -300)
  await expect.poll(() => timeline.evaluate((node) => node.scrollTop)).toBeLessThan(before)
  const inner = page.frames().find((candidate) => candidate.url().includes('/settings/Accounts.html'))!
  expect(await inner.evaluate(() => window.scrollY)).toBe(0)
  const atLatest = async () => {
    await timeline.evaluate((node) => { node.scrollTop = node.scrollHeight })
    await expect(chatPane.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
  }
  const maximise = async () => {
    // Chromium routes a click by its compositor's hit-test data, which can still hold the frame's maximised rectangle
    // a few frames after a restore; a click then would land in the page. Layout itself is settled (no reflow on restore).
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.waitForTimeout(250)
    await block.getByRole('button', { name: 'Maximise' }).click()
    await expect(block).toHaveAttribute('data-maximised', '')
    await expect(block.getByRole('button', { name: 'Restore (Esc)' })).toBeFocused()
  }
  await atLatest()
  if (screenshots) await chatPane.screenshot({ path: `${screenshots}/chat-inline-frame.png` })

  // Click to interact, then use the page's own controls.
  await block.getByRole('button', { name: 'Interact with Connected accounts' }).click()
  await expect(block.getByText('Live')).toBeVisible()
  await frame.getByRole('button', { name: 'Sync Outlook' }).click()
  await expect(frame.getByText('2 of 3 syncing')).toBeVisible()
  await frame.getByRole('button', { name: 'Connect' }).click()
  await expect(frame.getByRole('button', { name: 'Connected' })).toBeVisible()
  await atLatest()
  if (screenshots) await chatPane.screenshot({ path: `${screenshots}/chat-inline-frame-live.png` })
  // Live, the wheel scrolls the page inside.
  const liveBox = (await block.boundingBox())!
  await page.mouse.move(liveBox.x + liveBox.width / 2, liveBox.y + 150)
  await page.mouse.wheel(0, 200)
  await expect.poll(() => inner.evaluate(() => window.scrollY)).toBeGreaterThan(0)

  // Maximise covers the chat pane, composer included, with the same live page.
  await maximise()
  const pane = (await chatPane.boundingBox())!
  await expect.poll(async () => {
    const shown = (await block.boundingBox())!
    return [shown.x, shown.y, shown.width, shown.height].map(Math.round)
  }).toEqual([pane.x, pane.y, pane.width, pane.height].map(Math.round))
  const composer = (await chatPane.locator('textarea[data-chat-composer]').boundingBox())!
  expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('.chat-embed')), [composer.x + 10, composer.y + 10])).toBe(true)
  await expect(frame.getByText('2 of 3 syncing')).toBeVisible()
  await expect(block.getByText('maximised in chat')).toBeVisible()
  if (screenshots) await chatPane.screenshot({ path: `${screenshots}/chat-inline-frame-maximised.png` })
  await page.keyboard.press('Escape')
  await expect(block).not.toHaveAttribute('data-maximised', '')
  await expect(block.getByRole('button', { name: 'Maximise' })).toBeFocused()

  // Esc typed inside the maximised page reaches Commando through the relay.
  await maximise()
  await frame.getByRole('heading', { name: 'Connected accounts' }).click()
  await expect(block.getByRole('button', { name: 'Restore (Esc)' })).not.toBeFocused()
  await page.keyboard.press('Escape')
  await expect(block).not.toHaveAttribute('data-maximised', '')
  await expect(frame.getByText('2 of 3 syncing')).toBeVisible()

  // Review opens a chromium tile; Move to tile the phase-1 resource tile.
  await maximise()
  await block.getByRole('button', { name: 'Review in a tile' }).click()
  await expect.poll(() => actions.at(-1)).toEqual({ path: mockup.path, action: 'tile', engine: 'chromium' })
  await expect(block).not.toHaveAttribute('data-maximised', '')
  await maximise()
  await block.getByRole('button', { name: 'Move to tile' }).click()
  await expect.poll(() => actions.at(-1)).toEqual({ path: mockup.path, action: 'tile' })
  await expect(block).not.toHaveAttribute('data-maximised', '')

  await chatPane.screenshot({ path: testInfo.outputPath('inline-frame.png') })
  expect(errors).toEqual([])
})

test('a canvas board shows a frame strip, maximises a frame with tabs, and moves to a canvas tile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const { actions } = await openChat(page)
  const chatPane = page.getByTestId('chat-pane')
  const block = chatPane.getByRole('figure', { name: 'Settings board' })
  await block.scrollIntoViewIfNeeded()
  await expect(block).toContainText('Settings board · 3 frames')
  await expect(block.getByRole('button', { name: /^Open frame \d/ })).toHaveCount(3)
  const thumbnail = page.frameLocator('iframe[title="Preview: Accounts · teal"]')
  await expect(thumbnail.getByText('Reconnect')).toBeVisible()
  // Thumbnails are scaled-down previews, never interactive.
  const preview = block.locator('iframe[title="Preview: Accounts · teal"]')
  expect(await preview.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none')
  expect((await preview.boundingBox())!.height).toBeLessThanOrEqual(141)
  if (screenshots) await block.screenshot({ path: `${screenshots}/chat-canvas-strip.png` })

  await block.getByRole('button', { name: 'Open frame 2: Accounts · teal' }).click()
  await expect(block).toHaveAttribute('data-maximised', '')
  const tabs = block.getByRole('tablist', { name: 'Settings board frames' })
  await expect(tabs.getByRole('tab', { selected: true })).toContainText('Accounts · teal')
  await expect(page.frameLocator('iframe[title="Accounts · teal"]').getByText('Reconnect')).toBeVisible()
  if (screenshots) await chatPane.screenshot({ path: `${screenshots}/chat-canvas-maximised.png` })
  await page.frameLocator('iframe[title="Accounts · teal"]').getByText('Reconnect').click()
  await page.keyboard.press('Escape')
  await expect(block).not.toHaveAttribute('data-maximised', '')
  await block.getByRole('button', { name: 'Open frame 2: Accounts · teal' }).click()
  await expect(block).toHaveAttribute('data-maximised', '')
  await tabs.getByRole('tab', { name: /Accounts · list/ }).click()
  await expect(page.frameLocator('iframe[title="Accounts · list"]').getByRole('heading', { name: 'Connected accounts' })).toBeVisible()

  await block.getByRole('button', { name: 'Move to tile' }).click()
  await expect.poll(() => actions.at(-1)).toEqual({ path: board.path, action: 'tile' })
  await expect(block).not.toHaveAttribute('data-maximised', '')
  await block.screenshot({ path: testInfo.outputPath('canvas-strip.png') })
  expect(errors).toEqual([])
})

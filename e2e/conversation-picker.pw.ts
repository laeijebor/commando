import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { ChatState } from '../shared/agent-chat'
import type { ChatConversation } from '../shared/chat-conversations'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'

// Real cockpit and CSS; daemon traffic is fulfilled locally.
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

const basePane: TmuxPane = {
  id: '%12', targetId: '550e8400-e29b-41d4-a716-446655440012',
  index: 0, windowId: '@2', sessionId: '$3', title: 'chat-fixture', command: 'node', path: '/tmp/picker-fixture',
  active: true, dead: false, width: 90, height: 40, cursorX: 0, cursorY: 0,
  alternateSavedX: 0, alternateSavedY: 0, alternateOn: false, cursorVisible: true,
  cursorShape: 'block', cursorBlinking: false, scrollRegionUpper: 0, scrollRegionLower: 39,
  wrapFlag: true, originFlag: false, insertFlag: false, keypadFlag: false,
  keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
}

test('the ⌘P picker covers only its chat pane and closes when another pane is clicked', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const chatPane = basePane
  const otherPane: TmuxPane = { ...basePane, id: '%13', targetId: '550e8400-e29b-41d4-a716-446655440013', index: 1, title: 'shell', command: 'zsh', active: false }
  const snapshot: CommandoSnapshot = {
    revision: 1, capturedAt: Date.now(), ports: [], panes: [chatPane, otherPane],
    sessions: [{ id: '$3', name: 'picker-fixture', attached: true, activeWindowId: '@2', windowIds: ['@2'] }],
    windows: [{ id: '@2', index: 0, sessionId: '$3', name: 'picker-fixture', active: true, layout: 'aaaa,181x40,0,0{90x40,0,0,12,90x40,91,0,13}', paneIds: ['%12', '%13'] }],
  }
  const chat: ChatState = {
    paneId: chatPane.id, targetId: chatPane.targetId, items: [], hostConnected: true,
    session: { paneId: chatPane.id, provider: 'claude', cwd: chatPane.path, status: 'idle', hostPid: 1, hostVersion: 1 },
  }
  const conversations: ChatConversation[] = [
    { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111', title: 'Fix the flaky merge test', cwd: chatPane.path, updatedAt: Date.now() - 60_000 },
    { provider: 'codex', sessionId: '22222222-2222-4222-8222-222222222222', title: 'Tidy the PR strip', cwd: '/tmp/elsewhere', updatedAt: Date.now() - 3_600_000 },
  ]
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
    else if (path === '/api/chat-conversations') json = { conversations }
    else { await route.abort(); return }
    await route.fulfill({ json })
  })
  await page.goto(`${baseUrl}/#token=conversation-picker-fixture`)

  const chatArticle = page.locator('[data-pane-id="%12"]')
  const otherArticle = page.locator('[data-pane-id="%13"]')
  await expect(chatArticle).toBeVisible()
  await expect(otherArticle).toBeVisible()
  await chatArticle.getByRole('textbox').first().click()
  await page.keyboard.press('Meta+p')

  const picker = page.getByRole('dialog', { name: 'Conversations' })
  await expect(picker.getByText('Fix the flaky merge test')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Search conversations' })).toBeFocused()
  // It sits inside the chat pane; the neighbouring pane stays uncovered.
  await expect(chatArticle.getByRole('dialog', { name: 'Conversations' })).toBeVisible()
  const backdrop = await chatArticle.locator('.conversation-picker-backdrop').boundingBox()
  const chatBox = await chatArticle.boundingBox()
  const otherBox = await otherArticle.boundingBox()
  expect(backdrop && chatBox && otherBox).toBeTruthy()
  expect(backdrop!.x + backdrop!.width).toBeLessThanOrEqual(chatBox!.x + chatBox!.width + 1)
  expect(backdrop!.x + backdrop!.width).toBeLessThanOrEqual(otherBox!.x + 1)
  const atOther = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-pane-id]')?.getAttribute('data-pane-id'), { x: otherBox!.x + otherBox!.width / 2, y: otherBox!.y + otherBox!.height / 2 })
  expect(atOther).toBe('%13')
  await page.screenshot({ path: testInfo.outputPath('picker-in-pane.png') })

  // Clicking inside the picker keeps it open; clicking the other pane closes it.
  await page.getByRole('textbox', { name: 'Search conversations' }).click()
  await expect(picker).toBeVisible()
  await otherArticle.click({ position: { x: otherBox!.width / 2, y: otherBox!.height / 2 } })
  await expect(picker).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('picker-closed.png') })
  expect(errors).toEqual([])
})

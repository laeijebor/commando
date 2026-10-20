import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { ChatState } from '../shared/agent-chat'
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

test('selecting chat text copies it to the clipboard', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const pane: TmuxPane = {
    id: '%12', targetId: '550e8400-e29b-41d4-a716-446655440012',
    index: 0, windowId: '@2', sessionId: '$3', title: 'chat-fixture', command: 'node', path: '/tmp/chat-select-fixture',
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
  const chat: ChatState = {
    paneId: pane.id, targetId: pane.targetId, hostConnected: true,
    session: { paneId: pane.id, provider: 'claude', cwd: pane.path, status: 'idle', hostPid: 1, hostVersion: 1 },
    items: [
      { ...base, id: 'u1', kind: 'user_message', text: 'Where does the daemon listen?' },
      { ...base, id: 'a1', kind: 'assistant_message', text: 'The daemon listens on port 4310 by default.' },
    ],
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
    else { await route.abort(); return }
    await route.fulfill({ json })
  })
  await page.goto(`${baseUrl}/#token=chat-select-fixture`)

  const chatPane = page.getByTestId('chat-pane')
  const answer = chatPane.getByText('The daemon listens on port 4310 by default.')
  await expect(answer).toBeVisible()
  const box = (await answer.boundingBox())!
  await page.mouse.move(box.x + 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('daemon listens on port 4310')
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('daemon listens on port 4310')
  await page.screenshot({ path: testInfo.outputPath('selected.png') })

  // Clicking without dragging still hands the caret to the composer.
  await answer.click()
  await expect(chatPane.locator('textarea[data-chat-composer]')).toBeFocused()

  // Your own messages copy too; a double-click takes a word.
  const question = chatPane.getByText('Where does the daemon listen?')
  const questionBox = (await question.boundingBox())!
  await page.mouse.dblclick(questionBox.x + questionBox.width * 0.55, questionBox.y + questionBox.height / 2)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('daemon')

  // Selecting draft text in the composer leaves the clipboard alone.
  const composer = chatPane.locator('textarea[data-chat-composer]')
  await composer.fill('draft words here')
  await composer.dblclick()
  await expect(composer).toBeFocused()
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('daemon')
  expect(errors).toEqual([])
})

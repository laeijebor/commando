import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { ChatState } from '../shared/agent-chat'
import type { ChatMcpServer } from '../shared/chat-mcp'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'

// Real cockpit and CSS; daemon traffic, including the agent's MCP answers, is fulfilled locally.
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

const pane: TmuxPane = {
  id: '%12', targetId: '550e8400-e29b-41d4-a716-446655440012',
  index: 0, windowId: '@2', sessionId: '$3', title: 'chat-fixture', command: 'node', path: '/tmp/mcp-fixture',
  active: true, dead: false, width: 120, height: 40, cursorX: 0, cursorY: 0,
  alternateSavedX: 0, alternateSavedY: 0, alternateOn: false, cursorVisible: true,
  cursorShape: 'block', cursorBlinking: false, scrollRegionUpper: 0, scrollRegionLower: 39,
  wrapFlag: true, originFlag: false, insertFlag: false, keypadFlag: false,
  keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
}

test('⌘P opens the pane palette, whose MCP screen lists and manages the agent\'s servers', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const snapshot: CommandoSnapshot = {
    revision: 1, capturedAt: Date.now(), ports: [], panes: [pane],
    sessions: [{ id: '$3', name: 'mcp-fixture', attached: true, activeWindowId: '@2', windowIds: ['@2'] }],
    windows: [{ id: '@2', index: 0, sessionId: '$3', name: 'mcp-fixture', active: true, layout: 'aaaa,120x40,0,0,12', paneIds: ['%12'] }],
  }
  const chat: ChatState = {
    paneId: pane.id, targetId: pane.targetId, items: [], hostConnected: true,
    session: { paneId: pane.id, provider: 'claude', cwd: pane.path, status: 'idle', hostPid: 1, hostVersion: 6 },
  }
  const servers: ChatMcpServer[] = [
    { name: 'linear', status: 'needs-auth', scope: 'user', transport: 'http', target: 'https://mcp.linear.app/mcp', tools: [] },
    { name: 'github', status: 'connected', scope: 'project', transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-github', serverInfo: 'github-mcp 1.4.0', tools: [
      { name: 'create_issue', description: 'Open an issue in a repository' },
      { name: 'search_code', description: 'Search code across GitHub', readOnly: true },
      { name: 'delete_branch', description: 'Delete a branch', destructive: true },
    ] },
    { name: 'puppeteer', status: 'failed', scope: 'local', transport: 'stdio', target: 'node ./puppeteer-mcp.js', error: 'spawn node ENOENT', tools: [] },
  ]
  const actions: string[] = []
  await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
    socket.send(JSON.stringify({ type: 'chat_snapshot', chats: [chat] }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; requestId: string; request?: { action: string; server?: string } }
      if (message.type !== 'chat_mcp' || !message.request) return
      const { action, server } = message.request
      const target = servers.find((entry) => entry.name === server)
      let authUrl: string | undefined
      if (action !== 'status') actions.push(`${action}:${server}`)
      if (target && action === 'disable') target.status = 'disabled'
      if (target && action === 'enable') target.status = 'connected'
      if (target && action === 'authenticate') {
        authUrl = 'https://example.com/oauth/authorize?client_id=commando'
        // The agent finishes the sign-in in the background; the next status read shows it.
        setTimeout(() => { target.status = 'connected'; target.tools = [{ name: 'list_issues', readOnly: true }] }, 200)
      }
      socket.send(JSON.stringify({ type: 'chat_mcp_result', paneId: pane.id, requestId: message.requestId, servers, ...(authUrl ? { authUrl } : {}) }))
    })
  })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let json: unknown
    if (path === '/api/auth/bootstrap') json = { enabled: false, needsOwner: false, ownerEmail: null }
    else if (path === '/api/snapshot') json = snapshot
    else if (path === '/api/session-management/preferences') json = { preferences: { version: 1, groups: [], ungroupedSessionIds: ['$3'] } }
    else if (path === '/api/session-management/archives') json = { archives: [] }
    else if (path === '/api/git/summary') json = { isRepo: false }
    else if (path === '/api/chat-conversations') json = { conversations: [] }
    else { await route.abort(); return }
    await route.fulfill({ json })
  })
  await page.context().route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Sign in</p>' }))
  await page.goto(`${baseUrl}/#token=pane-palette-fixture`)

  const chatArticle = page.locator('[data-pane-id="%12"]')
  await expect(chatArticle).toBeVisible()
  await chatArticle.getByRole('textbox').first().click()
  await page.keyboard.press('Meta+p')

  const menu = chatArticle.getByRole('dialog', { name: 'Pane palette' })
  await expect(menu.getByRole('option', { name: /Resume conversation/ })).toBeVisible()
  await expect(menu.getByRole('option', { name: /MCP servers/ })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('palette-menu.png') })

  // Typing filters the menu; Enter opens the match.
  await page.keyboard.type('mcp')
  await expect(menu.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  const mcp = chatArticle.getByRole('dialog', { name: 'MCP servers' })
  await expect(mcp.getByRole('group', { name: 'User' }).getByText('linear', { exact: true })).toBeVisible()
  await expect(mcp.getByRole('group', { name: 'Project' }).getByText('github', { exact: true })).toBeVisible()
  await expect(mcp.getByText('spawn node ENOENT')).toBeVisible()
  await expect(mcp.getByText('1 needs authentication · 1 connected · 1 failed')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('mcp-list.png') })

  // A server's details show its tools; D disables it.
  await mcp.getByRole('option', { name: /github/ }).click()
  await expect(mcp.getByText('npx -y @modelcontextprotocol/server-github')).toBeVisible()
  await expect(mcp.getByText('delete_branch')).toBeVisible()
  await expect(mcp.getByText('destructive')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('mcp-detail.png') })
  await page.keyboard.press('d')
  await expect(mcp.getByRole('button', { name: /Enable/ })).toBeVisible()
  expect(actions).toContain('disable:github')

  // Escape steps back to the list; Authenticate opens the sign-in page and the list catches up.
  await page.keyboard.press('Escape')
  await mcp.getByRole('option', { name: /linear/ }).click()
  const popup = page.waitForEvent('popup')
  await mcp.getByRole('button', { name: /^Authenticate/ }).click()
  const signInPage = await popup
  await expect.poll(() => signInPage.url()).toContain('https://example.com/oauth/authorize')
  await signInPage.close()
  await expect(mcp.getByText('Connected', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(mcp.getByText('list_issues')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('mcp-authenticated.png') })

  // Back from the list returns to the menu; ⌘P from there resumes conversations.
  await page.keyboard.press('Escape')
  await page.getByRole('textbox', { name: 'Filter MCP servers' }).press('Backspace')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Meta+p')
  await expect(chatArticle.getByRole('dialog', { name: 'Conversations' })).toBeVisible()
  expect(errors).toEqual([])
})

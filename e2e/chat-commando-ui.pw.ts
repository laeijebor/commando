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

const cwd = '/tmp/chat-ui-fixture'

test('commando-ui blocks render, send a choice as a chat message and settle', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 1100 })
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
  const fence = (value: unknown) => '```commando-ui\n' + JSON.stringify(value, null, 2) + '\n```'
  const text = [
    'Two things before I continue.',
    '',
    fence({ component: 'stats', items: [
      { label: 'Tests', value: 1204, delta: '+18', tone: 'good' },
      { label: 'Bundle', value: '412 kB', delta: '+6 kB', tone: 'bad' },
      { label: 'Coverage', value: '81%' },
    ] }),
    fence({ component: 'table', columns: ['Package', 'Before', 'After'], rows: [['react', '18.3', '19.1'], ['vite', '5.4', '6.0']] }),
    fence({ component: 'checklist', title: 'Rollout', items: [{ label: 'Build passes', done: true }, { label: 'Staging deploy', done: true }, { label: 'Production deploy' }] }),
    fence({ component: 'approve', prompt: 'Ship the migration' }),
    fence({ component: 'choice', id: 'archive-storage', prompt: 'Archive storage',
      options: ['SQLite in ~/.commando (recommended)', 'JSONL per session', 'Keep both for one release'] }),
  ].join('\n\n')
  const chat: ChatState = {
    paneId: pane.id, targetId: pane.targetId, hostConnected: true,
    session: { paneId: pane.id, provider: 'claude', cwd, status: 'idle', hostPid: 1, hostVersion: 1 },
    items: [
      { ...base, id: 'u1', kind: 'user_message', text: 'Plan the archive work' },
      { ...base, id: 'a1', kind: 'assistant_message', text },
    ],
  }
  const sent: { type: string; text?: string }[] = []
  let send: (message: unknown) => void = () => {}
  let current = chat
  await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
    send = (message) => socket.send(JSON.stringify(message))
    socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
    socket.send(JSON.stringify({ type: 'chat_snapshot', chats: [current] }))
    socket.onMessage((data) => { try { sent.push(JSON.parse(String(data))) } catch { /* not JSON */ } })
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
  await page.goto(`${baseUrl}/#token=chat-ui-fixture`)

  const chatPane = page.getByTestId('chat-pane')
  await expect(chatPane.getByText('Two things before I continue.')).toBeVisible()
  const blocks = chatPane.getByTestId('commando-ui')
  await expect(blocks).toHaveCount(5)
  await expect(chatPane.getByText('Coverage')).toBeVisible()
  await expect(chatPane.getByRole('columnheader', { name: 'After' })).toBeVisible()
  await expect(chatPane.getByText('Rollout')).toBeVisible()
  await expect(chatPane.getByRole('button', { name: 'Approve' })).toBeEnabled()

  await chatPane.getByRole('button', { name: 'JSONL per session' }).click()
  await expect.poll(() => sent.find((message) => message.type === 'chat_send')?.text).toBe('Archive storage: JSONL per session')
  const settled = chatPane.getByTestId('commando-ui-settled')
  await expect(settled).toHaveText(/Sent · JSONL per session/)
  await expect(chatPane.getByRole('button', { name: 'Keep both for one release' })).toBeDisabled()

  // The user message the daemon echoes back keeps the block settled, and a reload derives the same state.
  const later = Date.now() + 1000
  current = { ...chat, items: [...chat.items,
    { ...base, id: 'u2', kind: 'user_message', text: 'Archive storage: JSONL per session', createdAt: later, updatedAt: later }] }
  send({ type: 'chat_snapshot', chats: [current] })
  await expect(settled).toHaveText(/Sent · JSONL per session/)
  await chatPane.getByTestId('commando-ui').first().scrollIntoViewIfNeeded()
  await page.reload()
  await expect(chatPane.getByTestId('commando-ui-settled')).toHaveText(/Sent · JSONL per session/)

  await chatPane.screenshot({ path: testInfo.outputPath('commando-ui.png') })
  await chatPane.screenshot({ path: '.pr-diagram/commando-ui.png' })
  expect(errors).toEqual([])
})

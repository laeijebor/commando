import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { ChatState } from '../shared/agent-chat'
import type { CommandoSnapshot, SessionBrief, TmuxPane } from '../shared/protocol'

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

test('pins open asks above the composer, answers one with a tap and drops it once closed', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const pane: TmuxPane = {
    id: '%12', targetId: '550e8400-e29b-41d4-a716-446655440014',
    index: 0, windowId: '@2', sessionId: '$3', title: 'asks-fixture', command: 'node', path: '/tmp/chat-asks-fixture',
    active: true, dead: false, width: 80, height: 24, cursorX: 0, cursorY: 0,
    alternateSavedX: 0, alternateSavedY: 0, alternateOn: false, cursorVisible: true,
    cursorShape: 'block', cursorBlinking: false, scrollRegionUpper: 0, scrollRegionLower: 23,
    wrapFlag: true, originFlag: false, insertFlag: false, keypadFlag: false,
    keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
  }
  const snapshot: CommandoSnapshot = {
    revision: 1, capturedAt: Date.now(), ports: [], panes: [pane],
    sessions: [{ id: '$3', name: 'asks-fixture', attached: true, activeWindowId: '@2', windowIds: ['@2'] }],
    windows: [{ id: '@2', index: 0, sessionId: '$3', name: 'asks-fixture', active: true, layout: 'dbde,80x24,0,0,12', paneIds: ['%12'] }],
  }
  const now = Date.now()
  const at = (minutesAgo: number) => now - minutesAgo * 60_000
  const filler = Array.from({ length: 8 }, (_, index) => ({
    id: `later-${index}`, kind: 'assistant_message' as const, turnId: `t${index + 2}`, status: 'completed' as const,
    text: `Later turn ${index + 1}: checked the watcher and CI again; nothing new to report.\n\n${'More detail. '.repeat(30)}`,
    createdAt: at(10 - index), updatedAt: at(10 - index),
  }))
  const chat: ChatState = {
    paneId: pane.id, targetId: pane.targetId, hostConnected: true,
    session: { paneId: pane.id, provider: 'claude', cwd: pane.path, status: 'idle', hostPid: 1, hostVersion: 1 },
    items: [
      { id: 'u1', kind: 'user_message', turnId: 't1', status: 'completed', text: 'Work through the review comments on #31226 and #31225', createdAt: at(20), updatedAt: at(20) },
      { id: 'a1', kind: 'assistant_message', turnId: 't1', status: 'completed', createdAt: at(14), updatedAt: at(14),
        text: 'The two remaining #31226 comments are one-line nits. I can push them as a round 4, or leave them. #31225 asks for mocked driver tests, which I think widen the scope.' },
      ...filler,
    ],
  }
  const brief: SessionBrief = {
    paneId: pane.id, targetId: pane.targetId, sessionId: '$3', sessionName: 'asks-fixture', state: 'done',
    headline: 'Round 3 done', headlineSource: 'agent', updates: [], updatedAt: now,
    asks: [
      { key: 'push-31226', question: 'Push the two small #31226 fixes as an extra round?', context: 'Both are one-line CodeRabbit nits (rename a variable, tighten a null check). Round 3 of 5 has been used.',
        why: 'Pushing costs one more review loop (~10 min). Leaving them means the nits stay open on the PR; neither affects behaviour.',
        options: ['Push as round 4', 'Leave them'], recommend: 0, askedAt: at(15) },
      { key: 'decline-31225', question: 'Resolve the #31225 request for mocked driver tests as declined?', context: 'Declining keeps the PR to its scope; I would reply with the reasoning.',
        options: ['Decline', 'Add the tests'], recommend: 0, link: 'https://github.com/acme/widgets/pull/31225', askedAt: at(15) },
    ],
  }
  const sent: Array<Record<string, unknown>> = []
  let open = brief.asks!
  await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
    socket.send(JSON.stringify({ type: 'chat_snapshot', chats: [chat] }))
    socket.send(JSON.stringify({ type: 'session_brief_snapshot', briefs: [brief] }))
    socket.onMessage((data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>
      if (message.type !== 'chat_send') return
      sent.push(message)
      // The daemon closes the ask once the host takes the answer.
      open = open.filter((ask) => ask.key !== message.answersAsk)
      socket.send(JSON.stringify({ type: 'session_brief', brief: { ...brief, asks: open } }))
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
    else { await route.abort(); return }
    await route.fulfill({ json })
  })
  await page.goto(`${baseUrl}/#token=chat-asks-fixture`)

  const tray = page.getByTestId('ask-tray')
  const head = tray.getByRole('button', { name: /^Waiting on you/ })
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await expect(head).toContainText('2')
  await expect(head).toContainText('Push the two small #31226 fixes')
  await page.screenshot({ path: testInfo.outputPath('1-collapsed.png') })

  await head.click()
  await expect(tray.getByRole('heading', { name: 'Resolve the #31225 request for mocked driver tests as declined?' })).toBeVisible()
  await tray.getByRole('button', { name: 'Why it matters' }).click()
  await expect(tray.getByText('Pushing costs one more review loop')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('2-open.png') })

  // The reply where the agent asked has scrolled away; the tray jumps back to it.
  const marker = page.getByRole('button', { name: 'Asked you 2 things: see Waiting on you' })
  await expect(marker).not.toBeInViewport()
  await tray.getByRole('button', { name: /Jump to where I asked/ }).first().click()
  await expect(marker).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('3-jumped.png') })

  await tray.getByRole('button', { name: 'Push as round 4 (recommended)' }).click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toMatchObject({ paneId: pane.id, text: 'Re: Push the two small #31226 fixes as an extra round? → Push as round 4', answersAsk: 'push-31226' })
  await expect(tray.getByRole('heading', { name: 'Push the two small #31226 fixes as an extra round?' })).toHaveCount(0)
  await expect(head).toContainText('1')
  await expect(page.getByRole('button', { name: 'Asked you 1 thing: see Waiting on you' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('4-answered.png') })

  await tray.getByRole('button', { name: 'Decline (recommended)' }).click()
  await expect(tray).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Asked you/ })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('5-all-answered.png') })
  expect(errors).toEqual([])
})

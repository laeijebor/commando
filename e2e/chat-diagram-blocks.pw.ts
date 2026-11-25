import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import type { ChatState } from '../shared/agent-chat'
import { prDiagramHash } from '../shared/pr-diagram'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol'

// Real cockpit, CSS and Mermaid; daemon traffic and stored images are fulfilled locally.
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

const cwd = '/tmp/chat-diagram-fixture'
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const architectureId = `${'a'.repeat(64)}.svg`
const pipelineId = `${'b'.repeat(64)}.svg`

test('diagrams in a reply get a block with expand, source and copy', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
  await page.setViewportSize({ width: 1100, height: 1400 })
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
  const mermaid = 'sequenceDiagram\n  Agent->>Daemon: reply with a fence\n  Daemon-->>Chat: rendered SVG'
  const pipeline = fixture('pr-diagram-pipeline.json').trim()
  const text = [
    "Here's how the pieces fit:",
    '',
    '![Architecture](.pr/architecture.svg)',
    '',
    'The message flow:',
    '',
    '```mermaid', mermaid, '```',
    '',
    'And the release pipeline:',
    '',
    '```pr-diagram', pipeline, '```',
  ].join('\n')
  const chat: ChatState = {
    paneId: pane.id, targetId: pane.targetId, hostConnected: true,
    session: { paneId: pane.id, provider: 'claude', cwd, status: 'idle', hostPid: 1, hostVersion: 1 },
    items: [
      { ...base, id: 'u1', kind: 'user_message', text: 'How does this fit together?' },
      {
        ...base, id: 'a1', kind: 'assistant_message', text,
        images: [{ src: '.pr/architecture.svg', id: architectureId, path: `${cwd}/.pr/architecture.svg` }],
        diagrams: [{ hash: prDiagramHash(pipeline), id: pipelineId }],
      },
    ],
  }
  const actions: unknown[] = []
  await page.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
    socket.send(JSON.stringify({ type: 'chat_snapshot', chats: [chat] }))
    socket.onMessage(() => {})
  })
  await page.route('**/chat-images/**', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)
    const body = id === architectureId ? fixture('diagram-architecture.svg') : id === pipelineId ? fixture('pr-diagram-pipeline.svg') : null
    if (body) await route.fulfill({ body, contentType: 'image/svg+xml' })
    else await route.abort()
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
  await page.goto(`${baseUrl}/#token=chat-diagram-fixture`)

  const chatPane = page.getByTestId('chat-pane')
  await expect(chatPane.getByText('The message flow:')).toBeVisible()

  // The SVG reply image: caption with title and file name, file tools, and Expand.
  const architecture = chatPane.getByRole('figure', { name: 'Architecture' })
  await expect(architecture).toContainText('Architecture · architecture.svg')
  await expect(architecture.getByRole('img', { name: 'Architecture' })).toHaveJSProperty('complete', true)
  await architecture.getByRole('button', { name: 'Reveal in Finder' }).click()
  await expect.poll(() => actions.at(-1)).toEqual({ path: `${cwd}/.pr/architecture.svg`, action: 'reveal' })
  await architecture.hover()
  await architecture.getByRole('button', { name: 'Open as tile' }).click()
  await expect.poll(() => actions.at(-1)).toEqual({ path: `${cwd}/.pr/architecture.svg`, action: 'tile' })
  await architecture.getByRole('button', { name: 'Expand' }).click()
  const viewer = page.getByRole('dialog', { name: 'Architecture' })
  await expect(viewer.getByRole('img', { name: 'Architecture' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()

  // Mermaid: drawn in the theme, Source shows the text, and Copy copies what is shown.
  const sequence = chatPane.getByRole('figure', { name: 'Sequence diagram' })
  await expect(sequence.getByRole('img', { name: 'Mermaid diagram' }).locator('svg')).toBeVisible()
  await sequence.getByRole('button', { name: 'Show source' }).click()
  await expect(sequence.locator('pre')).toContainText('Agent->>Daemon: reply with a fence')
  await sequence.hover()
  await sequence.getByRole('button', { name: 'Copy source' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(mermaid)
  await expect(sequence.getByRole('status')).toHaveText('Copied source')
  await sequence.getByRole('button', { name: 'Show diagram' }).click()
  await sequence.hover()
  await sequence.getByRole('button', { name: 'Expand' }).click()
  const mermaidViewer = page.getByRole('dialog', { name: 'Sequence diagram' })
  await expect(mermaidViewer.getByRole('img', { name: 'Sequence diagram' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(mermaidViewer).toBeHidden()

  // The pr-diagram fence: the daemon's SVG, copied to the clipboard as a PNG.
  const release = chatPane.getByRole('figure', { name: 'Mobile JS ships from next without a build' })
  await expect(release).toContainText('pr-diagram pipeline')
  await expect(release.getByRole('img')).toHaveAttribute('src', `/chat-images/${pipelineId}`)
  await release.scrollIntoViewIfNeeded()
  await release.hover()
  await release.getByRole('button', { name: 'Copy image' }).click()
  await expect(release.getByRole('status')).toHaveText('Copied image')
  const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => item.types))
  expect(types).toContain('image/png')
  await release.getByRole('button', { name: 'Show source' }).click()
  await expect(release.locator('pre')).toContainText('"type": "pipeline"')
  await release.getByRole('button', { name: 'Show diagram' }).click()

  await chatPane.screenshot({ path: testInfo.outputPath('diagram-blocks.png') })
  if (process.env.COMMANDO_E2E_SCREENSHOT_DIR) await chatPane.screenshot({ path: `${process.env.COMMANDO_E2E_SCREENSHOT_DIR}/chat-diagram-blocks.png` })
  expect(errors).toEqual([])
})

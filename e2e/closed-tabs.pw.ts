import { expect, test } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandoSnapshot } from '../shared/protocol'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

// Ports and socket can be pinned for a manual run; defaults keep parallel runs apart.
test('closed tabs survive close, prune, pause → restore and daemon restart, and reopen beside the pane', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1800, height: 1000 })
  const socket = process.env.E2E_TMUX_SOCKET ?? `commando-closed-tabs-${process.pid}`
  const home = await realpath(await mkdtemp(join(tmpdir(), 'commando-closed-tabs-e2e-')))
  const daemonPort = Number(process.env.E2E_DAEMON_PORT) || await freePort()
  const webPort = Number(process.env.E2E_WEB_PORT) || await freePort()
  const token = 'closed-tabs-e2e'
  const inheritedEnv = Object.entries(process.env).filter(([key]) => (
    !key.startsWith('COMMANDO_') && key !== 'CLAUDE_CONFIG_DIR' && key !== 'CODEX_HOME'
  ))
  const env = {
    ...Object.fromEntries(inheritedEnv),
    HOME: home, COMMANDO_PORT: String(daemonPort), COMMANDO_TMUX_SOCKET_NAME: socket,
    COMMANDO_TOKEN: token, COMMANDO_OWNER_EMAIL: '',
  }
  const daemonUrl = `http://127.0.0.1:${daemonPort}`
  const baseUrl = `http://127.0.0.1:${webPort}`
  const children: ChildProcess[] = []
  let logs = ''
  const start = (args: string[]) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (data) => { logs += data })
    child.stderr?.on('data', (data) => { logs += data })
    children.push(child)
    return child
  }
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    try { await exited } finally { clearTimeout(timeout) }
  }
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const owner = { Authorization: `Bearer ${token}` }
  const api = async (path: string, init: RequestInit & { agent?: boolean } = {}) => {
    const auth = init.agent ? { Authorization: `Bearer ${(await readFile(join(home, '.commando', 'agent-hook-token'), 'utf8')).trim()}` } : owner
    const response = await fetch(`${daemonUrl}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...auth, ...init.headers } })
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
    return response.json()
  }
  const snapshot = (): Promise<CommandoSnapshot> => api('/api/snapshot')
  const closedTabsSection = () => page.getByRole('region', { name: /^Closed tabs for / })
  // A restored session lands in a new window, whose side panel starts collapsed.
  const showSession = async () => {
    const expand = page.getByRole('button', { name: 'Open Session' })
    const tab = page.getByRole('tablist', { name: /^Tabs for / }).getByRole('tab', { name: 'Session' })
    await expect(expand.or(tab)).toBeVisible()
    await (await expand.isVisible() ? expand : tab).click()
  }

  try {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', '-c', home, '/bin/sh')
    const paneId = tmux('new-session', '-d', '-s', 'review', '-c', home, '-P', '-F', '#{pane_id}', '/bin/sh')
    tmux('select-pane', '-t', paneId, '-T', 'Review agent')
    let daemon = start(['--import', 'tsx', 'server/index.ts'])
    start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'])
    await expect.poll(async () => { try { return (await fetch(baseUrl)).status } catch { return 0 } }, { timeout: 30_000 }).toBe(200)
    await expect.poll(async () => { try { return (await snapshot()).panes.length } catch { return 0 } }, { timeout: 30_000 }).toBe(2)
    const targetId = (await snapshot()).panes.find((pane) => pane.id === paneId)!.targetId

    // A redline page and a canvas, served by the daemon like the skills do.
    const artifacts = join(home, 'review')
    await mkdir(artifacts)
    await writeFile(join(artifacts, 'plan.html'), '<!doctype html><title>Rollout plan</title><h1 id="plan">Rollout plan</h1>')
    await writeFile(join(artifacts, 'Mock.html'), '<!doctype html><body style="background:#123">Mock</body>')
    await writeFile(join(artifacts, 'canvas.json'), JSON.stringify({ title: 'Checkout mocks', frames: [{ id: 'mock', title: 'Mock', src: 'Mock.html', x: 0, y: 0 }] }))
    const artifact = await api('/api/redline/artifacts', { method: 'POST', agent: true, body: JSON.stringify({ dir: artifacts }) }) as { id: string; url: string }
    const open = async (body: Record<string, unknown>) => (await api('/api/web-panes', { method: 'POST', agent: true, body: JSON.stringify({ anchor: paneId, engine: 'webkit', ...body }) }) as { webPaneId: string }).webPaneId
    const redline = await open({ url: `${artifact.url}plan.html` })
    const canvas = await open({ url: artifact.url, content: { kind: 'canvas', artifactId: artifact.id, manifest: 'canvas.json' } })
    const pruned = await open({ url: `${artifact.url}Mock.html` })

    await page.goto(`${baseUrl}/#token=${token}`)
    await page.getByRole('button', { name: 'review', exact: true }).click()
    const tabs = page.getByRole('tablist', { name: /^Tabs for / })
    await expect(tabs.getByRole('tab', { name: /plan\.html|Rollout plan/ })).toBeVisible()

    // The agent closes one tab over the API, the owner closes another in the UI.
    await api(`/api/web-panes/${canvas}`, { method: 'DELETE', agent: true })
    await expect(tabs.getByRole('tab', { name: 'Checkout mocks' })).toHaveCount(0)
    await tabs.getByRole('button', { name: /^Close (plan\.html|Rollout plan|.*plan\.html)/ }).click()
    await showSession()
    const section = closedTabsSection()
    await expect(section.getByRole('button', { name: 'Reopen Checkout mocks' })).toBeVisible()
    await expect(section.getByRole('button', { name: /^Reopen .*(plan\.html|Rollout plan)/ })).toBeVisible()
    await expect(section).toContainText('Canvas · closed just now')

    // Pausing archives the session: its open tab is pruned into the list, and
    // the restored pane (new tmux id, same target) still owns all three.
    const sessionId = (await snapshot()).panes.find((pane) => pane.id === paneId)!.sessionId
    const paused = await api(`/api/session-management/sessions/${encodeURIComponent(sessionId)}/pause`, { method: 'POST', body: JSON.stringify({ confirmSessionId: sessionId }) }) as { archive: { id: string } }
    await expect.poll(async () => (await api('/api/web-panes') as { webPanes: { id: string }[] }).webPanes.some((pane) => pane.id === pruned), { timeout: 15_000 }).toBe(false)
    await api(`/api/session-management/archives/${encodeURIComponent(paused.archive.id)}/restore`, { method: 'POST', body: '{}' })
    await expect.poll(async () => (await snapshot()).panes.find((pane) => pane.targetId === targetId)?.id ?? paneId, { timeout: 15_000 }).not.toBe(paneId)
    const restoredPaneId = (await snapshot()).panes.find((pane) => pane.targetId === targetId)!.id

    await page.getByRole('button', { name: 'review', exact: true }).click()
    await showSession()
    await expect(section.getByRole('button', { name: /^Reopen / })).toHaveCount(3)
    await expect(section.getByRole('button', { name: 'Reopen Mock.html' })).toBeVisible()
    await mkdir('/tmp/session-closed-tabs', { recursive: true })
    await section.screenshot({ path: '/tmp/session-closed-tabs/closed-tabs.png' })
    await section.screenshot({ path: testInfo.outputPath('closed-tabs.png') })

    // Reopen brings the canvas back beside the restored pane under its old id, selected.
    await section.getByRole('button', { name: 'Reopen Checkout mocks' }).click()
    await expect(tabs.getByRole('tab', { name: 'Checkout mocks', selected: true })).toBeVisible()
    const live = await api('/api/web-panes') as { webPanes: { id: string; anchorPaneId: string }[] }
    expect(live.webPanes.find((pane) => pane.id === canvas)?.anchorPaneId).toBe(restoredPaneId)
    await expect(page.getByText('Web pane does not exist')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('reopened-canvas.png') })
    await showSession()
    await expect(section.getByRole('button', { name: /^Reopen / })).toHaveCount(2)
    await section.getByRole('button', { name: 'Forget Mock.html' }).click()
    await expect(section.getByRole('button', { name: /^Reopen / })).toHaveCount(1)

    // The list is persisted with the web-pane state.
    await stop(daemon)
    daemon = start(['--import', 'tsx', 'server/index.ts'])
    await expect.poll(async () => { try { return (await snapshot()).panes.length } catch { return 0 } }, { timeout: 30_000 }).toBe(2)
    await page.reload()
    await page.getByRole('button', { name: 'review', exact: true }).click()
    await showSession()
    await expect(section.getByRole('button', { name: /^Reopen .*(plan\.html|Rollout plan)/ })).toBeVisible()
    expect(redline).toMatch(/^w-/)
  } catch (error) {
    console.error(logs)
    throw error
  } finally {
    await page.close()
    await Promise.all(children.map(stop))
    try { tmux('kill-server') } catch { /* This test's own socket; already gone. */ }
    await rm(home, { recursive: true, force: true })
  }
})

import { expect, test } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandoSnapshot } from '../shared/protocol'
import { AgentHookInstaller } from '../server/agent-hook-installer'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test('empty rail, generated hooks, screenshots and notes survive rename, move and daemon restart', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1800, height: 1000 })
  const socket = `commando-worklog-${process.pid}`
  const home = await realpath(await mkdtemp(join(tmpdir(), 'commando-worklog-e2e-')))
  const daemonPort = await freePort()
  const webPort = await freePort()
  const token = 'worklog-e2e'
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COMMANDO_'))),
    HOME: home, COMMANDO_PORT: String(daemonPort), COMMANDO_TMUX_SOCKET_NAME: socket,
    COMMANDO_TOKEN: token, COMMANDO_OWNER_EMAIL: '',
  }
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
    await exited
  }
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const snapshot = async (): Promise<CommandoSnapshot> => {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/api/snapshot`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(`Snapshot: ${response.status}`)
    return response.json()
  }
  try {
    const paths = await new AgentHookInstaller({ home }).install()
    const paneId = tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'worklog', '-c', home, '-P', '-F', '#{pane_id}', '/bin/sh')
    const otherId = tmux('new-session', '-d', '-s', 'destination', '-c', home, '-P', '-F', '#{pane_id}', '/bin/sh')
    tmux('select-pane', '-t', paneId, '-T', 'Worklog agent')
    let daemon = start(['--import', 'tsx', 'server/index.ts'])
    start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort)])
    await expect.poll(async () => { try { return (await fetch(baseUrl)).status } catch { return 0 } }, { timeout: 20_000 }).toBe(200)
    await expect.poll(async () => { try { return (await snapshot()).panes.length } catch { return 0 } }, { timeout: 20_000 }).toBe(2)
    const initial = await snapshot()
    const targetId = initial.panes.find((pane) => pane.id === paneId)!.targetId
    // GitHub is the only mocked service; all worklog, hook, screenshot and tmux traffic is real.
    await page.route('**/api/prs/pane?*', (route) => route.fulfill({ json: { list: {
      targetId, totalCount: 1, truncated: false, fetchedAt: Date.now(),
      pullRequests: [{ repo: 'example/worklog', number: 1, title: 'Linked PR before activity', url: 'https://example.test/pr/1', state: 'open', isDraft: false, createdAt: '2026-09-14', updatedAt: '2026-09-14' }],
    } } }))
    await page.goto(`${baseUrl}/#token=${token}`)
    const first = page.locator(`[data-pane-id="${paneId}"]`)
    await page.locator('.managed-session-main').filter({ has: page.getByText('worklog', { exact: true }) }).click()
    await first.getByRole('button', { name: 'Expand worklog for Worklog agent' }).click()
    await expect(first.getByRole('status')).toContainText('No agent hook data received')
    await expect(first.getByText('Linked PR before activity')).toBeVisible()
    await first.getByRole('textbox', { name: 'Note for Worklog agent' }).fill('Retain my review note')

    const runAgent = (args: string[]) => execFileSync(process.execPath, args, { env: { ...env, TMUX_PANE: paneId }, encoding: 'utf8' })
    const marker = runAgent([paths.prMarkerCliPath]).trim()
    expect(marker).toContain(`target=${targetId}`)
    runAgent(['--input-type=module', '-e', `
      const {CommandoAgentStatusPlugin} = await import(${JSON.stringify(paths.openCodePluginPath)});
      const hooks = await CommandoAgentStatusPlugin({directory: ${JSON.stringify(home)}});
      await hooks['chat.message']({sessionID: 'worklog-fixture'}, {parts: [{type: 'text', text: 'Verify durable ownership'}]});
      await hooks.event({event: {type: 'todo.updated', properties: {sessionID: 'worklog-fixture', todos: [{id: '1', content: 'Verify durable tasks', status: 'in_progress', priority: 'high'}]}}});
    `])
    await expect(first.getByText('Verify durable tasks')).toBeVisible()
    await expect(first.getByText('No agent hook data received', { exact: false })).toHaveCount(0)
    const shots = join(home, 'shots')
    await mkdir(shots)
    await writeFile(join(shots, 'review.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64'))
    runAgent([paths.sessionBriefCliPath, '--headline', 'Ownership verified', '--update', 'decision', 'Retain the original handoff', '--screenshots', shots])
    await expect(first.getByText('Retain the original handoff')).toBeVisible()
    await expect(first.getByRole('button', { name: 'Open screenshot review.png' })).toBeVisible()

    tmux('rename-session', '-t', 'worklog', 'renamed')
    await expect.poll(async () => (await snapshot()).sessions.some((session) => session.name === 'renamed')).toBe(true)
    runAgent([paths.sessionBriefCliPath, '--update', 'note', 'After rename'])
    await expect(first.getByText('After rename')).toBeVisible()
    await expect(first.getByText('Retain the original handoff')).toBeVisible()
    tmux('join-pane', '-s', paneId, '-t', otherId, '-h')
    await expect.poll(async () => (await snapshot()).sessions.length).toBe(1)
    await expect(first).toBeVisible()
    await expect(first.getByRole('textbox', { name: 'Note for Worklog agent' })).toHaveValue('Retain my review note')
    runAgent([paths.sessionBriefCliPath, '--update', 'note', 'After move'])
    await expect(first.getByText('After move')).toBeVisible()
    await stop(daemon)
    daemon = start(['--import', 'tsx', 'server/index.ts'])
    await expect.poll(async () => { try { return (await snapshot()).panes.length } catch { return 0 } }, { timeout: 20_000 }).toBe(2)
    await page.reload()
    await expect(first.getByText('Retain the original handoff')).toBeVisible()
    await expect(first.getByText('Verify durable tasks')).toBeVisible()
    await expect(first.getByText('After move')).toBeVisible()
    await expect(first.getByRole('textbox', { name: 'Note for Worklog agent' })).toHaveValue('Retain my review note')
    await expect(first.getByRole('button', { name: 'Open screenshot review.png' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('worklog-after-move-and-restart.png') })
  } catch (error) {
    console.error(logs)
    throw error
  } finally {
    await page.close()
    await Promise.all(children.map(stop))
    for (const session of ['worklog', 'renamed', 'destination']) {
      try { tmux('kill-session', '-t', session) } catch { /* Already closed or setup failed. */ }
    }
    await rm(home, { recursive: true, force: true })
  }
})

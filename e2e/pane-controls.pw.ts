import { expect, test } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test('creates and kills terminal panes with shortcuts and the header close control', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const socket = `commando-pane-controls-${process.pid}`
  const home = await realpath(await mkdtemp(join(tmpdir(), 'commando-pane-controls-')))
  const daemonPort = await freePort()
  const webPort = await freePort()
  const token = 'pane-controls-test'
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    COMMANDO_PORT: String(daemonPort),
    COMMANDO_TMUX_SOCKET_NAME: socket,
    COMMANDO_TOKEN: token,
    COMMANDO_OWNER_EMAIL: '',
  }
  delete env.COMMANDO_TMUX_SOCKET_PATH
  const children: ChildProcess[] = []
  let logs = ''
  const start = (args: string[]) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (data) => { logs += String(data) })
    child.stderr?.on('data', (data) => { logs += String(data) })
    children.push(child)
  }
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

  try {
    const paneId = tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'pane-controls', '-c', home, '-P', '-F', '#{pane_id}', '/bin/sh')
    tmux('new-session', '-d', '-s', 'untouched', '/bin/sh')
    const untouched = tmux('list-panes', '-t', 'untouched', '-F', '#{pane_id}')
    start(['--import', 'tsx', 'server/index.ts'])
    start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort)])
    const baseUrl = `http://127.0.0.1:${webPort}`
    await expect.poll(async () => {
      try {
        return (await fetch(`${baseUrl}/api/snapshot`, { headers: { Authorization: `Bearer ${token}` } })).status
      } catch { return 0 }
    }, { timeout: 20_000, message: 'Isolated daemon and Vite are ready' }).toBe(200)
    await page.goto(`${baseUrl}/#token=${token}`)
    const first = page.locator(`[data-pane-id="${paneId}"]`)
    await expect(first).toBeVisible()
    await first.locator('.terminal-source-grid').focus()
    await page.keyboard.press('Meta+t')
    await expect.poll(() => tmux('list-panes', '-t', 'pane-controls', '-F', '#{pane_id}').split('\n').length).toBe(2)
    const createdId = tmux('list-panes', '-t', 'pane-controls', '-F', '#{pane_id}').split('\n').find((id) => id !== paneId)!
    const created = page.locator(`[data-pane-id="${createdId}"]`)
    await expect(created).toBeVisible()
    await expect(created).toHaveClass(/is-focused/)
    expect(tmux('display-message', '-p', '-t', createdId, '#{pane_current_path}')).toBe(home)
    await page.screenshot({ path: testInfo.outputPath('pane-close-controls.png') })

    page.once('dialog', (dialog) => dialog.dismiss())
    await page.keyboard.press('Meta+w')
    await expect(created).toBeVisible()
    page.once('dialog', (dialog) => dialog.accept())
    await page.keyboard.press('Meta+w')
    await expect(created).toHaveCount(0)
    expect(tmux('list-panes', '-t', 'pane-controls', '-F', '#{pane_id}')).toBe(paneId)

    await first.locator('.terminal-source-grid').focus()
    await page.keyboard.press('Meta+t')
    await expect(page.locator('.terminal-pane[data-pane-id]')).toHaveCount(2)
    const nextId = tmux('list-panes', '-t', 'pane-controls', '-F', '#{pane_id}').split('\n').find((id) => id !== paneId)!
    const next = page.locator(`[data-pane-id="${nextId}"]`)
    page.once('dialog', (dialog) => dialog.accept())
    await next.getByRole('button', { name: /^Close / }).click()
    await expect(next).toHaveCount(0)
    expect(tmux('list-panes', '-t', 'untouched', '-F', '#{pane_id}')).toBe(untouched)

    // Closing the final pane removes that session without closing the app.
    page.once('dialog', (dialog) => dialog.accept())
    await first.getByRole('button', { name: /^Close / }).click()
    await expect(first).toHaveCount(0)
    await expect(page.locator(`[data-pane-id="${untouched}"]`)).toBeVisible()
  } catch (error) {
    console.error(logs)
    throw error
  } finally {
    await page.close()
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      await exited
    }))
    try { tmux('kill-session', '-t', 'pane-controls') } catch { /* Closed in the test. */ }
    try { tmux('kill-session', '-t', 'untouched') } catch { /* Setup may have failed. */ }
    await rm(home, { recursive: true, force: true })
  }
})

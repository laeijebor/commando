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

test('finds in the focused pane without changing the clipboard or another pane', async ({ context, page }, testInfo) => {
  test.setTimeout(60_000)
  const socket = `commando-pane-find-${process.pid}`
  const home = await realpath(await mkdtemp(join(tmpdir(), 'commando-pane-find-')))
  const daemonPort = await freePort()
  const webPort = await freePort()
  const token = 'pane-find-test'
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    COMMANDO_PORT: String(daemonPort),
    COMMANDO_TMUX_SOCKET_NAME: socket,
    COMMANDO_TOKEN: token,
    COMMANDO_OWNER_EMAIL: '',
  }
  delete env.COMMANDO_TMUX_SOCKET_PATH
  delete env.CLAUDE_CONFIG_DIR
  delete env.CODEX_HOME
  delete env.COMMANDO_AGENT_HOOK_TOKEN_PATH
  const children: ChildProcess[] = []
  let logs = ''
  page.on('pageerror', (error) => { logs += `\nPage error: ${error.stack ?? error.message}` })
  page.on('console', (message) => { if (message.type() === 'error') logs += `\nConsole error: ${message.text()}` })
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
    const firstId = tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'pane-find', '-c', home, '-P', '-F', '#{pane_id}', '/bin/sh')
    const secondId = tmux('split-window', '-h', '-t', firstId, '-c', home, '-P', '-F', '#{pane_id}', '/bin/sh')
    tmux('send-keys', '-t', firstId, 'printf "findneedle one\\nfindneedle two\\n"', 'Enter')
    tmux('send-keys', '-t', firstId, 'seq 1 80', 'Enter')
    tmux('send-keys', '-t', secondId, 'printf "second pane text\\n"', 'Enter')
    start(['--import', 'tsx', 'server/index.ts'])
    start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort)])
    const baseUrl = `http://127.0.0.1:${webPort}`
    await expect.poll(async () => {
      try {
        return (await fetch(`${baseUrl}/api/snapshot`, { headers: { Authorization: `Bearer ${token}` } })).status
      } catch { return 0 }
    }, { timeout: 20_000 }).toBe(200)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
    await page.goto(`${baseUrl}/?qa=1#token=${token}`)
    const first = page.locator(`[data-pane-id="${firstId}"]`)
    const second = page.locator(`[data-pane-id="${secondId}"]`)
    await expect(first.locator('.terminal-source-grid')).toHaveAttribute('data-terminal-seeded', /\d+/)
    await expect(second.locator('.terminal-source-grid')).toHaveAttribute('data-terminal-seeded', /\d+/)
    await page.evaluate(() => navigator.clipboard.writeText('original clipboard'))

    await first.locator('.terminal-source-grid').focus()
    await page.keyboard.press('Control+f')
    await expect(first.getByRole('searchbox', { name: 'Find in terminal' })).toHaveCount(0)
    await page.keyboard.press('Meta+f')
    const field = first.getByRole('searchbox', { name: 'Find in terminal' })
    await expect(field).toBeFocused()
    await expect(second.getByRole('searchbox', { name: 'Find in terminal' })).toHaveCount(0)
    await field.fill('findneedle')
    await expect(first.locator('.terminal-find-count')).toHaveText(/\d+\/[1-9]\d*/)
    await expect.poll(() => page.evaluate((id) => {
      const buffer = window.__commandoQaTerminals?.get(id)?.buffer.active
      return buffer ? buffer.viewportY < buffer.baseY : false
    }, firstId)).toBe(true)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('original clipboard')
    await page.screenshot({ path: testInfo.outputPath('pane-find.png') })

    const count = first.locator('.terminal-find-count')
    const initialCount = await count.textContent()
    await field.press('Enter')
    await expect(count).not.toHaveText(initialCount!)
    const nextCount = await count.textContent()
    await field.press('Shift+Enter')
    await expect(count).not.toHaveText(nextCount!)
    await field.press('Escape')
    await expect(field).toHaveCount(0)
    await expect(first.locator('.xterm-helper-textarea')).toBeFocused()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('original clipboard')

    await page.keyboard.press('Meta+f')
    await expect(field).toBeFocused()
    const reopenedCount = await count.textContent()
    await page.keyboard.press('Meta+g')
    await expect(count).not.toHaveText(reopenedCount!)
    const shortcutCount = await count.textContent()
    await page.keyboard.press('Meta+Shift+g')
    await expect(count).not.toHaveText(shortcutCount!)
    await field.press('Escape')

    await second.locator('.terminal-source-grid').focus()
    await page.keyboard.press('Meta+f')
    await second.getByRole('searchbox', { name: 'Find in terminal' }).fill('findneedle')
    await expect(second.locator('.terminal-find-count')).toHaveText('0/0')

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' })
    })
    await page.reload()
    await expect(second.locator('.terminal-source-grid')).toHaveAttribute('data-terminal-seeded', /\d+/)
    await second.locator('.terminal-source-grid').focus()
    await page.keyboard.press('Control+f')
    await expect(second.getByRole('searchbox', { name: 'Find in terminal' })).toBeFocused()
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
    try { tmux('kill-session', '-t', 'pane-find') } catch { /* Setup may have failed. */ }
    await rm(home, { recursive: true, force: true })
  }
})

import { expect, test } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandoSnapshot } from '../shared/protocol'
import { AgentHookInstaller } from '../server/agent-hook-installer'

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test('worklog identity, history and personal notes survive a full tmux-resurrect cycle', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const plugin = process.env.COMMANDO_RESURRECT_PLUGIN_DIR ?? join(homedir(), '.tmux', 'plugins', 'tmux-resurrect')
  test.skip(!existsSync(join(plugin, 'scripts', 'restore.sh')), 'Install tmux-resurrect or set COMMANDO_RESURRECT_PLUGIN_DIR')
  const home = await realpath(await mkdtemp(join(tmpdir(), 'commando-resurrection-e2e-')))
  const socket = `commando-resurrection-${process.pid}`
  const daemonPort = await freePort()
  const webPort = await freePort()
  const token = 'resurrection-e2e'
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => (
      !key.startsWith('COMMANDO_') && !['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TMUX', 'TMUX_PANE'].includes(key)
    ))),
    HOME: home, COMMANDO_PORT: String(daemonPort), COMMANDO_TMUX_SOCKET_NAME: socket,
    COMMANDO_TOKEN: token, COMMANDO_OWNER_EMAIL: '',
  }
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
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const configure = () => {
    tmux('set-option', '-g', 'default-shell', '/bin/sh')
    tmux('set-option', '-g', '@resurrect-dir', join(home, 'resurrect'))
  }
  const resurrect = (script: 'save' | 'restore') => {
    const tmuxEnv = tmux('display-message', '-p', '#{socket_path},#{pid},0')
    execFileSync('bash', [join(plugin, 'scripts', `${script}.sh`), 'quiet'], {
      env: { ...env, TMUX: tmuxEnv }, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  const snapshot = async (): Promise<CommandoSnapshot> => {
    const response = await fetch(`http://127.0.0.1:${daemonPort}/api/snapshot`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(`Snapshot: ${response.status}`)
    return response.json()
  }
  try {
    const paths = await new AgentHookInstaller({ home }).install()
    const paneId = tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'saved-work', '-c', home, '-P', '-F', '#{pane_id}', '/bin/sh')
    const siblingId = tmux('split-window', '-h', '-t', paneId, '-c', home, '-P', '-F', '#{pane_id}', '/bin/sh')
    tmux('select-pane', '-t', paneId, '-T', 'Saved agent')
    tmux('select-pane', '-t', siblingId, '-T', 'Sibling agent')
    configure()
    let daemon = start(['--import', 'tsx', 'server/index.ts'])
    start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort)])
    const baseUrl = `http://127.0.0.1:${webPort}`
    await expect.poll(async () => { try { return (await snapshot()).panes.length } catch { return 0 } }, { timeout: 20_000 }).toBe(2)
    await expect.poll(async () => { try { return (await fetch(baseUrl)).status } catch { return 0 } }, { timeout: 20_000 }).toBe(200)
    const initial = await snapshot()
    const targetId = initial.panes.find((pane) => pane.id === paneId)!.targetId
    const siblingTarget = initial.panes.find((pane) => pane.id === siblingId)!.targetId
    const runAgent = (id: string, args: string[]) => execFileSync(process.execPath, args, { env: { ...env, TMUX_PANE: id }, encoding: 'utf8' })
    runAgent(paneId, ['--input-type=module', '-e', `
      const {CommandoAgentStatusPlugin} = await import(${JSON.stringify(paths.openCodePluginPath)});
      const hooks = await CommandoAgentStatusPlugin({directory: ${JSON.stringify(home)}});
      await hooks['chat.message']({sessionID: 'restore-fixture'}, {parts: [{type: 'text', text: 'Keep this plan after reboot'}]});
      await hooks.event({event: {type: 'todo.updated', properties: {sessionID: 'restore-fixture', todos: [{id: '1', content: 'Resume the saved task', status: 'in_progress', priority: 'high'}]}}});
    `])
    runAgent(paneId, [paths.sessionBriefCliPath, '--headline', 'Persistent handoff', '--recap-markdown', 'Saved explanation', '--update', 'decision', 'Keep the original context', '--feature-flag', 'persist-worklogs'])
    runAgent(paneId, [paths.sessionBriefCliPath, '--url', 'https://example.test/review', '--url-label', 'Review link'])
    runAgent(siblingId, [paths.sessionBriefCliPath, '--headline', 'Independent sibling handoff', '--update', 'note', 'Sibling history stays separate'])
    await page.route('**/api/prs/pane?*', (route) => {
      const id = new URL(route.request().url()).searchParams.get('paneId')!
      const actualTarget = tmux('show-options', '-pqv', '-t', id, '@commando_target').split(':').at(-1)
      return route.fulfill({ json: { list: { targetId: actualTarget, totalCount: actualTarget === targetId ? 1 : 0,
        truncated: false, fetchedAt: Date.now(), pullRequests: actualTarget === targetId ? [{
          repo: 'example/work', number: 1, title: 'Linked PR survives restoration', url: 'https://example.test/pr/1',
          state: 'open', isDraft: false, createdAt: '', updatedAt: '', additions: 10, deletions: 2,
          checks: null, conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null,
        }] : [] } } })
    })
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.goto(`${baseUrl}/#token=${token}`)
    await page.getByRole('button', { name: 'Expand worklog for Saved agent' }).click()
    await page.getByRole('textbox', { name: 'Note for Saved agent' }).fill('Personal note survives reboot')
    await expect(page.getByText('Resume the saved task', { exact: true })).toBeVisible()
    resurrect('save')
    await stop(daemon)
    tmux('kill-server') // Only the feature-specific socket created by this test.

    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'bootstrap', '-c', home, '/bin/sh')
    // Advance numeric IDs; restoring must not depend on them remaining the same.
    const padding = tmux('split-window', '-h', '-t', 'bootstrap', '-P', '-F', '#{pane_id}', '/bin/sh')
    tmux('kill-pane', '-t', padding)
    configure()
    // Start Commando before resurrection to exercise the populated, unrelated startup snapshot.
    daemon = start(['--import', 'tsx', 'server/index.ts'])
    await expect.poll(async () => { try { return (await snapshot()).sessions[0]?.name } catch { return '' } }, { timeout: 20_000 }).toBe('bootstrap')
    resurrect('restore')
    await expect.poll(async () => (await snapshot()).panes.find((pane) => pane.targetId === targetId)?.id, { timeout: 20_000 }).not.toBeUndefined()
    const restored = (await snapshot()).panes.find((pane) => pane.targetId === targetId)!
    expect(restored.id).not.toBe(paneId)
    const restoredSibling = (await snapshot()).panes.find((pane) => pane.targetId === siblingTarget)!
    expect(restoredSibling).toBeDefined()
    await page.reload()
    await page.locator('.managed-session-main').filter({ has: page.getByText('saved-work', { exact: true }) }).click()
    const worklog = page.locator(`[data-pane-id="${restored.id}"] .pane-worklog`)
    const siblingWorklog = page.locator(`[data-pane-id="${restoredSibling.id}"] .pane-worklog`)
    await siblingWorklog.getByRole('button', { name: 'Expand worklog for Sibling agent' }).click()
    await expect(siblingWorklog.getByText('Independent sibling handoff', { exact: true })).toBeVisible()
    await expect(siblingWorklog.getByText('Sibling history stays separate', { exact: true })).toBeVisible()
    await expect(worklog.getByText('Sibling history stays separate', { exact: true })).toHaveCount(0)
    await expect(worklog.getByText('Persistent handoff', { exact: true })).toBeVisible()
    await expect(worklog.getByText('Resume the saved task', { exact: true })).toBeVisible()
    await expect(worklog.getByText('Keep the original context', { exact: true })).toBeVisible()
    await expect(worklog.getByText('Saved explanation', { exact: true })).toBeVisible()
    await expect(worklog.getByText('persist-worklogs', { exact: true })).toBeVisible()
    await expect(worklog.getByRole('link', { name: /Review link/ })).toHaveAttribute('href', 'https://example.test/review')
    await expect(worklog.getByRole('textbox')).toHaveValue('Personal note survives reboot')
    await expect(worklog.getByText('Linked PR survives restoration')).toBeVisible()
    await expect(worklog.getByRole('status')).toContainText('Saved worklog restored')
    await expect(worklog).toHaveClass(/state-stale/)
    await worklog.screenshot({ path: testInfo.outputPath('restored-worklog.png') })
    runAgent(restored.id, [paths.sessionBriefCliPath, '--update', 'note', 'Continued after resurrection'])
    await expect(worklog.getByText('Continued after resurrection', { exact: true })).toBeVisible()
    runAgent(restored.id, ['--input-type=module', '-e', `
      const {CommandoAgentStatusPlugin} = await import(${JSON.stringify(paths.openCodePluginPath)});
      const hooks = await CommandoAgentStatusPlugin({directory: ${JSON.stringify(home)}});
      await hooks['chat.message']({sessionID: 'restore-fixture-resumed'}, {parts: [{type: 'text', text: 'Fresh hooks after resurrection'}]});
    `])
    await expect(worklog.getByText('Fresh hooks after resurrection', { exact: true })).toBeVisible()
    await expect(worklog.getByText('Keep the original context', { exact: true })).toBeVisible()
    await expect(worklog.getByRole('status')).toHaveCount(0)
    expect(runAgent(restored.id, [paths.prMarkerCliPath])).toContain(`target=${targetId}`)
  } catch (error) {
    console.error(logs)
    throw error
  } finally {
    await page.close()
    await Promise.all(children.map(stop))
    try { tmux('kill-server') } catch { /* Feature-specific server may already be gone. */ }
    await rm(home, { recursive: true, force: true })
  }
})

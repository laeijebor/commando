import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { AGENT_LAUNCH_ENV_KEYS, agentLaunchPaneCommand, TmuxCreator } from './tmux-create.js'

const exec = promisify(execFile)

function fixtureEnvironment(directory: string, socket: string): Record<string, string> {
  return {
    PATH: `${directory}:/usr/bin:/bin`, HOME: `${directory}/daemon-home`, SHELL: '/bin/sh',
    CLAUDE_CONFIG_DIR: `${directory}/claude profile`, CODEX_HOME: `${directory}/codex`,
    COMMANDO_AGENT_HOOK_TOKEN_PATH: `${directory}/hook-token`,
    COMMANDO_PORT: '4410', COMMANDO_TOKEN: 'fixture', COMMANDO_TMUX_SOCKET_PATH: socket,
    TMUX_PANE: '%stale-daemon-pane', COMMANDO_TEST_UNFORWARDED: 'fixture-do-not-forward',
  }
}

async function writePythonFixture(directory: string): Promise<string> {
  // On macOS /usr/bin/python3 launches Xcode's interpreter through a shim.
  // Resolve it before applying the synthetic HOME/PATH: shim discovery can
  // otherwise take longer than the report deadline and obscure CLI startup.
  const { stdout } = await exec('/usr/bin/python3', ['-c', 'import sys; print(sys.executable)'], { timeout: 5_000 })
  const python = stdout.trim()
  if (!python.startsWith('/') || /\s/u.test(python)) throw new Error(`Python fixture needs an absolute shebang path without whitespace: ${JSON.stringify(python)}`)
  // Fake CLI, real terminal. Python exposes its own PID and terminal/process
  // group without inspecting shared processes or loading any provider profile.
  await writeFile(join(directory, 'agent'), `#!${python}
import os, sys, json, time
assert os.path.isfile('prepared')
environment = {key: os.environ.get(key) for key in ${JSON.stringify([...AGENT_LAUNCH_ENV_KEYS])}}
if sys.argv[1:] == ['--fixture-preflight']:
    print(json.dumps(dict(executable=sys.executable, env=environment)), flush=True)
    sys.exit(0)
assert sys.stdin.isatty() and sys.stdout.isatty()
with open('report', 'w') as report:
    json.dump(dict(pid=os.getpid(), pgid=os.getpgrp(), foreground=os.tcgetpgrp(0),
        pane=os.environ['TMUX_PANE'], cwd=os.getcwd(), argv=sys.argv[1:],
        env=environment,
        unforwarded=os.environ.get('COMMANDO_TEST_UNFORWARDED')), report)
reply = input()
print('PTY-REPLY:' + reply, flush=True)
while True: time.sleep(1)
`, { mode: 0o755 })
  return python
}

it('starts the exact Python fixture directly under the daemon launch environment without the macOS shim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commando-create-python-'))
  try {
    const python = await writePythonFixture(directory)
    const daemonEnv = fixtureEnvironment(directory, join(directory, 'tmux.sock'))
    const staleEnv = Object.fromEntries(AGENT_LAUNCH_ENV_KEYS.map((key) => [key, `/stale/${key}`]))
    const { stdout } = await exec('/bin/sh', ['-c', agentLaunchPaneCommand([join(directory, 'agent'), '--fixture-preflight'], 'touch prepared', daemonEnv)], {
      cwd: directory, env: staleEnv, timeout: 5_000,
    })
    const observed = JSON.parse(stdout.trim().split('\n').at(-1)!)
    expect(observed.executable).toBe(python)
    for (const key of AGENT_LAUNCH_ENV_KEYS) expect(observed.env[key]).toBe(daemonEnv[key] ?? null)
    expect(await readFile(join(directory, 'prepared'), 'utf8')).toBe('')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 10_000)

it('execs the selected CLI as the pane root/foreground process and overrides an existing server environment', async () => {
  // Python getcwd resolves macOS's /var -> /private/var alias.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'commando-create-pty-')))
  const socket = join(directory, 'tmux.sock')
  const report = join(directory, 'report')
  const run = async (args: readonly string[]) => {
    const result = await exec('tmux', ['-f', '/dev/null', ...args], { timeout: 3_000 })
    if (result.stderr.trim()) throw new Error(result.stderr.trim())
    return result.stdout
  }
  const prompt = "--force\nLeo's $HOME `whoami`; $(pwd)"
  const daemonEnv = fixtureEnvironment(directory, socket)
  const creator = new TmuxCreator(run, ['-S', socket], {
    probe: async () => ({ isRepo: true, mainRoot: directory }),
    createWorktree: async () => ({ worktree: { path: directory, branch: 'test', base: 'HEAD', reusedBranch: false }, rollback: async () => undefined }),
  }, undefined, daemonEnv)
  let ownedPaneId: string | undefined
  try {
    await writePythonFixture(directory)
    await run(['-S', socket, 'new-session', '-d', '-s', 'fixture-keeper', '/bin/sleep', '60'])
    // Only this private test server retains exited panes for startup diagnostics.
    await run(['-S', socket, 'set-option', '-g', 'remain-on-exit', 'on'])
    for (const key of AGENT_LAUNCH_ENV_KEYS) await run(['-S', socket, 'set-environment', '-g', key, `/stale/${key}`])
    const { created, agentLaunch } = await creator.createSession({ name: 'owned-test', cwd: directory, worktree: { branch: 'test', prepareCommand: 'touch prepared' }, agent: { provider: 'cursor', prompt } })
    ownedPaneId = created.paneId
    let observed: { pid: number; pgid: number; foreground: number; pane: string; cwd: string; argv: string[]; env: Record<string, string | null>; unforwarded: string | null } | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      try { observed = JSON.parse(await readFile(report, 'utf8')); break } catch { await new Promise((resolve) => setTimeout(resolve, 20)) }
    }
    expect(observed, 'Python fixture did not write its report within 2 seconds').toBeDefined()
    expect(await readFile(join(directory, 'prepared'), 'utf8')).toBe('')
    expect(agentLaunch).toEqual({ version: 1, provider: 'cursor', paneId: created.paneId, mode: 'interactive-pty', state: 'initiated' })
    expect(observed!.pane).toBe(created.paneId)
    expect(observed!.cwd).toBe(directory)
    expect(observed!.argv).toEqual(['agent', '--', prompt])
    for (const key of AGENT_LAUNCH_ENV_KEYS) expect(observed!.env[key]).toBe(daemonEnv[key] ?? null)
    expect(observed!.unforwarded).toBeNull()
    const identity = (await run(['-S', socket, 'display-message', '-p', '-t', created.paneId, '#{pane_pid}|#{pane_current_command}'])).trim().split('|')
    expect(Number(identity[0])).toBe(observed!.pid)
    expect(identity[1]).toMatch(/^python(?:3(?:\.\d+)?)?$/i)
    expect(observed!.pgid).toBe(observed!.pid)
    expect(observed!.foreground).toBe(observed!.pgid)
    await run(['-S', socket, 'send-keys', '-t', created.paneId, '-l', 'typed into owned pane'])
    await run(['-S', socket, 'send-keys', '-t', created.paneId, 'Enter'])
    let screen = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      screen = await run(['-S', socket, 'capture-pane', '-p', '-t', created.paneId])
      if (screen.includes('PTY-REPLY:typed into owned pane')) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(screen).toContain('PTY-REPLY:typed into owned pane')
    // Session-specific overrides never rewrite the existing server's context.
    expect((await run(['-S', socket, 'show-environment', '-g', 'CLAUDE_CONFIG_DIR'])).trim()).toBe('CLAUDE_CONFIG_DIR=/stale/CLAUDE_CONFIG_DIR')
  } catch (error) {
    if (!ownedPaneId) throw error
    const diagnostics = await Promise.allSettled([
      run(['-S', socket, 'display-message', '-p', '-t', ownedPaneId, 'pane=#{pane_id} pid=#{pane_pid} command=#{pane_current_command} dead=#{pane_dead} exit=#{pane_dead_status} tty=#{pane_tty} cwd=#{pane_current_path}']),
      run(['-S', socket, 'capture-pane', '-p', '-S', '-80', '-t', ownedPaneId]),
    ])
    const detail = diagnostics.map((result, index) => `${index === 0 ? 'Owned pane identity' : 'Owned pane output'}:\n${result.status === 'fulfilled' ? result.value : String(result.reason)}`).join('\n')
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`, { cause: error })
  } finally {
    await run(['-S', socket, 'kill-session', '-t', '=owned-test']).catch(() => undefined)
    await run(['-S', socket, 'kill-session', '-t', '=fixture-keeper']).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

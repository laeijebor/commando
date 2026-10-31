import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repository = fileURLToPath(new URL('../', import.meta.url))
const directories: string[] = []
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-hub-test-'))
  directories.push(directory)
  const home = join(directory, 'hub home & test')
  const checkout = join(directory, 'source checkout & test')
  const bin = join(directory, 'bin')
  const calls = join(directory, 'calls')
  await Promise.all([mkdir(home), mkdir(bin), mkdir(join(checkout, 'scripts'), { recursive: true }),
    mkdir(join(checkout, 'node_modules/.bin'), { recursive: true })])
  for (const name of ['hub-setup', 'hub-setup.mjs', 'hub-keep-awake.mjs', 'desktop-release.sh']) {
    await cp(join(repository, 'scripts', name), join(checkout, 'scripts', name))
  }
  for (const name of ['tsc', 'vite', 'tsx']) await writeFile(join(checkout, 'node_modules/.bin', name), '')
  for (const name of ['.claude', '.claudew', '.claudep']) await mkdir(join(home, name))
  await writeFile(join(home, '.claude.json'), 'not a config directory')
  const stub = async (name: string, body: string) => {
    await writeFile(join(bin, name), `#!/bin/bash\nset -eu\nprintf '%s:%s:%s\\n' ${shellQuote(name)} "$*" "\${CLAUDE_CONFIG_DIR:-}" >> "$HUB_TEST_CALLS"\n${body}\n`, { mode: 0o755 })
  }
  await symlink(process.execPath, join(bin, 'node'))
  await stub('uname', 'echo Darwin')
  await stub('id', 'if [[ "$1" == -u ]]; then echo 501; else echo hubuser; fi')
  await stub('git', 'echo "git version 2.50.0"')
  await stub('tmux', 'echo "tmux 3.5"')
  await stub('gh', 'exit "${HUB_TEST_GH_STATUS:-0}"')
  await stub('tailscale', `printf '%s\\n' '\{"BackendState":"Running","Self":{"Online":true,"TailscaleIPs":["100.101.102.103","fd7a:115c:a1e0::1"]}}'`)
  await stub('claude', 'case "$CLAUDE_CONFIG_DIR" in *.claudep) echo \'{"loggedIn":false}\'; exit 1;; *) echo \'{"loggedIn":true}\';; esac')
  await stub('codex', 'echo "Logged in using ChatGPT" >&2')
  await stub('agent', 'echo "Logged in as hub@example.com"')
  // Every dangerous command is stubbed, even though dry-run must never call it.
  for (const name of ['sudo', 'pmset', 'launchctl', 'visudo', 'plutil']) {
    await stub(name, 'echo "UNEXPECTED MUTATION" >&2; exit 99')
  }
  const env: NodeJS.ProcessEnv = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HUB_TEST_CALLS: calls,
    CODEX_HOME: join(home, '.codex'), CURSOR_CONFIG_DIR: join(home, '.cursor'),
    XDG_CONFIG_HOME: join(home, '.config'),
  }
  return { directory, home, checkout, bin, calls, env, stub }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function execute(command: string, argv: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(command, argv, { env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}
function run(f: Fixture, args: string[] = []) {
  // There is deliberately no test entry point that runs installation for real.
  return execute('bash', [join(f.checkout, 'scripts/hub-setup'), '--dry-run', ...args], f.env)
}
async function tree(directory: string): Promise<unknown> {
  return Promise.all((await readdir(directory)).sort().map(async (name) => {
    const path = join(directory, name)
    return [name, (await stat(path)).isDirectory() ? await tree(path) : await readFile(path, 'utf8')]
  }))
}

async function releaseHarness(f: Fixture, overrides: string, dispatch = false) {
  const source = await readFile(join(f.checkout, 'scripts/desktop-release.sh'), 'utf8')
  const dispatchIndex = source.lastIndexOf('\ncase "${1:-}" in\n')
  expect(dispatchIndex).toBeGreaterThan(0)
  const path = join(f.checkout, 'scripts/release-harness.sh')
  // Load the real functions, but replace side effects before reaching dispatch.
  await writeFile(path, `${source.slice(0, dispatchIndex)}\n${overrides}\n${dispatch ? source.slice(dispatchIndex) : 'load_env\nrender_agent\n'}`)
  return path
}

describe('hub setup (temporary HOME, stubbed commands, dry-run only)', () => {
  it('plans both agents, a private config, exact least-privilege sudoers, and no filesystem changes', async () => {
    const f = await fixture()
    const before = await tree(f.home)
    const checkoutBefore = await tree(f.checkout)
    const result = await run(f)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('DRY RUN (no writes or privileged commands)')
    expect(result.stdout).toContain('COMMANDO_TAILSCALE=1')
    expect(result.stdout).toContain('COMMANDO_TOKEN=\'<redacted>\'')
    expect(result.stdout).toContain('hubuser ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n')
    expect(result.stdout).not.toContain('NOPASSWD: ALL')
    expect(result.stdout).toContain("'visudo' '-cf' '<temporary-directory>/sudoers'")
    expect(result.stdout).toContain("'sudo' '-n' '/usr/bin/install' '-o' 'root' '-g' 'wheel' '-m' '0440'")
    expect(result.stdout.indexOf("'visudo' '-cf'")).toBeLessThan(result.stdout.indexOf("'-m' '0440'"))
    const invalidate = result.stdout.indexOf("PLAN 'sudo' '-k'")
    expect(invalidate).toBeGreaterThan(result.stdout.indexOf("'-m' '0440'"))
    for (const value of ['1', '0']) {
      const permission = result.stdout.indexOf(`PLAN 'sudo' '-n' '-l' '/usr/bin/pmset' '-a' 'disablesleep' '${value}'`)
      expect(permission).toBeGreaterThan(invalidate)
      expect(permission).toBeLessThan(result.stdout.indexOf('hub.env.new ->'))
    }
    expect(result.stdout).toContain('.commando/desktop-release.lock')
    expect(result.stdout).toContain('hub.env.new ->')
    expect(result.stdout).toContain('mode 600')
    expect(result.stdout).toContain('daemon-install')
    expect(result.stdout).toContain('tsc -b and vite')
    expect(result.stdout).toContain('Hub Tailscale URL: http://100.101.102.103:4310/')
    expect(result.stdout).toContain('single-use, two-minute QR code')
    expect(result.stdout).toContain('com.commando.hub.keep-awake')
    expect(result.stdout).toContain('pmset -g ps every 30s')
    expect(await tree(f.home)).toEqual(before)
    expect(await tree(f.checkout)).toEqual(checkoutBefore)
    expect(await readFile(f.calls, 'utf8')).not.toMatch(/^(sudo|pmset|launchctl|visudo|plutil):/m)
  })

  it('uses the desktop renderer for both plists, with escaped paths, restart policy, and hub logs', async () => {
    const f = await fixture()
    const { stdout, code } = await run(f)
    expect(code).toBe(0)
    const plists = stdout.match(/<\?xml[\s\S]*?<\/plist>/g)!
    expect(plists).toHaveLength(2)
    for (const xml of plists) {
      expect(xml).toContain('<string>/bin/zsh</string>\n        <string>-lic</string>')
      expect(xml).toContain('<key>RunAtLoad</key>\n    <true/>')
      expect(xml).toContain('<key>KeepAlive</key>\n    <dict>\n        <key>SuccessfulExit</key>\n        <false/>')
      expect(xml).toContain('<key>ProcessType</key>\n    <string>Interactive</string>')
      expect(xml).toContain('<key>ThrottleInterval</key>\n    <integer>10</integer>')
      expect(xml).toContain('hub home &amp; test/.commando/hub.env')
      expect(xml).not.toContain('dev.commando.daemon')
    }
    expect(plists[0]).toContain('<string>com.commando.hub</string>')
    expect(plists[0]).toContain('<string>exec "$0" daemon --log-dir "$1"</string>')
    expect(plists[0]).toContain('<string>' + f.home.replaceAll('&', '&amp;') + '/.commando/logs/hub</string>')
    expect(plists[0]).toContain('source checkout &amp; test/scripts/desktop-release.sh')
    expect(plists[0]).toContain('.commando/logs/hub/daemon-launchd.log')
    expect(plists[1]).toContain('<string>com.commando.hub.keep-awake</string>')
    expect(plists[1]).toContain('<string>exec "$0" daemon</string>')
    expect(plists[1]).toContain('.commando/hub-keep-awake.mjs')
    expect(plists[1]).toContain('.commando/logs/hub-keep-awake/daemon-launchd.log')
  })

  it('reports each Claude profile and both other logins without trying to authenticate', async () => {
    const f = await fixture()
    const { stdout } = await run(f)
    expect(stdout).toContain('OK Claude .claude: logged in')
    expect(stdout).toContain('OK Claude .claudew: logged in')
    expect(stdout).toContain('WARN Claude .claudep: not logged in / status unavailable')
    expect(stdout).toContain('OK Codex: logged in')
    expect(stdout).toContain('OK Cursor: logged in')
    const calls = await readFile(f.calls, 'utf8')
    expect(calls.match(/^claude:auth status --json:/gm)).toHaveLength(3)
    expect(calls).toContain('codex:login status:')
    expect(calls).toContain('agent:status:')
    expect(calls).not.toContain('claude:auth login')
  })

  it('does not classify negative or failing login statuses as logged in', async () => {
    const f = await fixture()
    await f.stub('codex', 'echo "Not logged in"')
    await f.stub('agent', 'echo "Authenticated"; exit 1')
    const { stdout, code } = await run(f)
    expect(code).toBe(0) // Agent logins are reports, not installation blockers.
    expect(stdout).toContain('WARN Codex: not logged in')
    expect(stdout).toContain('WARN Cursor: not logged in')
  })

  it.each(['disconnected', 'malformed', 'offline', 'gh'])('reports %s prerequisites and stops before planning any writes', async (failure) => {
    const f = await fixture()
    if (failure === 'gh') f.env.HUB_TEST_GH_STATUS = '1'
    else await f.stub('tailscale', failure === 'malformed' ? 'echo invalid-json' : `echo '${JSON.stringify({
      BackendState: failure === 'disconnected' ? 'NeedsLogin' : 'Running',
      Self: { Online: false, TailscaleIPs: ['100.101.102.103'] },
    })}'`)
    const result = await run(f)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain(failure === 'gh' ? 'FAIL gh' : 'FAIL Tailscale')
    expect(result.stdout).toContain('Claude .claude') // Full report, including logins.
    expect(result.stdout).not.toContain('PLAN write')
    expect(result.stderr).toContain('Prerequisites failed. Nothing installed')
  })

  it('skips all keep-awake installation and sudo planning with --no-keep-awake', async () => {
    const f = await fixture()
    const result = await run(f, ['--no-keep-awake'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).not.toContain("PLAN 'sudo'")
    expect(result.stdout).not.toContain('NOPASSWD')
    expect(result.stdout.match(/<\?xml/g)).toHaveLength(1)
    expect(result.stdout).toContain('an existing watcher/rule is preserved')
  })

  it('plans uninstall without requiring tailnet or agent logins, restores sleep before deleting the rule', async () => {
    const f = await fixture()
    const result = await run(f, ['--uninstall'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('bootout gui/501/com.commando.hub.keep-awake')
    const restore = "'sudo' '-n' '/usr/bin/pmset' '-a' 'disablesleep' '0'"
    const remove = "'sudo' '-n' '/bin/rm' '-f' '/etc/sudoers.d/commando-hub-keep-awake'"
    expect(result.stdout).toContain(restore)
    expect(result.stdout).toContain(remove)
    expect(result.stdout.indexOf(restore)).toBeLessThan(result.stdout.indexOf(remove))
    expect(result.stdout).toContain('daemon-uninstall')
    expect(result.stdout).toContain(`remove ${f.home}/Library/LaunchAgents/com.commando.hub.plist`)
    expect(result.stdout).toContain(`PLAN remove ${f.home}/.commando/hub-keep-awake.mjs`)
    expect(result.stdout).toContain('Kept')
    expect(await readdir(f.home)).not.toContain('.commando')
    expect(await readFile(f.calls, 'utf8')).not.toMatch(/^(sudo|launchctl|tailscale|claude|codex|agent):/m)
  })

  it('preserves and redacts an existing token, forces Tailscale, and honors the saved port', async () => {
    const f = await fixture()
    const config = "COMMANDO_PORT=4410\nCOMMANDO_TOKEN='existing-secret'\nCOMMANDO_TAILSCALE=0\nCOMMANDO_OWNER_EMAIL='hub@example.com'\n"
    await mkdir(join(f.home, '.commando'))
    const path = join(f.home, '.commando/hub.env')
    await writeFile(path, config)
    const result = await run(f)
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('existing-secret')
    expect(result.stdout).toContain('COMMANDO_OWNER_EMAIL=\'hub@example.com\'')
    expect(result.stdout).toContain('COMMANDO_TAILSCALE=1')
    expect(result.stdout).not.toContain('COMMANDO_TAILSCALE=0')
    expect(result.stdout).toContain('http://100.101.102.103:4410/')
    expect(await readFile(path, 'utf8')).toBe(config)
  })

  it('redacts all secret-named env values, with optional export and mixed-case names', async () => {
    const f = await fixture()
    const config = [
      'COMMANDO_PORT=4310', "COMMANDO_TOKEN='private-token'",
      "export EXPO_ACCESS_TOKEN='private-expo-token'", "API_KEY='private-api-key'",
      'export service_api_Key="private-mixed-case-key"', "clientSecret='private-secret'",
      'export loginPASSWORD=private-password', "COMMANDO_OWNER_EMAIL='hub@example.com'", '',
    ].join('\n')
    await mkdir(join(f.home, '.commando'))
    const path = join(f.home, '.commando/hub.env')
    await writeFile(path, config)
    const result = await run(f)
    expect(result.code, result.stderr).toBe(0)
    for (const secret of ['private-token', 'private-expo-token', 'private-api-key', 'private-mixed-case-key', 'private-secret', 'private-password']) {
      expect(result.stdout).not.toContain(secret)
    }
    expect(result.stdout).toContain("export EXPO_ACCESS_TOKEN='<redacted>'")
    expect(result.stdout).toContain("API_KEY='<redacted>'")
    expect(result.stdout).toContain("COMMANDO_OWNER_EMAIL='hub@example.com'")
    expect(await readFile(path, 'utf8')).toBe(config)
  })

  it('allows a dotted macOS username without adding sudoers metacharacters', async () => {
    const f = await fixture()
    await f.stub('id', 'if [[ "$1" == -u ]]; then echo 501; else echo leo.ijebor; fi')
    const result = await run(f)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('leo.ijebor ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n')
  })

  it('rejects username characters that could inject a sudoers entry', async () => {
    const f = await fixture()
    await f.stub('id', 'if [[ "$1" == -u ]]; then echo 501; else echo "leo.ijebor ALL"; fi')
    const result = await run(f)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('regular macOS login user')
    expect(result.stdout).not.toContain('PLAN write')
  })

  it('rejects unknown options before running any checks', async () => {
    const f = await fixture()
    const result = await run(f, ['--invalid'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Unknown option')
    await expect(readFile(f.calls)).rejects.toThrow()
  })
})

describe('hub sudoers validation (stubbed sudo, no installation)', () => {
  it.each(['1', '0'])('refuses setup if disablesleep %s is denied after invalidating the ticket', async (denied) => {
    const f = await fixture()
    f.env.HUB_TEST_INVALIDATED = join(f.directory, 'invalidated-ticket')
    await f.stub('sudo', `
      if [[ "$*" == -k ]]; then : > "$HUB_TEST_INVALIDATED"; exit 0; fi
      if [[ "$*" == '-n -l /usr/bin/pmset -a disablesleep ${denied}' && -f "$HUB_TEST_INVALIDATED" ]]; then exit 1; fi
      exit 0
    `)
    // Exercise the exact verification used after installation, never main().
    const script = `
      import { execFileSync } from 'node:child_process';
      import { verifyKeepAwakePermissions } from ${JSON.stringify(new URL('./hub-setup.mjs', import.meta.url).href)};
      const run = (command, args) => execFileSync(command, args, { stdio: 'pipe' });
      run('sudo', ['-v']);
      run('sudo', ['-n', '-l', '/usr/bin/pmset', '-a', 'disablesleep', '${denied}']);
      try { verifyKeepAwakePermissions(run); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `
    const result = await execute(process.execPath, ['--input-type=module', '-e', script], f.env)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Keep-awake sudoers rule is not active')
    expect(result.stderr).toContain(`disablesleep ${denied} was refused after sudo -k`)
    const calls = await readFile(f.calls, 'utf8')
    expect(calls).toContain(`sudo:-n -l /usr/bin/pmset -a disablesleep ${denied}:\nsudo:-k:\n`)
    expect(calls.slice(calls.indexOf('sudo:-k:'))).toContain(`sudo:-n -l /usr/bin/pmset -a disablesleep ${denied}:`)
    expect(calls).not.toMatch(/^(launchctl|pmset):/m)
  })
})

describe('desktop release isolation and locking (temporary harness, no builds or launches)', () => {
  it.each(['install', 'rebuild', 'daemon'])('ignores old and hub-specific overrides in %s environment and env file', async (command) => {
    const f = await fixture()
    await mkdir(join(f.home, '.commando'))
    await writeFile(join(f.home, '.commando/desktop-release.env'), [
      'COMMANDO_PORT=4310', 'COMMANDO_TOKEN=fixture-token',
      'COMMANDO_RELEASE_LOG_DIR=/ignored/old-env-log', 'COMMANDO_RELEASE_AGENT_SCRIPT=/ignored/old-env-script',
      'COMMANDO_HUB_LOG_DIR=/ignored/hub-env-log', 'COMMANDO_HUB_AGENT_SCRIPT=/ignored/hub-env-script', '',
    ].join('\n'))
    Object.assign(f.env, {
      COMMANDO_RELEASE_LOG_DIR: '/ignored/old-parent-log', COMMANDO_RELEASE_AGENT_SCRIPT: '/ignored/old-parent-script',
      COMMANDO_HUB_LOG_DIR: '/ignored/hub-parent-log', COMMANDO_HUB_AGENT_SCRIPT: '/ignored/hub-parent-script',
    })
    const harness = await releaseHarness(f, '')
    const result = await execute('bash', [harness, command], f.env)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('/ignored/')
    expect(result.stdout).toContain('<string>exec "$0" daemon</string>')
    expect(result.stdout).not.toContain('--log-dir')
    expect(result.stdout).toContain('<string>dev.commando.daemon</string>')
    expect(result.stdout).toContain('scripts/release-harness.sh</string>')
    expect(result.stdout).toContain('.commando/logs/daemon-launchd.log</string>')
    expect(await readFile(f.calls, 'utf8')).not.toMatch(/^(launchctl|sudo|pmset):/m)
  })

  it.each(['daemon-install', 'daemon-uninstall'])('%s acquires the release lock before any side effects', async (command) => {
    const f = await fixture()
    const harness = await releaseHarness(f, `
      require_main_checkout() { :; }
      take_release_lock() { printf 'release lock requested\\n'; exit 42; }
    `, true)
    const result = await execute('bash', [harness, command], f.env)
    expect(result.code).toBe(42)
    expect(result.stdout).toBe('release lock requested\n')
    expect(result.stderr).toBe('')
    expect(await readFile(f.calls, 'utf8')).not.toMatch(/^(launchctl|sudo|pmset):/m)
  })
})

describe('hub keep-awake watcher', () => {
  it.each([
    ["Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged;", '1'],
    ["Now drawing from 'Battery Power'\n -InternalBattery-0 50%; discharging;", '0'],
    ['AC Power listed somewhere else, no source line', '0'],
  ])('--once --ps-output safely maps %j to disablesleep %s', async (power, desired) => {
    const f = await fixture()
    await f.stub('sudo', 'exit 0')
    const path = join(f.directory, 'power.txt')
    await writeFile(path, power)
    const result = await execute(process.execPath, [join(f.checkout, 'scripts/hub-keep-awake.mjs'), '--once', '--ps-output', path], f.env)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(`disablesleep ${desired}`)
    expect(await readFile(f.calls, 'utf8')).toBe(`sudo:-n /usr/bin/pmset -a disablesleep ${desired}:\n`)
  })

  it('changes only on AC/battery transitions, retries failed changes, and restores sleep on stop', async () => {
    const f = await fixture()
    const script = `
      import { powerWatcher } from ${JSON.stringify(new URL('./hub-keep-awake.mjs', import.meta.url).href)};
      const calls = []; let fail = true;
      const watcher = powerWatcher((command, args) => {
        if (fail) { fail = false; throw new Error('sudo failed'); }
        calls.push([command, args]);
      }, () => {});
      const ac = "Now drawing from 'AC Power'";
      const battery = "Now drawing from 'Battery Power'";
      try { watcher.update(ac); } catch {}
      watcher.update(ac); watcher.update(ac);
      watcher.update(battery); watcher.update(battery);
      watcher.update(ac); watcher.stop(); watcher.stop();
      console.log(JSON.stringify(calls));
    `
    const result = await execute(process.execPath, ['--input-type=module', '-e', script], f.env)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([1, 0, 1, 0].map((value) => ['sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', String(value)]]))
  })

  it('uses the PATH pmset stub for read-only power discovery', async () => {
    const f = await fixture()
    await f.stub('sudo', 'exit 0')
    await f.stub('pmset', `echo "Now drawing from 'Battery Power'"`)
    const result = await execute(process.execPath, [join(f.checkout, 'scripts/hub-keep-awake.mjs'), '--once'], f.env)
    expect(result.code, result.stderr).toBe(0)
    expect(await readFile(f.calls, 'utf8')).toContain('pmset:-g ps:')
    expect(result.stdout).toContain('disablesleep 0')
  })

  it('restores sleep on SIGTERM in the running watcher, using only stubbed sudo/pmset', async () => {
    const f = await fixture()
    await f.stub('sudo', 'exit 0')
    await f.stub('pmset', `echo "Now drawing from 'AC Power'"`)
    const child = spawn(process.execPath, [join(f.checkout, 'scripts/hub-keep-awake.mjs'), 'daemon'], { env: f.env })
    let stdout = ''
    let stopped = false
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (!stopped && stdout.includes('disablesleep 1')) {
        stopped = true
        child.kill('SIGTERM')
      }
    })
    try {
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      expect(result).toEqual({ code: 0, signal: null })
      expect(stdout).toContain('disablesleep 0')
      expect(await readFile(f.calls, 'utf8')).toBe('pmset:-g ps:\nsudo:-n /usr/bin/pmset -a disablesleep 1:\nsudo:-n /usr/bin/pmset -a disablesleep 0:\n')
    } finally { clearTimeout(timer); child.kill('SIGKILL') }
  })
})

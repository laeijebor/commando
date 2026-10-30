import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: scripts/hub-setup [--dry-run] [--uninstall] [--no-keep-awake]')
  process.exit(0)
}
if (args.some((arg) => !['--dry-run', '--uninstall', '--no-keep-awake'].includes(arg))) {
  console.error('Unknown option. Use --help.')
  process.exit(2)
}
const dry = args.includes('--dry-run')
const uninstall = args.includes('--uninstall')
const keepAwake = !args.includes('--no-keep-awake')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const release = join(root, 'scripts/desktop-release.sh')
const home = process.env.HOME
if (!home || !home.startsWith('/')) throw new Error('HOME must be an absolute path')
const state = join(home, '.commando')
const envFile = join(state, 'hub.env')
const logs = join(state, 'logs/hub')
const helper = join(state, 'hub-keep-awake.mjs')
const agents = join(home, 'Library/LaunchAgents')
const label = 'com.commando.hub'
const awakeLabel = `${label}.keep-awake`
const plist = join(agents, `${label}.plist`)
const awakePlist = join(agents, `${awakeLabel}.plist`)
const sudoers = '/etc/sudoers.d/commando-hub-keep-awake'
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const show = (command, argv = []) => [command, ...argv].map(quote).join(' ')
const say = (message) => console.log(message)

function probe(command, argv, env = process.env) {
  say(`CHECK ${show(command, argv)}`)
  const result = spawnSync(command, argv, { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 })
  return { ok: !result.error && result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, stdout: result.stdout ?? '' }
}
function run(command, argv = [], env = process.env) {
  say(`${dry ? 'PLAN' : 'RUN'} ${show(command, argv)}`)
  if (!dry) execFileSync(command, argv, { env, stdio: 'inherit' })
}
export function verifyKeepAwakePermissions(execute = run) {
  // Invalidate the installer's ticket before checking what launchd can do.
  execute('sudo', ['-k'])
  for (const value of ['1', '0']) {
    try { execute('sudo', ['-n', '-l', '/usr/bin/pmset', '-a', 'disablesleep', value]) } catch {
      throw new Error(`Keep-awake sudoers rule is not active: passwordless /usr/bin/pmset -a disablesleep ${value} was refused after sudo -k. Check ${sudoers} and the sudoers include configuration; setup stopped before starting the hub.`)
    }
  }
}
function redactConfig(config) {
  return config.replace(/^([\t ]*(?:export[\t ]+)?)([a-z_][a-z0-9_]*)([\t ]*=)[^\r\n]*/gim,
    (assignment, prefix, name, equals) => /TOKEN|KEY|SECRET|PASSWORD/i.test(name)
      ? `${prefix}${name}${equals}'<redacted>'` : assignment)
}
function write(path, content, mode = 0o600, atomic = true) {
  // Dry run shows secrets as placeholders, never existing or supplied tokens.
  const destination = atomic ? `${path}.new` : path
  say(`${dry ? 'PLAN write' : 'WRITE'} ${destination}${atomic ? ` -> ${path}` : ''} (mode ${mode.toString(8)})`)
  if (dry) { say(content); return }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(destination, content, { mode })
  chmodSync(destination, mode)
  if (atomic) renameSync(destination, path)
}
function remove(path) {
  say(`${dry ? 'PLAN remove' : 'REMOVE'} ${path}`)
  if (!dry) rmSync(path, { force: true })
}
function unload(service) {
  if (dry) { say(`PLAN if loaded: launchctl bootout ${service}; wait until unloaded (up to 10s)`); return }
  const loaded = () => spawnSync('launchctl', ['print', service], { stdio: 'ignore' }).status === 0
  if (!loaded()) return
  execFileSync('launchctl', ['bootout', service], { stdio: 'inherit' })
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!loaded()) return
    // No servers or background processes are started by this wait.
    execFileSync('sleep', ['0.2'])
  }
  throw new Error(`Could not unload ${service}; keep the sudoers rule until the watcher has stopped`)
}

function main() {
  say(`Commando hub ${uninstall ? 'uninstall' : 'setup'}${dry ? ' — DRY RUN (no writes or privileged commands)' : ''}`)
  const system = probe('uname', ['-s'])
  if (!system.ok || system.output.trim() !== 'Darwin') throw new Error('Hub setup requires macOS')
  const uid = probe('id', ['-u']).output.trim()
  const user = probe('id', ['-un']).output.trim()
  if (!/^\d+$/.test(uid) || uid === '0' || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(user)) throw new Error('Run as your regular macOS login user (not root)')
  const service = `gui/${uid}/${label}`
  const awakeService = `gui/${uid}/${awakeLabel}`
  const releaseEnv = { ...process.env, COMMANDO_RELEASE_LABEL: label, COMMANDO_RELEASE_STATE_DIR: state,
    COMMANDO_RELEASE_ENV_FILE: envFile, COMMANDO_HUB_LOG_DIR: logs }
  // Do not inherit an override that could redirect the hub daemon's executable.
  delete releaseEnv.COMMANDO_HUB_AGENT_SCRIPT

  if (uninstall) {
    run('sudo', ['-v'])
    unload(awakeService)
    run('launchctl', ['disable', awakeService])
    // Restore before deleting the permission, even if no watcher was loaded.
    run('sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', '0'])
    run('sudo', ['-n', '/bin/rm', '-f', sudoers])
    remove(awakePlist)
    remove(`${awakePlist}.new`)
    remove(helper)
    run('bash', [release, 'daemon-uninstall'], releaseEnv)
    if (dry) say(`PLAN DETAIL acquire ${state}/desktop-release.lock; disable/bootout ${service}; remove ${plist} and ${plist}.new`)
    say(`Kept ${envFile}, logs, checkout, sessions and credentials.`)
    return
  }

  let failed = false
  const check = (name, ok, detail = '') => {
    say(`${ok ? 'OK' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
    if (!ok) failed = true
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  check('Node', (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22,
    `${process.version} (requires 20.19+ on Node 20, or 22.12+)`)
  for (const [name, argv] of [['tmux', ['-V']], ['git', ['--version']], ['gh', ['auth', 'status']]]) {
    check(name, probe(name, argv).ok)
  }
  // command -v is a shell builtin and does not execute any privileged tools.
  for (const name of ['launchctl', 'plutil', ...(keepAwake ? ['pmset', 'sudo', 'visudo'] : [])]) {
    check(name, probe('bash', ['-c', 'command -v "$1"', 'hub-setup', name]).ok)
  }
  const tail = probe('tailscale', ['status', '--json'])
  let address
  try {
    const status = JSON.parse(tail.stdout)
    if (tail.ok && status.BackendState === 'Running' && status.Self?.Online !== false) {
      address = status.Self?.TailscaleIPs?.find((ip) => /^100\./.test(ip))
    }
  } catch { /* Report a disconnected CLI as a failed prerequisite below. */ }
  check('Tailscale CLI and connected tailnet', !!address)

  const profiles = readdirSync(home, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.name.startsWith('.claude')) return false
      try { return statSync(join(home, entry.name)).isDirectory() } catch { return false }
    }).map((entry) => entry.name).sort()
  if (!profiles.length) say('WARN Claude: no ~/.claude* config directories found')
  for (const profile of profiles) {
    const status = probe('claude', ['auth', 'status', '--json'], { ...process.env, CLAUDE_CONFIG_DIR: join(home, profile) })
    let loggedIn = false
    try { loggedIn = status.ok && JSON.parse(status.stdout).loggedIn === true } catch { /* Missing or old CLI. */ }
    say(`${loggedIn ? 'OK' : 'WARN'} Claude ${profile}: ${loggedIn ? 'logged in' : 'not logged in / status unavailable'}`)
  }
  for (const [name, argv] of [['codex', ['login', 'status']], ['agent', ['status']]]) {
    const status = probe(name, argv)
    const loggedIn = status.ok && /logged in|authenticated/i.test(status.output)
      && !/not logged in|not authenticated|unauthenticated/i.test(status.output)
    say(`${loggedIn ? 'OK' : 'WARN'} ${name === 'agent' ? 'Cursor' : 'Codex'}: ${loggedIn ? 'logged in' : 'not logged in / status unavailable'}`)
  }
  for (const path of ['node_modules/.bin/tsc', 'node_modules/.bin/vite', 'node_modules/.bin/tsx']) {
    check(path, existsSync(join(root, path)), 'install checkout dependencies yourself with npm ci if missing')
  }
  if (failed) throw new Error('Prerequisites failed. Nothing installed; fix the FAIL entries and rerun. Agent logins are reports only.')

  const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null
  const port = existing?.match(/^COMMANDO_PORT=['"]?(\d+)['"]?\s*$/m)?.[1] ?? process.env.COMMANDO_PORT ?? '4310'
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid COMMANDO_PORT')
  const token = process.env.COMMANDO_TOKEN
  if (token !== undefined && (!token || token.length > 1024 || /[\u0000-\u0020\u007f]/.test(token))) throw new Error('Invalid COMMANDO_TOKEN (must be nonempty and contain no whitespace)')
  let config = existing ?? `COMMANDO_PORT=${port}\nCOMMANDO_TOKEN=${quote(dry ? '<generated-or-supplied-token>' : token ?? randomBytes(24).toString('hex'))}\n`
  // Preserve the user's token and any extra daemon settings across reruns.
  config = config.replace(/^COMMANDO_TAILSCALE=.*\n?/gm, '').replace(/^COMMANDO_(?:RELEASE|HUB)_LOG_DIR=.*\n?/gm, '')
  config = `${config.trimEnd()}\nCOMMANDO_TAILSCALE=1\nCOMMANDO_HUB_LOG_DIR=${quote(logs)}\n`
  const rule = `${user} ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n`

  const render = (environment) => execFileSync('bash', [release, 'agent-plist'], { env: environment, encoding: 'utf8' })
  const daemonPlist = render(releaseEnv)
  const watcherEnv = { ...releaseEnv, COMMANDO_RELEASE_LABEL: awakeLabel, COMMANDO_HUB_AGENT_SCRIPT: helper,
    COMMANDO_HUB_LOG_DIR: join(state, 'logs/hub-keep-awake') }
  const watcherPlist = keepAwake ? render(watcherEnv) : null

  if (keepAwake) {
    // One authentication prompt; all subsequent root operations are noninteractive.
    say('Keep-awake installation needs one sudo authentication prompt (sudo -v).')
    const temp = dry ? '<temporary-directory>' : mkdtempSync(join(tmpdir(), 'commando-hub-'))
    const candidate = join(temp, 'sudoers')
    try {
      if (dry) say(`PLAN write ${candidate} (mode 600)\n${rule}`)
      else writeFileSync(candidate, rule, { mode: 0o600 })
      run('visudo', ['-cf', candidate])
      run('sudo', ['-v'])
      run('sudo', ['-n', '/usr/bin/install', '-d', '-m', '0755', '/etc/sudoers.d'])
      run('sudo', ['-n', '/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', '0440', candidate, sudoers])
      verifyKeepAwakePermissions()
    } finally {
      if (dry) say(`PLAN remove ${candidate} and ${temp}`)
      else rmSync(temp, { recursive: true, force: true })
    }
  }
  write(envFile, dry ? redactConfig(config) : config)
  if (dry) say(`PLAN DETAIL acquire ${state}/desktop-release.lock; mkdir ${logs}; build with tsc -b and vite into ${root}/.dist-staging; replace ${root}/dist (generated assets); update node_modules/.tmp/*.tsbuildinfo`)
  if (dry) {
    write(plist, daemonPlist)
    say(`PLAN lint ${plist}.new with plutil; bootout ${service} if loaded; install plist; enable/bootstrap; wait for HTTP health check`)
    say(`PLAN logs ${logs}/daemon.log (rotate to .1 above 20 MiB), ${logs}/daemon-launchd.log`)
  }
  run('bash', [release, 'daemon-install'], releaseEnv)
  if (keepAwake) {
    write(`${awakePlist}.new`, watcherPlist, 0o600, false)
    run('plutil', ['-lint', `${awakePlist}.new`])
    unload(awakeService)
    write(helper, readFileSync(join(root, 'scripts/hub-keep-awake.mjs'), 'utf8'), 0o700)
    say(`${dry ? 'PLAN' : 'RUN'} rename ${awakePlist}.new -> ${awakePlist}`)
    if (!dry) renameSync(`${awakePlist}.new`, awakePlist)
    const watcherLogs = join(state, 'logs/hub-keep-awake')
    say(`${dry ? 'PLAN' : 'RUN'} mkdir ${watcherLogs}; logs ${watcherLogs}/daemon-launchd.log`)
    if (!dry) mkdirSync(watcherLogs, { recursive: true })
    run('launchctl', ['enable', awakeService])
    run('launchctl', ['bootstrap', `gui/${uid}`, awakePlist])
    say('Watcher: pmset -g ps every 30s; AC -> sudo -n /usr/bin/pmset -a disablesleep 1; battery/unknown/stop -> 0; only on changes.')
  } else {
    say('Keep-awake skipped; an existing watcher/rule is preserved. Use --uninstall to remove them.')
  }
  say(`Hub Tailscale URL: http://${address}:${port}/`)
  say(`Token: use COMMANDO_TOKEN in ${envFile} (0600); on the hub: bash -c ${quote(`source ${quote(envFile)}; printf '%s\\n' "$COMMANDO_TOKEN"`)}`)
  say('Open the URL with #token=<URL-encoded-token>. In the authenticated sidebar, Pair a phone creates a single-use, two-minute QR code; the companion receives its own revocable device token.')
  say('Connect from your MacBook: open that URL over Tailscale. Multi-host UI/proxy support is a separate change. Login items require a logged-in user (not a pre-login boot service).')
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    console.error(`hub-setup: ${error.message}`)
    process.exitCode = 1
  }
}

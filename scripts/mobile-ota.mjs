#!/usr/bin/env node
// Continuous delivery for the companion app: when local `next` moves and the
// change touches the mobile app (apps/mobile or shared/), check it and publish
// an EAS Update to the `production` channel the phone listens on.
//
//   node scripts/mobile-ota.mjs install     # LaunchAgent that watches `next`
//   node scripts/mobile-ota.mjs baseline <commit>   # the commit a new native build was made from
//   node scripts/mobile-ota.mjs run [--force]
//   node scripts/mobile-ota.mjs status | uninstall
//
// An update only carries JavaScript. One that expects native code the
// installed build lacks crashes on launch, so every run compares the project's
// native fingerprint (and runtime version) with the baseline recorded for the
// installed build, and skips with a notification when they differ.
//
// It publishes from its own detached worktree (`../commando-mobile-ota`),
// never touching the checkouts people work in. `next` itself is only read.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'com.commando.mobile-ota'
const BRANCH = 'next'
const WATCHED = ['apps/mobile', 'shared']
const CHANNEL = 'production'
const POLL_SECONDS = 900
// Pinned: an unattended production publish must not pick up a new CLI release.
const EAS_CLI = 'eas-cli@27.10.0'

const home = homedir()
const commandoDir = join(home, '.commando')
export const STATE_PATH = join(commandoDir, 'mobile-ota.json')
const LOG_PATH = join(commandoDir, 'logs', 'mobile-ota.log')
const LOCK_PATH = join(commandoDir, 'mobile-ota.lock')
const PLIST_PATH = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
const LAUNCHER_PATH = join(commandoDir, 'bin', 'mobile-ota-launch')

// ---------------------------------------------------------------------------
// Pure decisions (unit-tested in mobile-ota.test.ts)

/**
 * What a run does with `next` at `sha`, given the state and what git says.
 * `changedMobile` is null when there is no last publish to compare against
 * (or it is no longer an ancestor), which always counts as a change.
 */
export function planRun({ sha, state, changedMobile, force = false }) {
  if (!force && state.lastSeen === sha) return { action: 'idle', reason: 'next has not moved' }
  if (!force && state.lastPublished === sha) return { action: 'idle', reason: 'already published' }
  if (!force && changedMobile === false) return { action: 'skip', reason: 'no mobile changes since the last publish' }
  return { action: 'check' }
}

/** Whether the code at `sha` can run on the installed build. */
export function nativeVerdict(baseline, current) {
  if (!baseline) return { ok: false, reason: 'No native baseline is recorded. Run `node scripts/mobile-ota.mjs baseline` once the installed build matches next.' }
  if (baseline.runtime !== current.runtime) {
    return { ok: false, reason: `Runtime version is ${current.runtime} but the installed build is ${baseline.runtime}. Build and install ${current.runtime}, then run baseline <its commit>.` }
  }
  if (baseline.fingerprint !== current.fingerprint) {
    return { ok: false, reason: 'Native code changed since the installed build. Bump expo.version in apps/mobile/app.json, build and install the new app, then run baseline <its commit>.' }
  }
  return { ok: true }
}

/**
 * Whether a new baseline may replace the old one. A different native
 * fingerprint under the same runtime version would let updates meant for the
 * new build reach every older build of that version, which then crash.
 */
export function baselineVerdict(previous, next) {
  if (previous && previous.runtime === next.runtime && previous.fingerprint !== next.fingerprint) {
    return { ok: false, reason: `Native code differs from the ${previous.runtime} baseline but the runtime version is still ${next.runtime}. Bump expo.version before building, so older builds stop receiving these updates.` }
  }
  return { ok: true }
}

/** The update's message: the short sha and the mobile commits it brings. */
export function updateMessage(shortSha, subjects) {
  const body = subjects.length ? subjects.slice(0, 4).join('; ') + (subjects.length > 4 ? `; +${subjects.length - 4} more` : '') : 'mobile changes'
  const message = `next ${shortSha}: ${body}`
  return message.length > 480 ? `${message.slice(0, 479)}…` : message
}

/** The update group id `eas update` prints. */
export function parseUpdateGroup(output) {
  return /Update group ID\s+([0-9a-f-]{36})/.exec(output)?.[1]
}

// ---------------------------------------------------------------------------
// Effects

function log(line) {
  mkdirSync(dirname(LOG_PATH), { recursive: true })
  const stamped = `${new Date().toISOString()} ${line}`
  appendFileSync(LOG_PATH, `${stamped}\n`)
  process.stdout.write(`${stamped}\n`)
}

function notify(title, message) {
  const quote = (text) => JSON.stringify(String(text).slice(0, 400))
  spawnSync('osascript', ['-e', `display notification ${quote(message)} with title ${quote(title)}`], { stdio: 'ignore' })
}

export function readState(path = STATE_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

function writeState(next) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(`${STATE_PATH}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${STATE_PATH}.tmp`, STATE_PATH)
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitOk(cwd, ...args) {
  return spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore' }).status === 0
}

/** Runs a command, streaming into the log; returns its output and whether it passed. */
function step(cwd, command, args, { timeoutMs = 20 * 60_000 } = {}) {
  log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: '1' }, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  appendFileSync(LOG_PATH, output.split('\n').slice(-60).map((line) => `    ${line}`).join('\n') + '\n')
  return { ok: result.status === 0, output }
}

const here = dirname(fileURLToPath(import.meta.url))

/** The main checkout (the git common dir's parent) and this tool's worktree beside it. */
function locations() {
  const commonDir = git(here, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const mainCheckout = dirname(commonDir)
  return { commonDir, mainCheckout, worktree: join(dirname(mainCheckout), 'commando-mobile-ota') }
}

function ensureWorktree({ mainCheckout, worktree }, sha) {
  if (!existsSync(join(worktree, '.git'))) {
    log(`creating worktree ${worktree}`)
    git(mainCheckout, 'worktree', 'add', '--detach', worktree, sha)
    // Locked, so worktree cleanups leave it (and its installed dependencies) alone.
    git(mainCheckout, 'worktree', 'lock', '--reason', 'mobile OTA continuous delivery (scripts/mobile-ota.mjs)', worktree)
  } else {
    git(worktree, 'checkout', '--quiet', '--detach', '--force', sha)
    git(worktree, 'clean', '-fdq')
  }
}

function lockHash(worktree) {
  const hash = createHash('sha256')
  for (const file of ['package-lock.json', 'apps/mobile/package-lock.json']) hash.update(readFileSync(join(worktree, file)))
  return hash.digest('hex').slice(0, 16)
}

function installDependencies(worktree, state) {
  const wanted = lockHash(worktree)
  const present = existsSync(join(worktree, 'node_modules')) && existsSync(join(worktree, 'apps/mobile/node_modules'))
  if (present && state.lockHash === wanted) return { ok: true, lockHash: wanted }
  // shared/*.ts resolve their Babel helpers from the root, so both installs are needed.
  for (const cwd of [worktree, join(worktree, 'apps/mobile')]) {
    if (!step(cwd, 'npm', ['ci', '--no-audit', '--no-fund']).ok) return { ok: false }
  }
  return { ok: true, lockHash: wanted }
}

function nativeIdentity(mobileDir) {
  const runtime = JSON.parse(readFileSync(join(mobileDir, 'app.json'), 'utf8')).expo.version
  const printed = execFileSync('npx', ['@expo/fingerprint', '.'], { cwd: mobileDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  return { runtime, fingerprint: JSON.parse(printed).hash }
}

function withLock(work) {
  mkdirSync(commandoDir, { recursive: true })
  try {
    const holder = Number(readFileSync(LOCK_PATH, 'utf8'))
    if (holder && holder !== process.pid) {
      try { process.kill(holder, 0); log(`another run (pid ${holder}) is in progress`); return } catch { /* stale */ }
    }
  } catch { /* no lock */ }
  writeFileSync(LOCK_PATH, String(process.pid))
  try { return work() } finally { rmSync(LOCK_PATH, { force: true }) }
}

function run({ force }) {
  const where = locations()
  const sha = git(where.mainCheckout, 'rev-parse', `refs/heads/${BRANCH}`)
  try {
    publishIfNeeded(where, sha, force)
  } catch (error) {
    // Recorded against this commit, so the poll doesn't alert again until next moves.
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
    log(`${sha.slice(0, 8)}: error — ${reason}`)
    notify('Commando app update failed', `next ${sha.slice(0, 8)}: ${reason}`)
    writeState({ ...readState(), lastSeen: sha, lastResult: { sha, at: new Date().toISOString(), status: 'error', reason } })
  }
}

function publishIfNeeded(where, sha, force) {
  const short = sha.slice(0, 8)
  const state = readState()
  const base = state.lastPublished
  const comparable = base && gitOk(where.mainCheckout, 'merge-base', '--is-ancestor', base, sha)
  const changedMobile = comparable ? !gitOk(where.mainCheckout, 'diff', '--quiet', base, sha, '--', ...WATCHED) : null
  const plan = planRun({ sha, state, changedMobile, force })
  if (plan.action === 'idle') return
  const seen = (result) => writeState({ ...readState(), lastSeen: sha, lastResult: { sha, at: new Date().toISOString(), ...result } })
  if (plan.action === 'skip') { log(`${short}: ${plan.reason}`); seen({ status: 'skipped', reason: plan.reason }); return }

  const fail = (reason) => {
    log(`${short}: not published — ${reason}`)
    notify('Commando app update not published', `next ${short}: ${reason}`)
    seen({ status: 'blocked', reason })
  }

  log(`${short}: checking for an app update`)
  ensureWorktree(where, sha)
  const mobileDir = join(where.worktree, 'apps/mobile')
  const deps = installDependencies(where.worktree, state)
  if (!deps.ok) return fail('npm ci failed (see ~/.commando/logs/mobile-ota.log)')
  writeState({ ...readState(), lockHash: deps.lockHash })

  const verdict = nativeVerdict(state.baseline, nativeIdentity(mobileDir))
  if (!verdict.ok) return fail(verdict.reason)

  if (!step(mobileDir, 'npx', ['tsc', '--noEmit']).ok) return fail('the mobile typecheck failed')
  // One retry: a suite can time out on a busy Mac.
  if (!step(mobileDir, 'npx', ['jest', '--silent']).ok && !step(mobileDir, 'npx', ['jest', '--silent']).ok) return fail('the mobile tests failed')

  const subjects = comparable
    ? git(where.mainCheckout, 'log', '--no-merges', '--format=%s', `${base}..${sha}`, '--', ...WATCHED).split('\n').filter(Boolean)
    : []
  const message = updateMessage(short, subjects)
  const published = step(mobileDir, 'npx', ['-y', EAS_CLI, 'update', '--channel', CHANNEL, '--environment', CHANNEL, '--platform', 'ios', '--message', message, '--non-interactive'])
  if (!published.ok) return fail('eas update failed')
  const group = parseUpdateGroup(published.output)
  log(`${short}: published ${group ?? '(group id not found)'} — ${message}`)
  notify('Commando app updated', `${message}\nRestart the app to load it.`)
  writeState({ ...readState(), lastSeen: sha, lastPublished: sha, lastUpdateGroup: group, lastResult: { sha, at: new Date().toISOString(), status: 'published', group } })
}

function baseline({ commit, force }) {
  if (!commit) throw new Error('usage: mobile-ota.mjs baseline <commit the installed build was made from>')
  const where = locations()
  const sha = git(where.mainCheckout, 'rev-parse', '--verify', `${commit}^{commit}`)
  ensureWorktree(where, sha)
  const deps = installDependencies(where.worktree, readState())
  if (!deps.ok) throw new Error('npm ci failed; see ~/.commando/logs/mobile-ota.log')
  const identity = nativeIdentity(join(where.worktree, 'apps/mobile'))
  const verdict = baselineVerdict(readState().baseline, identity)
  if (!verdict.ok && !force) throw new Error(`${verdict.reason} (--force records it anyway)`)
  writeState({ ...readState(), lockHash: deps.lockHash, baseline: { ...identity, commit: sha, recordedAt: new Date().toISOString() } })
  log(`baseline: runtime ${identity.runtime}, fingerprint ${identity.fingerprint} at ${sha.slice(0, 8)}`)
}

function install() {
  const where = locations()
  const sha = git(where.mainCheckout, 'rev-parse', `refs/heads/${BRANCH}`)
  ensureWorktree(where, sha)
  const script = join(where.worktree, 'scripts', 'mobile-ota.mjs')
  if (!existsSync(script)) throw new Error(`${BRANCH} does not contain scripts/mobile-ota.mjs yet; integrate it first`)
  const node = process.execPath
  const path = [dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
  // A fixed launcher, so a removed worktree, an uninstalled Node or a broken
  // script on next still raises a notification instead of failing silently.
  const shell = (text) => `'${text.replace(/'/g, `'\\''`)}'`
  mkdirSync(dirname(LAUNCHER_PATH), { recursive: true })
  writeFileSync(LAUNCHER_PATH, `#!/bin/sh
SCRIPT=${shell(script)}
NODE=${shell(node)}
[ -x "$NODE" ] || NODE=$(command -v node)
alert() { /usr/bin/osascript -e "display notification \"$1\" with title \"Commando app CD stopped\""; echo "$(date -u +%FT%TZ) launcher: $1" >> ${shell(LOG_PATH)}; exit 1; }
[ -n "$NODE" ] || alert "No node binary found. Re-run: node scripts/mobile-ota.mjs install"
[ -f "$SCRIPT" ] || alert "The CD worktree is missing. Re-run: node scripts/mobile-ota.mjs install"
"$NODE" "$SCRIPT" run
STATUS=$?
# 0: done; 3: a failure the script already reported. Anything else is a crash.
[ $STATUS -eq 0 ] || [ $STATUS -eq 3 ] || alert "mobile-ota.mjs exited with $STATUS (see ~/.commando/logs/mobile-ota.launchd.log)"
`, { mode: 0o755 })
  const xml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const strings = (items) => items.map((item) => `    <string>${xml(item)}</string>`).join('\n')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([LAUNCHER_PATH])}
  </array>
  <key>WatchPaths</key>
  <array>
${strings([join(where.commonDir, 'refs', 'heads', BRANCH), join(where.commonDir, 'packed-refs')])}
  </array>
  <key>StartInterval</key><integer>${POLL_SECONDS}</integer>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>HOME</key><string>${xml(home)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(join(commandoDir, 'logs', 'mobile-ota.launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(commandoDir, 'logs', 'mobile-ota.launchd.log'))}</string>
</dict>
</plist>
`
  mkdirSync(dirname(PLIST_PATH), { recursive: true })
  mkdirSync(join(commandoDir, 'logs'), { recursive: true })
  writeFileSync(PLIST_PATH, plist)
  execFileSync('plutil', ['-lint', PLIST_PATH], { stdio: 'inherit' })
  const domain = `gui/${process.getuid()}`
  spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' })
  execFileSync('launchctl', ['bootstrap', domain, PLIST_PATH], { stdio: 'inherit' })
  log(`installed ${PLIST_PATH}: watches ${BRANCH}, runs ${script} through ${LAUNCHER_PATH}`)
  if (!readState().baseline) log('no native baseline yet: run `node scripts/mobile-ota.mjs baseline <commit the installed build was made from>`')
}

function uninstall() {
  spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' })
  rmSync(PLIST_PATH, { force: true })
  log('uninstalled the LaunchAgent (the worktree and state are kept)')
}

function status() {
  const loaded = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }).status === 0
  process.stdout.write(`${JSON.stringify({ loaded, plist: existsSync(PLIST_PATH) ? PLIST_PATH : null, log: LOG_PATH, state: readState() }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'run', ...flags] = process.argv.slice(2)
  const force = flags.includes('--force')
  const commit = flags.find((flag) => !flag.startsWith('--'))
  const commands = {
    run: () => withLock(() => run({ force })),
    baseline: () => withLock(() => baseline({ commit, force })),
    install: () => withLock(install),
    uninstall,
    status,
  }
  if (!commands[command]) {
    process.stderr.write(`usage: mobile-ota.mjs ${Object.keys(commands).join('|')} [--force]\n`)
    process.exit(2)
  }
  try {
    commands[command]()
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message : String(error)}`)
    if (command === 'run') notify('Commando app update failed', error instanceof Error ? error.message : String(error))
    // 3 tells the launcher this failure was already reported.
    process.exit(3)
  }
}

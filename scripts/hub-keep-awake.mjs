#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Unknown or unreadable power state must permit sleep. Do not mistake a battery
// that's charging for AC: use pmset's current source, not the battery detail.
export function sleepDisabled(powerOutput) {
  return /^Now drawing from 'AC Power'\s*$/m.test(powerOutput) ? 1 : 0
}

export function powerWatcher(run = execFileSync, report = console.log) {
  let previous
  function apply(value) {
    if (value === previous) return
    run('sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', String(value)], { timeout: 8000, stdio: 'pipe' })
    previous = value // Failed changes are retried on the next tick.
    report(`disablesleep ${value}`)
  }
  return {
    update: (output) => apply(sleepDisabled(output)),
    stop: () => apply(0),
  }
}

// The shared LaunchAgent renderer passes "daemon" to its executable.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const once = args.includes('--once')
  const fileIndex = args.indexOf('--ps-output')
  if (args.some((arg, index) => !['daemon', '--once', '--ps-output'].includes(arg) && !(fileIndex >= 0 && index === fileIndex + 1))
      || (fileIndex >= 0 && (!once || !args[fileIndex + 1]))) {
    console.error('Usage: hub-keep-awake.mjs [--once --ps-output <file>]')
    process.exit(2)
  }
  const watcher = powerWatcher()
  const tick = () => {
    let output = ''
    try {
      output = fileIndex >= 0 ? readFileSync(args[fileIndex + 1], 'utf8')
        : execFileSync('pmset', ['-g', 'ps'], { encoding: 'utf8', timeout: 8000 })
    } catch { console.error('Cannot read power source; allowing sleep') }
    try { watcher.update(output) } catch { console.error('Cannot set disablesleep; check the hub sudoers rule'); process.exitCode = 1 }
  }
  if (!once) {
    let timer
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => {
      clearInterval(timer)
      try { watcher.stop(); process.exit(0) } catch { console.error('Failed to restore disablesleep 0'); process.exit(1) }
    })
    // Install cleanup before the first potentially blocking sudo invocation.
    tick()
    timer = setInterval(tick, 30_000)
  } else tick()
}

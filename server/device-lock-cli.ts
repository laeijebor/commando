/**
 * Source of `~/.commando/hooks/commando-device.mjs`, the CLI agents and scripts use to take device locks.
 * Exit codes: 0 when the lock is held (or the command succeeded), 3 when still queued or only offered, 1 on errors.
 */
export function generatedDeviceCli(tokenPath: string): string {
  return `#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const defaultTokenPath = ${JSON.stringify(tokenPath)}
` + String.raw`
const USAGE = [
  'Usage: commando-device.mjs list | status',
  '  lock <device|any|any-phone|any-android|any-ios> --task "what you are doing" [--as NAME] [--estimate 15m] [--wait [max]] [--pid PID]',
  '  claim [device] | release [device] | cancel [device]   (each with the same --as NAME / --pid PID as the lock)',
  '  resource add <id> --name "Pixel 5" --kind android|ios|emulator|host [--serial S] [--release "steps"] [--busy "xcodebuild"]...',
  '  resource remove <id>',
  'Add --json for machine-readable output.',
].join('\n')
const usage = () => { throw new Error(USAGE) }

export function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(String(value ?? ''))
  if (!match) throw new Error('Durations look like 90s, 15m or 2h')
  return Math.round(Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] ?? 'm'])
}

/** Splits argv into positionals and flags; repeated --busy flags collect into a list. */
export function parseDeviceArgs(args) {
  const positional = [], flags = {}
  const valued = new Set(['--task', '--as', '--estimate', '--pid', '--name', '--kind', '--serial', '--release', '--busy'])
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--json') flags.json = true
    else if (arg === '--wait') {
      const next = args[index + 1]
      flags.wait = true
      if (next !== undefined && /^\d/.test(next)) { flags.maxWaitMs = parseDuration(next); index++ }
    } else if (valued.has(arg)) {
      const value = args[++index]
      if (value === undefined) usage()
      if (arg === '--busy') (flags.busy ??= []).push(value)
      else flags[arg.slice(2)] = value
    } else if (arg.startsWith('--')) usage()
    else positional.push(arg)
  }
  const [command, ...rest] = positional
  const owner = { ...(flags.as ? { as: flags.as } : {}), ...(flags.pid ? { pid: Number(flags.pid) } : {}) }
  if (flags.pid && !/^\d+$/.test(flags.pid)) throw new Error('--pid must be a process id, e.g. --pid $$')
  if ((command === 'list' || command === 'status') && !rest.length) return { command, json: !!flags.json }
  if (command === 'lock' && rest.length === 1) {
    if (!flags.task) throw new Error('lock needs --task "what you are doing"')
    return { command, json: !!flags.json, wait: !!flags.wait, maxWaitMs: flags.maxWaitMs,
      body: { request: rest[0], task: flags.task, mode: flags.wait ? 'wait' : 'notify', ...owner, ...(flags.estimate ? { estimateMs: parseDuration(flags.estimate) } : {}) } }
  }
  if (['claim', 'release', 'cancel'].includes(command) && rest.length <= 1) return { command, json: !!flags.json, body: { ...(rest[0] ? { request: rest[0] } : {}), ...owner } }
  if (command === 'resource' && rest[0] === 'add' && rest.length === 2) {
    return { command: 'resource-add', json: !!flags.json, body: { id: rest[1], name: flags.name, kind: flags.kind,
      ...(flags.serial ? { serial: flags.serial } : {}), ...(flags.release ? { release: flags.release } : {}), ...(flags.busy ? { busyProcesses: flags.busy } : {}) } }
  }
  if (command === 'resource' && rest[0] === 'remove' && rest.length === 2) return { command: 'resource-remove', json: !!flags.json, body: { id: rest[1] } }
  return usage()
}

const minutes = (ms) => ms < 60_000 ? '<1m' : ms < 3_600_000 ? Math.round(ms / 60_000) + 'm' : (ms / 3_600_000).toFixed(1).replace(/\.0$/, '') + 'h'
const who = (owner) => owner.as ? owner.as + ' (' + owner.sessionName + ')' : owner.sessionName
const describeHolder = (holder, now) => who(holder) + ': ' + holder.task + ' (' + minutes(now - holder.acquiredAt) + (holder.estimateMs ? ' of est. ' + minutes(holder.estimateMs) : '') + ')'

export function formatResult(result, cli, now = Date.now()) {
  const as = result.holder?.as ?? result.entry?.as
  const pid = result.holder?.pid ?? result.entry?.pid
  // A script's lock belongs to its process, so its release command must name it too.
  const asFlag = (as ? ' --as ' + JSON.stringify(as) : '') + (pid ? ' --pid ' + pid : '')
  if (result.status === 'held') {
    const { resource } = result
    return ['held ' + resource.name + ' (' + resource.id + ')' + (resource.serial ? ' · serial ' + resource.serial : ''),
      ...(resource.release ? ['Before releasing: ' + resource.release + '.'] : []),
      'Release with: ' + cli + ' release ' + resource.id + asFlag].join('\n')
  }
  if (result.status === 'offered') return 'offered ' + result.resource.name + ' is yours: claim it now with ' + cli + ' claim ' + result.resource.id + asFlag
  const lines = ['queued #' + result.position + ' for ' + result.entry.request]
  for (const holder of result.holders ?? []) lines.push('Held by ' + describeHolder(holder, now))
  for (const entry of result.offered ?? []) lines.push('Offered to ' + who(entry) + ', waiting for them to claim it')
  if (result.waitingFor) lines.push('Waiting for ' + result.waitingFor + ' to finish')
  if (result.entry.mode === 'notify') lines.push('Commando will message this pane when it is your turn. Do other work or end your turn; do not touch the device until then.')
  return lines.join('\n')
}

export function formatList(view, now = Date.now()) {
  if (!view.resources.length) return 'No device locks yet. Add one with: commando-device.mjs resource add <id> --name "Pixel 5" --kind android --serial <serial>'
  return view.resources.map((resource) => {
    const holders = view.holders.filter((holder) => holder.resourceId === resource.id)
    const queue = view.queue.filter((entry) => entry.resourceIds.includes(resource.id))
    const offer = queue.find((entry) => entry.offer?.resourceId === resource.id)
    const state = view.paused.includes(resource.id) ? 'paused' : holders.length ? 'held' : offer ? 'offered' : 'free'
    return [resource.id + ' · ' + resource.name + ' · ' + state + (view.waitingFor?.[resource.id] ? ' · busy: ' + view.waitingFor[resource.id] : ''),
      ...holders.map((holder) => '  ' + 'holding'.padEnd(9) + describeHolder(holder, now)),
      ...queue.map((entry) => '  ' + (entry.offer?.resourceId === resource.id ? 'offered' : '#' + entry.position).padEnd(9) + who(entry) + ': ' + entry.task +
        (entry.request !== resource.id ? ' [' + entry.request + ']' : '') + (entry.mode === 'wait' ? ' [script]' : '') + ' · waiting ' + minutes(now - entry.enqueuedAt))].join('\n')
  }).join('\n')
}

export async function runDeviceCli(args, request, { out = (text) => console.log(text), err = (text) => console.error(text), cli = 'node ~/.commando/hooks/commando-device.mjs', now = Date.now, reconnectMs = 120_000, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onSignal = (handler) => { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, handler) } } = {}) {
  const input = parseDeviceArgs(args)
  const print = (value, text) => out(input.json ? JSON.stringify(value) : text)
  const call = async (method, path, body) => {
    const response = await request(method, path, body)
    if (response.status >= 400) throw new Error(response.result?.error ?? ('Commando returned ' + response.status))
    return response.result
  }
  if (input.command === 'list' || input.command === 'status') {
    const view = await call('GET', '')
    if (input.command === 'list') { print(view, formatList(view, now())); return 0 }
    const mine = await call('GET', '/mine')
    print(mine, mine.holders.length || mine.queue.length ? formatList({ ...view, resources: view.resources.filter((resource) =>
      mine.holders.some((holder) => holder.resourceId === resource.id) || mine.queue.some((entry) => entry.resourceIds.includes(resource.id))) }, now()) : 'This pane holds no device locks and is not queued.')
    return 0
  }
  if (input.command === 'resource-add') { const result = await call('POST', '/resources', input.body); print(result, 'added ' + result.resource.id); return 0 }
  if (input.command === 'resource-remove') { const result = await call('DELETE', '/resources', input.body); print(result, 'removed ' + input.body.id); return 0 }
  if (input.command === 'release') { const result = await call('POST', '/release', input.body); print(result, 'released ' + result.released.map((holder) => holder.resourceId).join(', ')); return 0 }
  if (input.command === 'cancel') { const result = await call('POST', '/cancel', input.body); print(result, 'left the queue for ' + result.cancelled.map((entry) => entry.request).join(', ')); return 0 }
  if (input.command === 'claim') { const result = await call('POST', '/claim', input.body); print(result, formatResult(result, cli, now())); return 0 }
  let result = await call('POST', '/lock', input.body)
  if (!input.wait || result.status === 'held') { print(result, formatResult(result, cli, now())); return result.status === 'held' ? 0 : 3 }
  // Block until granted, telling the caller when its place changes.
  const started = now()
  const entryId = result.entry.id
  let settled = false
  // Withdraw by id: if the lock was granted just as we gave up, that releases it rather than leaving it held.
  const withdraw = async () => { if (!settled) { settled = true; await call('POST', '/cancel', { entryId }).catch(() => {}) } }
  onSignal(() => { void withdraw().finally(() => process.exit(130)) })
  let last = ''
  let failingSince
  try {
    while (result.status !== 'held') {
      if (result.status === 'gone') { settled = true; err('The request left the queue (cancelled or removed by the user).'); return 3 }
      if (result.status === 'offered') { result = await call('POST', '/claim', { request: input.body.request, ...(input.body.as ? { as: input.body.as } : {}), ...(input.body.pid ? { pid: input.body.pid } : {}) }); continue }
      const progress = formatResult(result, cli, now()).split('\n').join(' · ')
      if (progress !== last) { err('waiting: ' + progress); last = progress }
      const remaining = input.maxWaitMs === undefined ? 55_000 : input.maxWaitMs - (now() - started)
      if (remaining <= 0) { await withdraw(); err('Gave up waiting after ' + minutes(input.maxWaitMs) + '.'); return 3 }
      try {
        result = await call('GET', '/entry?id=' + encodeURIComponent(entryId) + '&wait=' + Math.max(1, Math.min(55, Math.ceil(remaining / 1_000))))
        failingSince = undefined
      } catch (error) {
        // The daemon restarts now and then (e.g. after a merge); keep the place in line while it comes back.
        failingSince ??= now()
        if (now() - failingSince > reconnectMs) throw error
        err('Commando is unreachable (' + (error instanceof Error ? error.message : error) + '); retrying…')
        await pause(Math.min(10_000, 1_000 + (now() - failingSince) / 4))
      }
    }
    settled = true
  } finally { await withdraw() }
  print(result, formatResult(result, cli, now()))
  return 0
}

export async function deviceRequest(env = process.env, fetchRequest = fetch, read = readFile) {
  const paneId = env.TMUX_PANE
  if (!/^%\d+$/.test(paneId ?? '')) throw new Error('TMUX_PANE must identify the current pane; run this inside a Commando tmux pane')
  const port = Number(env.COMMANDO_PORT ?? '4310')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('COMMANDO_PORT is invalid')
  const token = (await read(env.COMMANDO_AGENT_HOOK_TOKEN_PATH ?? defaultTokenPath, 'utf8')).trim()
  return async (method, path, body) => {
    const response = await fetchRequest('http://127.0.0.1:' + port + '/api/device-locks' + path, {
      method, headers: { Authorization: 'Bearer ' + token, 'X-Commando-Pane': paneId, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(70_000),
    })
    const result = await response.json().catch(() => ({ error: 'Commando returned invalid JSON' }))
    return { status: response.status, result }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { process.exitCode = await runDeviceCli(process.argv.slice(2), await deviceRequest(), { cli: 'node ' + JSON.stringify(realpathSync(process.argv[1])) }) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
`
}

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { readJson, writeJson } from './device-lock-api.js'
import { DeviceLockError, type DeviceLockRegistry } from './device-locks.js'
import type { SwitchableLockStore } from './device-lock-store.js'
import { FarmClient, FarmLockStore } from './farm-lock-store.js'

/**
 * Settings > Device farm. Commando's device locks can run on device farms instead of Commando's built-in queue:
 * this Mac's own farm (a launchd service on 127.0.0.1, managed from here), plus optionally a remote farm whose
 * devices appear alongside. Moving over is a switch the user asks for; it happens once nothing is held or queued,
 * so no agent loses a lock on the way.
 */

export type DeviceFarmSettings = {
  /** Which queue Commando's device locks use now. */
  use: 'builtin' | 'farm'
  /** A switch the user asked for, waiting for the current queue to be empty. */
  switching?: 'farm' | 'builtin'
  local: { checkout?: string; url: string; token?: string; config: string }
  remote?: { url: string; token: string }
}

const LOCAL_PORT = 4500
const FARM_ID = /^[a-z][a-z0-9-]{0,31}$/
type Run = (args: string[], env: Record<string, string>) => Promise<string>

export function defaultDeviceFarmSettingsPath(port: number): string {
  return process.env.COMMANDO_DEVICE_FARM_PATH ?? join(homedir(), '.commando', `device-farm-${port}.json`)
}

function defaults(): DeviceFarmSettings {
  return { use: 'builtin', local: { url: `http://127.0.0.1:${LOCAL_PORT}`, config: join(homedir(), '.device-farm', 'config.json') } }
}

export class DeviceFarmController {
  private settings: DeviceFarmSettings
  private farm?: FarmLockStore
  private timer?: ReturnType<typeof setInterval>
  private setupRunning?: Promise<unknown>
  private ticking?: Promise<void>
  private lastError?: string
  /** This daemon's identity on the farm: several Commando daemons (a test one on another port) can share one farm. */
  private readonly engineer: string
  private readonly sessionPrefix: string
  private readonly path: string
  private readonly store: SwitchableLockStore
  private readonly builtin: DeviceLockRegistry
  private readonly commandoLocksPath: string
  private readonly run: Run
  private readonly fetcher: typeof fetch

  constructor(options: { path: string; store: SwitchableLockStore; builtin: DeviceLockRegistry; commandoLocksPath: string; daemonPort: number; run?: Run; fetcher?: typeof fetch }) {
    this.path = options.path
    this.engineer = `commando-${options.daemonPort}`
    this.sessionPrefix = `cmd${options.daemonPort}:`
    this.store = options.store
    this.builtin = options.builtin
    this.commandoLocksPath = options.commandoLocksPath
    this.fetcher = options.fetcher ?? fetch
    this.run = options.run ?? ((args, env) => new Promise((resolve, reject) => {
      execFile(process.execPath, args, { env: { ...process.env, ...env }, timeout: 60_000 }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim().split('\n').pop())) : resolve(stdout))
    }))
    this.settings = this.load()
  }

  /** Commando starts on whatever queue was in use last time. */
  start(): void {
    // Straight onto the farm store, even before it has read the farm: until then it answers lock calls with "not
    // answering, try again" (503), rather than the built-in queue handing out devices the farm doesn't know about.
    if (this.settings.use === 'farm') void this.useFarm()
    this.timer = setInterval(() => { void this.tick() }, 5_000)
    this.timer.unref()
  }

  stop(): void { clearInterval(this.timer); this.farm?.stop() }

  // ---- HTTP: /api/device-farm (owner credentials, like /api/devices) ----

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname
    if (path !== '/api/device-farm' && !path.startsWith('/api/device-farm/')) return false
    try {
      if (path === '/api/device-farm' && request.method === 'GET') writeJson(response, 200, await this.status())
      else if (path === '/api/device-farm/local/setup' && request.method === 'POST') {
        const body = await readJson(request)
        writeJson(response, 200, await this.setupLocal(typeof body.checkout === 'string' && body.checkout ? body.checkout : undefined))
      } else if (path === '/api/device-farm/remote' && request.method === 'POST') writeJson(response, 200, await this.setRemote(await readJson(request)))
      else if (path === '/api/device-farm/remote' && request.method === 'DELETE') writeJson(response, 200, await this.setRemote(undefined))
      else if (path === '/api/device-farm/switch' && request.method === 'POST') {
        const body = await readJson(request)
        if (body.to !== 'farm' && body.to !== 'builtin' && body.to !== null) throw new DeviceLockError(400, 'to must be farm, builtin or null')
        writeJson(response, 200, await this.requestSwitch(body.to as 'farm' | 'builtin' | null))
      } else throw new DeviceLockError(404, 'Not found')
    } catch (error) {
      writeJson(response, error instanceof DeviceLockError ? error.status : 500, { error: (error as Error).message })
    }
    return true
  }

  async status() {
    const checkout = this.checkout()
    const service = checkout && existsSync(this.settings.local.config)
      ? await this.farmCli(checkout, ['host', 'service-status']).then((out) => JSON.parse(out) as Record<string, unknown>).catch((error) => ({ error: (error as Error).message }))
      : undefined
    const builtin = this.builtin.snapshot()
    const farmStatus = this.farm?.status() ?? []
    return {
      use: this.settings.use,
      ...(this.settings.switching ? { switching: this.settings.switching, waitingOn: this.waitingOn() } : {}),
      local: { url: this.settings.local.url, checkout: checkout ?? null, configured: existsSync(this.settings.local.config), hasToken: Boolean(this.settings.local.token),
        ...(service ? { service } : {}), ...(farmStatus.find((entry) => entry.name === 'local') ?? {}) },
      remote: this.settings.remote ? { url: this.settings.remote.url, ...(farmStatus.find((entry) => entry.name === 'remote') ?? {}) } : null,
      builtin: { devices: builtin.resources.length, held: builtin.holders.length, queued: builtin.queue.length },
      ...(this.lastError ? { error: this.lastError } : {}),
    }
  }

  // ---- Local farm ----

  /**
   * Gets this Mac's farm ready: creates its config on 127.0.0.1, copies Commando's devices into it (release steps,
   * build rules), gives Commando its own admin token, and runs it as a launchd service. Safe to run again.
   */
  async setupLocal(checkoutOverride?: string) {
    if (this.setupRunning) throw new DeviceLockError(409, 'Setup is already running')
    const run = (async () => {
      const checkout = checkoutOverride ?? this.checkout()
      if (!checkout) throw new DeviceLockError(400, 'Couldn\'t find a device-farm checkout. Clone github.com/laeijebor/device-farm, run npm install, and give its folder here.')
      if (!isFarmCheckout(checkout)) throw new DeviceLockError(400, `${checkout} isn't a device-farm checkout`)
      this.settings.local.checkout = checkout
      if (!existsSync(this.settings.local.config)) {
        await this.farmCli(checkout, ['host', 'init', '--listen-host', '127.0.0.1', '--port', String(LOCAL_PORT), '--public-url', this.settings.local.url])
      }
      await this.farmCli(checkout, ['host', 'import-commando', '--state', this.commandoLocksPath, '--json'])
      if (!this.settings.local.token) {
        const out = JSON.parse(await this.farmCli(checkout, ['host', 'add-engineer', this.engineer, '--name', `Commando (${hostname().split('.')[0]}, ${this.engineer.replace('commando-', 'port ')})`, '--admin', '--json'])) as { token: string }
        this.settings.local.token = out.token
      }
      this.save()
      await this.farmCli(checkout, ['host', 'install-service'])
      await this.waitHealthy(this.settings.local.url)
    })()
    this.setupRunning = run
    try { await run; this.lastError = undefined } catch (error) { this.lastError = (error as Error).message; throw error } finally { this.setupRunning = undefined }
    return this.status()
  }

  /** The device-farm checkout: the one set up before, the `farm` command on PATH, or ~/dev/device-farm. */
  private checkout(): string | undefined {
    const candidates = [this.settings.local.checkout, process.env.COMMANDO_DEVICE_FARM_CHECKOUT, farmOnPath(), join(homedir(), 'dev', 'device-farm')]
    return candidates.find((candidate): candidate is string => Boolean(candidate) && isFarmCheckout(candidate!))
  }

  private farmCli(checkout: string, args: string[]): Promise<string> {
    return this.run([join(checkout, 'bin', 'farm.mjs'), ...args], { FARM_CONFIG: this.settings.local.config })
  }

  private async waitHealthy(url: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try { if ((await this.fetcher(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) })).ok) return } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new DeviceLockError(503, `The local farm didn't come up on ${url}; see ~/.device-farm/farm.log`)
  }

  // ---- Remote farm ----

  /** Saves (after checking it answers with a valid token) or removes the remote farm. */
  async setRemote(input: Record<string, unknown> | undefined) {
    const snapshot = this.settings.use === 'farm' ? this.farm?.snapshot() : undefined
    if (snapshot && [...snapshot.holders, ...snapshot.queue].some((owner) => owner.paneId.startsWith('%'))) {
      throw new DeviceLockError(409, 'Wait until your agents hold and queue for no devices before changing the remote farm')
    }
    if (input) {
      const url = typeof input.url === 'string' ? input.url.trim().replace(/\/$/, '') : ''
      const token = typeof input.token === 'string' ? input.token.trim() : ''
      if (!/^https?:\/\/[^\s/]+/.test(url) || !token) throw new DeviceLockError(400, 'Give the remote farm\'s URL (http://host:4500) and your farm token')
      const client = new FarmClient({ name: 'remote', url, token, fetcher: this.fetcher })
      await client.refresh()
      if (!client.me || !FARM_ID.test(client.me.id)) throw new DeviceLockError(400, 'That farm didn\'t recognise the token')
      this.settings.remote = { url, token }
    } else delete this.settings.remote
    this.save()
    if (this.settings.use === 'farm') await this.useFarm()
    return this.status()
  }

  // ---- Switching ----

  async requestSwitch(to: 'farm' | 'builtin' | null) {
    if (to === 'farm' && !this.settings.local.token) throw new DeviceLockError(409, 'Set up the local farm first')
    if (to === null || to === this.settings.use) delete this.settings.switching
    else this.settings.switching = to
    this.save()
    await this.tick()
    return this.status()
  }

  /** What a pending switch is waiting for: devices still held or queued on the queue being left. */
  private waitingOn(): { held: number; queued: number } {
    const snapshot = this.settings.use === 'builtin' ? this.builtin.snapshot() : this.store.snapshot()
    const ours = (owner: { paneId: string }) => owner.paneId.startsWith('%')
    return { held: snapshot.holders.filter(ours).length, queued: snapshot.queue.filter(ours).length }
  }

  /** Completes a pending switch once the queue being left is empty. One at a time. */
  tick(): Promise<void> {
    this.ticking ??= this.trySwitch().finally(() => { this.ticking = undefined })
    return this.ticking
  }

  private idle(): boolean {
    const { held, queued } = this.waitingOn()
    // On the farm, "nothing held" only means something once every farm has been read and no write is in flight.
    return !held && !queued && !(this.settings.use === 'farm' && this.farm && (this.farm.pending > 0 || this.farm.loading()))
  }

  private async trySwitch(): Promise<void> {
    const target = this.settings.switching
    if (!target || !this.idle()) return
    let next: FarmLockStore | undefined
    if (target === 'farm') {
      try { await this.waitHealthy(this.settings.local.url) } catch (error) { this.lastError = (error as Error).message; return }
      next = this.farmStore()
      if (!next) return
    }
    // Everything above awaited: a lock may have been taken, or the switch cancelled, meanwhile. Decide again, with
    // nothing awaited between this check and the switch.
    if (this.settings.switching !== target || !this.idle()) { next?.stop(); return }
    if (next) {
      // Listeners attach first, then the farm is read: an offer already waiting is then relayed, not lost.
      this.farm = next
      this.store.switchTo(next)
    } else {
      this.store.switchTo(this.builtin)
      this.farm?.stop()
      this.farm = undefined
    }
    this.settings.use = target
    delete this.settings.switching
    this.lastError = undefined
    this.save()
    await next?.ready()
  }

  /** Farm status for the Devices view: which farms Commando is on and whether they answer. */
  farmStatus() { return this.settings.use === 'farm' ? this.farm?.status() ?? [] : undefined }

  /** A store over this Mac's farm (and the remote one, if set), following their change feeds. */
  private farmStore(): FarmLockStore | undefined {
    if (!this.settings.local.token) return undefined
    const clients = [new FarmClient({ name: 'local', url: this.settings.local.url, token: this.settings.local.token, fetcher: this.fetcher })]
    if (this.settings.remote) clients.push(new FarmClient({ name: 'remote', url: this.settings.remote.url, token: this.settings.remote.token, fetcher: this.fetcher }))
    const store = new FarmLockStore(clients, { sessionPrefix: this.sessionPrefix, statePath: `${this.path.replace(/\.json$/, '')}.offers.json` })
    store.start()
    return store
  }

  /** Points Commando's locks at the farms (this Mac's, and the remote one if set). */
  private async useFarm(): Promise<void> {
    const next = this.farmStore()
    if (!next) return
    const previous = this.farm
    // Listeners attach before the first read, so offers that came while Commando was stopped are relayed; writes get
    // a 503 until the read is done.
    this.farm = next
    this.store.switchTo(next)
    previous?.stop()
    await next.ready()
  }

  private load(): DeviceFarmSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<DeviceFarmSettings>
      const base = defaults()
      return { ...base, ...parsed, use: parsed.use === 'farm' ? 'farm' : 'builtin', local: { ...base.local, ...parsed.local } }
    } catch { return defaults() }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(this.settings, null, 2), { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}

function isFarmCheckout(path: string): boolean {
  try { return (JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { name?: string }).name === 'device-farm' && existsSync(join(path, 'bin', 'farm.mjs')) } catch { return false }
}

/** The checkout behind a `farm` command on PATH (npm link makes it a symlink into the checkout's bin/). */
function farmOnPath(): string | undefined {
  for (const folder of (process.env.PATH ?? '').split(':')) {
    const candidate = join(folder, 'farm')
    if (!existsSync(candidate)) continue
    try { return dirname(dirname(realpathSync(candidate))) } catch { /* broken link */ }
  }
  return undefined
}

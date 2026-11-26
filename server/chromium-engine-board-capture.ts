import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChromiumLaunch, ChromiumLauncher } from './chromium-engine.js'
import { CaptureRequestPolicy, isBoardCaptureUrl, type CaptureDestination, type CaptureResolver } from './board-capture-policy.js'
import { fetchCaptureRequest, type CaptureFetch, type CaptureRequest } from './board-capture-network.js'

type Handler = (params: Record<string, unknown>, sessionId?: string) => void
export type CaptureCdp = {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>
  on(event: string, handler: Handler): void
  off(event: string, handler: Handler): void
  close(): void
}
export type BoardCaptureOptions = {
  launcher: ChromiumLauncher
  connect: (url: string, timeout: number) => Promise<CaptureCdp>
  endpoint: (port: number) => Promise<string>
  daemonOrigins: readonly string[]
  daemonPorts: readonly number[]
  resolve?: CaptureResolver
  fetch?: CaptureFetch
}
type Browser = { launch: ChromiumLaunch; cdp: CaptureCdp; profile: string; captures: number }
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }
const PROXY_ARGS = [
  // Fail closed for traffic Fetch cannot intercept (WebSockets, unsupported targets).
  // The proxy host is deliberately unresolvable; there is no DIRECT fallback.
  // Remove Chromium's implicit loopback bypass too.
  '--proxy-server=http://commando-capture-deny.invalid:9', '--proxy-bypass-list=<-loopback>',
  '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
]

/** Separate from all tile state/processes. HTTP is fulfilled through pinned Node
 * sockets; there is no Chromium DNS re-resolution after the policy check. Workers
 * (including service-worker registration) are intentionally disabled by response CSP.
 * Auto-attach is recursive because it is not inherited by OOPIF/worker targets.
 * Unsupported interception fails the job while the dead proxy fails egress closed.
 * This contains browser crashes, not a browser exploit or a machine-wide OOM. */
export class BoardCaptureBrowser {
  private browser?: Browser
  private serial: Promise<unknown> = Promise.resolve()
  private idle?: ReturnType<typeof setTimeout>
  private active?: AbortController
  private disposed = false
  constructor(private readonly options: BoardCaptureOptions) {}

  capture(url: string, width: number, height: number, destination: CaptureDestination): Promise<Buffer> {
    const result = this.serial.then(() => this.run(url, width, height, destination))
    this.serial = result.catch(() => {})
    return result
  }
  dispose(): Promise<void> {
    this.disposed = true; clearTimeout(this.idle); this.active?.abort()
    return this.retire()
  }
  private async retire(): Promise<void> {
    const browser = this.browser; this.browser = undefined
    if (!browser) return
    browser.cdp.close(); browser.launch.kill()
    await browser.launch.exited
    await rm(browser.profile, { recursive: true, force: true })
  }
  private async ensure(signal: AbortSignal): Promise<Browser> {
    if (this.browser) return this.browser
    const profile = await mkdtemp(join(tmpdir(), 'commando-board-browser-'))
    let launch: ChromiumLaunch | undefined, cdp: CaptureCdp | undefined
    const abort = () => launch?.kill()
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted || this.disposed) throw new Error('Board browser launch cancelled')
      launch = await this.options.launcher(profile, signal, PROXY_ARGS)
      if (signal.aborted || this.disposed) throw new Error('Board browser launch cancelled')
      cdp = await this.options.connect(await this.options.endpoint(launch.port), 10_000)
      if (signal.aborted || this.disposed) throw new Error('Board browser launch cancelled')
      const browser = { launch, cdp, profile, captures: 0 }
      this.browser = browser
      void launch.exited.then(async () => {
        if (this.browser === browser) this.browser = undefined
        cdp?.close()
        await rm(profile, { recursive: true, force: true })
      }).catch(() => {})
      return browser
    } catch (error) {
      cdp?.close(); launch?.kill()
      if (launch) await launch.exited
      await rm(profile, { recursive: true, force: true })
      throw error
    } finally { signal.removeEventListener('abort', abort) }
  }
  private async run(url: string, width: number, height: number, destination: CaptureDestination): Promise<Buffer> {
    if (this.disposed) throw new Error('Board browser is shut down')
    clearTimeout(this.idle)
    if (!isBoardCaptureUrl(url) || new URL(url).href !== destination.url || ![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error('Invalid Board capture job')
    const controller = new AbortController(); this.active = controller
    const policy = new CaptureRequestPolicy(destination, this.options.daemonOrigins, this.options.daemonPorts, this.options.resolve)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); void this.retire(); reject(new Error('Board capture timed out after 10s')) }, 10_000)
    })
    const check = () => { if (controller.signal.aborted) throw new Error('Board capture cancelled') }
    const job = async () => {
      await policy.address(url); check()
      const browser = await this.ensure(controller.signal); check()
      const cdp = browser.cdp
      let contextId: string | undefined, bytes = 0, requests = 0, activeRequests = 0
      const waiting: (() => void)[] = []
      const handlers: [string, Handler][] = []
      let fail!: (error: Error) => void
      const fatal = new Promise<never>((_, reject) => { fail = reject })
      // Attach a handler immediately, even if setup fails before the final race.
      void fatal.catch(() => {})
      const on = (event: string, handler: Handler) => { handlers.push([event, handler]); cdp.on(event, handler) }
      const targets = new Map<string, { sessionId: string; ready: Promise<void> }>()
      let notify: (() => void) | undefined
      const configure = async (session: string, type: string, targetId: string) => {
        await cdp.send('Target.setAutoAttach', AUTO_ATTACH, session); check()
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, session); check()
        await cdp.send('Network.setBypassServiceWorker', { bypass: true }, session); check()
        if (type === 'service_worker') {
          await cdp.send('Target.closeTarget', { targetId }); return
        }
        if (type === 'page' || type === 'iframe') {
          await cdp.send('Page.enable', {}, session)
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.open = () => null' }, session)
        }
        check(); await cdp.send('Runtime.runIfWaitingForDebugger', {}, session)
      }
      on('Target.attachedToTarget', (params) => {
        const info = params.targetInfo as { targetId: string; type: string }
        const sessionId = String(params.sessionId)
        const ready = configure(sessionId, info.type, info.targetId)
        ready.catch((error) => fail(error as Error))
        targets.set(info.targetId, { sessionId, ready }); notify?.()
      })
      on('Page.javascriptDialogOpening', (_params, session) => { void cdp.send('Page.handleJavaScriptDialog', { accept: false }, session).catch(fail) })
      on('Page.frameRequestedNavigation', (params) => {
        void policy.address(String(params.url)).catch((error) => fail(error as Error))
      })
      on('Fetch.requestPaused', (params, session) => {
        void (async () => {
          const request = params.request as CaptureRequest
          let acquired = false
          try {
            if (++requests > 200) throw new Error('Capture exceeds 200 requests')
            if (activeRequests >= 4) await new Promise<void>((resolve) => waiting.push(resolve))
            else activeRequests++
            acquired = true; check()
            if (Object.entries(request.headers ?? {}).some(([name, value]) => name.toLowerCase() === 'service-worker' && value.toLowerCase() === 'script')) throw new Error('Service workers are disabled in captures')
            const address = await policy.address(request.url); check()
            const response = await (this.options.fetch ?? fetchCaptureRequest)(request, address, controller.signal); check()
            bytes += response.body.length
            if (bytes > 50 * 1024 * 1024) throw new Error('Capture exceeds 50 MiB')
            for (const header of response.headers) if (header.name.toLowerCase() === 'location') await policy.address(new URL(header.value, request.url).href)
            response.headers.push({ name: 'Content-Security-Policy', value: "worker-src 'none'; object-src 'none'; frame-src http: https:; connect-src http: https:" })
            await cdp.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: response.status, responseHeaders: response.headers, body: response.body.toString('base64') }, session)
          } catch {
            if (!controller.signal.aborted) await cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, session)
          } finally { if (acquired) { const next = waiting.shift(); if (next) next(); else activeRequests-- } }
        })().catch(fail)
      })
      try {
        const context = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })
        if (typeof context.browserContextId !== 'string') throw new Error('Missing Board browser context')
        contextId = context.browserContextId; check()
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: contextId }); check()
        await cdp.send('Target.setAutoAttach', AUTO_ATTACH); check()
        const target = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: contextId, background: true }); check()
        while (!targets.has(String(target.targetId))) await Promise.race([new Promise<void>((resolve) => { notify = resolve }), fatal])
        const { sessionId, ready } = targets.get(String(target.targetId))!
        await Promise.race([ready, fatal]); check()
        const capture = async () => {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId)
          const loaded = new Promise<void>((resolve) => on('Page.loadEventFired', (_params, session) => { if (session === sessionId) resolve() }))
          const navigation = await cdp.send('Page.navigate', { url }, sessionId)
          if (navigation.errorText) throw new Error(`Board navigation failed: ${navigation.errorText}`)
          await loaded; check()
          // Also reject non-network navigations (data:/file:) that Fetch never sees.
          const tree = await cdp.send('Page.getFrameTree', {}, sessionId)
          const frame = tree.frameTree as { frame?: { url?: string } } | undefined
          // Read browser state, not an expression evaluated in the untrusted realm.
          await policy.address(String(frame?.frame?.url)); check()
          const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId); check()
          if (typeof result.data !== 'string') throw new Error('Missing Board PNG')
          return Buffer.from(result.data, 'base64')
        }
        return await Promise.race([capture(), fatal])
      } finally {
        for (const [event, handler] of handlers) cdp.off(event, handler)
        if (!controller.signal.aborted) {
          await cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true })
          if (contextId) await cdp.send('Target.disposeBrowserContext', { browserContextId: contextId })
        }
      }
    }
    try {
      const result = await Promise.race([job(), timeout])
      if (this.browser && ++this.browser.captures >= 25) await this.retire()
      return result
    } catch (error) {
      controller.abort(); await this.retire(); throw error
    } finally {
      clearTimeout(timer); controller.abort(); this.active = undefined
      if (!this.disposed && this.browser) {
        this.idle = setTimeout(() => { void this.retire() }, 60_000); this.idle.unref()
      }
    }
  }
}

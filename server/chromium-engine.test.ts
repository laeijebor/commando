import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPanePendingNote, WebPanePendingSnapshot } from '../shared/protocol.js'
import { REDLINE_BINDING_NAME } from '../shared/redline-response.js'
import {
  ChromiumEngine,
  findChromiumBinary,
  parseTileInputEvent,
  parseTileInspectRequest,
  reclaimStaleChromiumProfile,
  type ChromiumEngineOptions,
  type ChromiumLaunch,
  type ScreencastFrame,
} from './chromium-engine.js'

type CdpCall = { targetId: string; method: string; params?: Record<string, unknown> }

/**
 * A miniature Chrome DevTools endpoint: /json/version plus a browser-level
 * websocket (Target.createTarget / Target.closeTarget) and a per-target
 * websocket that acks every CDP call and lets tests emit events. Calls on the
 * browser socket are recorded with targetId 'browser'.
 */
class StubChromium {
  private server!: Server
  private wsServer!: WebSocketServer
  port = 0
  nextTarget = 1
  readonly calls: CdpCall[] = []
  readonly closedTargets: string[] = []
  readonly sockets = new Map<string, WebSocket>()
  /** Canned Runtime.evaluate result value, set by tests before triggering the call. */
  evaluateValue: unknown = null
  /** Canned Page.captureScreenshot payload. */
  screenshotData = 'SHOT'
  /** Remaining CDP errors to return per method. */
  private readonly failingMethods = new Map<string, number>()
  /** CDP calls intentionally left unanswered so tests can deliver an event first. */
  private readonly heldMethods = new Set<string>()

  failNext(method: string, times = 1): void {
    this.failingMethods.set(method, (this.failingMethods.get(method) ?? 0) + times)
  }

  holdNext(method: string): void {
    this.heldMethods.add(method)
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/json/version') {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/stub-browser`,
        }))
        return
      }
      response.statusCode = 404
      response.end()
    })
    this.wsServer = new WebSocketServer({ server: this.server })
    this.wsServer.on('connection', (socket, request) => {
      if (/^\/devtools\/browser\//.test(request.url ?? '')) {
        this.sockets.set('browser', socket)
        socket.on('message', (data) => {
          const message = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
          this.calls.push({ targetId: 'browser', method: message.method, params: message.params })
          if (message.method === 'Target.createTarget') {
            const targetId = `T${this.nextTarget++}`
            socket.send(JSON.stringify({ id: message.id, result: { targetId } }))
            return
          }
          if (message.method === 'Target.closeTarget') {
            const targetId = String(message.params?.targetId)
            this.closedTargets.push(targetId)
            this.sockets.get(targetId)?.close()
            socket.send(JSON.stringify({ id: message.id, result: { success: true } }))
            return
          }
          socket.send(JSON.stringify({ id: message.id, result: {} }))
        })
        return
      }
      const match = /^\/devtools\/page\/(.+)$/.exec(request.url ?? '')
      if (!match) {
        socket.close()
        return
      }
      const targetId = match[1]
      this.sockets.set(targetId, socket)
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> }
        this.calls.push({ targetId, method: message.method, params: message.params })
        if (this.heldMethods.delete(message.method)) return
        const failuresRemaining = this.failingMethods.get(message.method) ?? 0
        if (failuresRemaining > 0) {
          if (failuresRemaining === 1) this.failingMethods.delete(message.method)
          else this.failingMethods.set(message.method, failuresRemaining - 1)
          socket.send(JSON.stringify({ id: message.id, error: { message: `${message.method} failed (stub)` } }))
          return
        }
        if (message.method === 'Runtime.evaluate') {
          socket.send(JSON.stringify({ id: message.id, result: { result: { type: 'object', value: this.evaluateValue } } }))
          return
        }
        if (message.method === 'Page.captureScreenshot') {
          socket.send(JSON.stringify({ id: message.id, result: { data: this.screenshotData } }))
          return
        }
        socket.send(JSON.stringify({ id: message.id, result: {} }))
      })
    })
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port
        resolve()
      })
    })
  }

  emit(targetId: string, method: string, params: Record<string, unknown>): void {
    this.sockets.get(targetId)?.send(JSON.stringify({ method, params }))
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets.values()) socket.terminate()
    this.wsServer.close()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

async function until(predicate: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function pendingSnapshot(notes: WebPanePendingNote[]): WebPanePendingSnapshot {
  return { notes, knownUpTo: notes.length, dropped: 0 }
}

function responseNote(
  id: number,
  answer: string,
  data?: unknown,
  pageUrl = 'http://localhost:5173/',
): WebPanePendingNote {
  return {
    id,
    revision: 3,
    pageUrl,
    queueKey: 'plan',
    selector: '#plan',
    tag: 'redline-choice',
    text: 'presentation text',
    rect: { x: 1, y: 2, width: 3, height: 4 },
    comment: 'manual presentation comment',
    response: {
      question: 'Which plan?',
      answer,
      note: 'Keep it focused.',
      ...(data !== undefined ? { data } : {}),
    },
    attachments: [{ id: 'private.png', name: 'private.png', contentType: 'image/png', size: 123 }],
  }
}

function manualNote(id: number): WebPanePendingNote {
  return {
    id,
    selector: '#manual',
    tag: 'button',
    text: 'Do not expose',
    rect: { x: 10, y: 20, width: 30, height: 40 },
    comment: 'manual annotation',
    attachments: [{ id: 'manual.png', name: 'manual.png', contentType: 'image/png', size: 456 }],
  }
}

function pagePendingEvaluations(stub: StubChromium, targetId?: string): CdpCall[] {
  return stub.calls.filter((call) =>
    call.method === 'Runtime.evaluate' &&
    (!targetId || call.targetId === targetId) &&
    String(call.params?.expression).includes('__commandoRedlinePendingSnapshot'),
  )
}

function snapshotFromEvaluation(call: CdpCall): unknown {
  const expression = String(call.params?.expression)
  const match = /const snapshot=JSON\.parse\(((?:"(?:\\.|[^"\\])*")|null)\);/.exec(expression)
  if (!match) throw new Error('Pending snapshot expression did not contain a JSON payload')
  return JSON.parse(JSON.parse(match[1]) as string) as unknown
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type Harness = {
  stub: StubChromium
  engine: ChromiumEngine
  onExternalNavigation: ReturnType<typeof vi.fn>
  onTargetDown: ReturnType<typeof vi.fn>
  launches: number
  exitBrowser: () => void
}

async function createHarness(engineOptions: Partial<ChromiumEngineOptions> = {}): Promise<Harness> {
  const stub = new StubChromium()
  await stub.start()
  const onExternalNavigation = vi.fn()
  const onTargetDown = vi.fn()
  let exitCurrent: () => void = () => undefined
  const harness: Harness = {
    stub,
    engine: undefined as unknown as ChromiumEngine,
    onExternalNavigation,
    onTargetDown,
    launches: 0,
    exitBrowser: () => exitCurrent(),
  }
  const engine = new ChromiumEngine({
    launcher: () => {
      harness.launches += 1
      const launch: ChromiumLaunch = {
        port: stub.port,
        kill: () => undefined,
        exited: new Promise<void>((resolve) => {
          exitCurrent = resolve
        }),
      }
      return Promise.resolve(launch)
    },
    classify: (url) => {
      try {
        const { hostname } = new URL(url)
        return { kind: hostname === 'localhost' || hostname === '127.0.0.1' ? 'open' : 'confirm' }
      } catch {
        return { kind: 'invalid' }
      }
    },
    onExternalNavigation,
    onTargetDown,
    ...engineOptions,
  })
  harness.engine = engine
  cleanups.push(() => {
    engine.dispose()
    return stub.stop()
  })
  return harness
}

describe('findChromiumBinary', () => {
  it('honours COMMANDO_CHROMIUM_PATH strictly', () => {
    expect(findChromiumBinary({ COMMANDO_CHROMIUM_PATH: '/bin/sh' })).toBe('/bin/sh')
    expect(findChromiumBinary({ COMMANDO_CHROMIUM_PATH: '/does/not/exist' })).toBeNull()
  })
})

describe('chromium process ownership', () => {
  it('reclaims a verified browser orphan holding the dedicated profile', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'commando-chromium-profile-'))
    const child = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => undefined, 1_000)',
        '--',
        '--headless=new',
        `--user-data-dir=${profileDir}`,
      ],
      { detached: true, stdio: 'ignore' },
    )
    const childPid = child.pid
    if (childPid === undefined) throw new Error('Test browser process did not start')
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    symlinkSync(`test-host-${childPid}`, join(profileDir, 'SingletonLock'))
    cleanups.push(() => {
      try {
        process.kill(-childPid, 'SIGKILL')
      } catch {
        // Already reclaimed.
      }
      rmSync(profileDir, { recursive: true, force: true })
    })

    await reclaimStaleChromiumProfile(profileDir)
    await exited
    expect(() => process.kill(childPid, 0)).toThrow()
  })

  it('aborts an in-flight launch when the engine is disposed', async () => {
    let launchSignal: AbortSignal | undefined
    const engine = new ChromiumEngine({
      launcher: (_profileDir, signal) => {
        launchSignal = signal
        return new Promise<ChromiumLaunch>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('launch aborted')), { once: true })
        })
      },
      classify: () => ({ kind: 'open' }),
      onExternalNavigation: () => undefined,
    })

    const launch = engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    engine.dispose()

    await expect(launch).rejects.toThrow('launch aborted')
    expect(launchSignal?.aborted).toBe(true)
  })
})

describe('parseTileInputEvent', () => {
  it('accepts the supported shapes and rejects everything else', () => {
    expect(parseTileInputEvent({ kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 }))
      .toMatchObject({ kind: 'mouse', type: 'mousePressed', x: 10, y: 20 })
    expect(parseTileInputEvent({ kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: 120 }))
      .toMatchObject({ kind: 'wheel', deltaY: 120 })
    expect(parseTileInputEvent({ kind: 'key', type: 'char', text: 'a' }))
      .toMatchObject({ kind: 'key', text: 'a' })
    expect(parseTileInputEvent(null)).toBeNull()
    expect(parseTileInputEvent({ kind: 'mouse', type: 'contextmenu', x: 1, y: 1 })).toBeNull()
    expect(parseTileInputEvent({ kind: 'mouse', type: 'mouseMoved', x: Number.NaN, y: 1 })).toBeNull()
    expect(parseTileInputEvent({ kind: 'key', type: 'char', text: 'x'.repeat(64) }))
      .toMatchObject({ text: undefined })
  })
})

describe('ChromiumEngine', () => {
  it('creates one target per tile and serves cdp coordinates', async () => {
    const { stub, engine } = await createHarness()
    const info = await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    expect(info.target).toBe(`ws://127.0.0.1:${stub.port}/devtools/page/T1`)
    // Always the browser's locally-served frontend, never Chrome's appspot URL.
    expect(info.devtoolsFrontendUrl).toBe(
      `http://127.0.0.1:${stub.port}/devtools/inspector.html?ws=127.0.0.1:${stub.port}/devtools/page/T1`,
    )
    expect(stub.calls).toContainEqual({ targetId: 'T1', method: 'Page.enable', params: undefined })
    expect(stub.calls).toContainEqual({
      targetId: 'T1',
      method: 'Page.navigate',
      params: { url: 'http://localhost:5173/' },
    })

    // Same tile reuses the target; a second tile gets its own.
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    const second = await engine.cdpInfo('w-22222222', 'http://localhost:5174/')
    expect(second.target).toContain('/T2')
    expect(stub.nextTarget).toBe(3)
  })

  it('creates each tile target in its own browser window so background tiles keep painting', async () => {
    const { stub, engine } = await createHarness()
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    // A tab created with /json/new steals the active slot and stops every
    // other tile's compositor (hidden tabs emit no screencast frames);
    // newWindow keeps each tile painting independently.
    expect(stub.calls).toContainEqual({
      targetId: 'browser',
      method: 'Target.createTarget',
      params: { url: 'about:blank', newWindow: true, background: false, focus: true },
    })
    expect(stub.calls).toContainEqual({
      targetId: 'browser',
      method: 'Target.activateTarget',
      params: { targetId: 'T1' },
    })
  })

  it('buffers a no-viewer update and hydrates the initial accepted document', async () => {
    const { stub, engine } = await createHarness()
    engine.updatePendingSnapshot('w-11111111', pendingSnapshot([responseNote(1, 'Pro')]))

    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    expect(pagePendingEvaluations(stub)).toHaveLength(0)

    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: 'http://localhost:5173/' } })
    await until(() => pagePendingEvaluations(stub, 'T1').length === 1, 'initial pending hydration')
    expect(snapshotFromEvaluation(pagePendingEvaluations(stub, 'T1')[0])).toEqual({
      version: 1,
      controls: [{
        queueKey: 'plan',
        selector: '#plan',
        response: { question: 'Which plan?', answer: 'Pro', note: 'Keep it focused.' },
      }],
    })

    stub.emit('T1', 'Page.domContentEventFired', { timestamp: 1 })
    await until(() => pagePendingEvaluations(stub, 'T1').length === 2, 'DOMContentLoaded pending hydration')
  })

  it('sanitizes and JSON-clones the page-facing pending snapshot', async () => {
    const { stub, engine } = await createHarness()
    const data = { choice: 'Pro', nested: { enabled: true }, omitted: undefined }
    const source = pendingSnapshot([manualNote(1), responseNote(2, 'Pro', data)])
    engine.updatePendingSnapshot('w-11111111', source)
    data.choice = 'mutated after buffering'
    data.nested.enabled = false

    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: 'http://localhost:5173/' } })
    await until(() => pagePendingEvaluations(stub, 'T1').length === 1, 'sanitized pending hydration')

    expect(snapshotFromEvaluation(pagePendingEvaluations(stub, 'T1')[0])).toEqual({
      version: 1,
      controls: [{
        queueKey: 'plan',
        selector: '#plan',
        response: {
          question: 'Which plan?',
          answer: 'Pro',
          note: 'Keep it focused.',
          data: { choice: 'Pro', nested: { enabled: true } },
        },
      }],
    })
    expect(String(pagePendingEvaluations(stub, 'T1')[0].params?.expression))
      .toContain("new CustomEvent('commando:redline-pending',{detail:snapshot})")
  })

  it('publishes live full replacements, including an empty snapshot', async () => {
    const { stub, engine } = await createHarness()
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: 'http://localhost:5173/' } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    engine.updatePendingSnapshot('w-11111111', pendingSnapshot([responseNote(1, 'Starter')]))
    await until(() => pagePendingEvaluations(stub, 'T1').length === 1, 'live pending replacement')
    engine.updatePendingSnapshot('w-11111111', pendingSnapshot([]))
    await until(() => pagePendingEvaluations(stub, 'T1').length === 2, 'live empty replacement')

    expect(pagePendingEvaluations(stub, 'T1').map(snapshotFromEvaluation)).toEqual([
      {
        version: 1,
        controls: [{
          queueKey: 'plan',
          selector: '#plan',
          response: { question: 'Which plan?', answer: 'Starter', note: 'Keep it focused.' },
        }],
      },
      { version: 1, controls: [] },
    ])
  })

  it('keeps the target alive when hydration races a navigation context failure', async () => {
    const { stub, engine } = await createHarness()
    engine.updatePendingSnapshot('w-11111111', pendingSnapshot([responseNote(1, 'Pro')]))
    stub.failNext('Runtime.evaluate')
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')

    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: 'http://localhost:5173/' } })
    await until(() => pagePendingEvaluations(stub, 'T1').length === 1, 'failed hydration attempt')
    expect(engine.hasTile('w-11111111')).toBe(true)

    engine.updatePendingSnapshot('w-11111111', pendingSnapshot([]))
    await until(() => pagePendingEvaluations(stub, 'T1').length === 2, 'hydration retry')
    expect(engine.hasTile('w-11111111')).toBe(true)
  })

  it('publishes only to the exact source URL and clears every other document', async () => {
    const { stub, engine, onExternalNavigation } = await createHarness()
    const sourceUrl = 'http://localhost:5173/review'
    const secret = 'sensitive expression content'
    engine.updatePendingSnapshot('w-11111111', pendingSnapshot([
      responseNote(1, secret, { secret }, sourceUrl),
    ]))
    await engine.cdpInfo('w-11111111', sourceUrl)

    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: sourceUrl } })
    await until(() => pagePendingEvaluations(stub, 'T1').length === 1, 'source hydration')
    expect(snapshotFromEvaluation(pagePendingEvaluations(stub, 'T1')[0])).toMatchObject({
      controls: [{ response: { answer: secret, data: { secret } } }],
    })

    stub.emit('T1', 'Page.navigatedWithinDocument', { frameId: 'F1', url: `${sourceUrl}/different` })
    await until(() => pagePendingEvaluations(stub, 'T1').length === 2, 'different-path clear')
    const differentPath = pagePendingEvaluations(stub, 'T1')[1]
    expect(snapshotFromEvaluation(differentPath)).toEqual({ version: 1, controls: [] })
    expect(String(differentPath.params?.expression)).not.toContain(secret)
    expect(String(differentPath.params?.expression)).not.toContain('Which plan?')
    expect(String(differentPath.params?.expression)).not.toContain('Keep it focused.')

    const confirmedExternal = 'https://external.example/confirmed'
    await engine.navigate('w-11111111', confirmedExternal)
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: confirmedExternal } })
    await until(() => pagePendingEvaluations(stub, 'T1').length === 3, 'confirmed external clear')
    expect(snapshotFromEvaluation(pagePendingEvaluations(stub, 'T1')[2])).toEqual({ version: 1, controls: [] })

    await engine.navigate('w-11111111', sourceUrl)
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: sourceUrl } })
    await until(() => pagePendingEvaluations(stub, 'T1').length === 4, 'source rehydration')
    expect(snapshotFromEvaluation(pagePendingEvaluations(stub, 'T1')[3])).toMatchObject({
      controls: [{ response: { answer: secret } }],
    })

    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: 'https://external.example/' } })
    await until(() => onExternalNavigation.mock.calls.length === 1, 'external navigation rejection')
    await until(() => pagePendingEvaluations(stub, 'T1').length === 5, 'rejected external clear')
    expect(snapshotFromEvaluation(pagePendingEvaluations(stub, 'T1')[4])).toEqual({ version: 1, controls: [] })

    for (const url of ['about:blank', 'chrome-error://chromewebdata/', 'devtools://devtools/bundled/inspector.html']) {
      stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url } })
    }
    await until(() => pagePendingEvaluations(stub, 'T1').length === 8, 'browser-owned clears')
    expect(pagePendingEvaluations(stub, 'T1').slice(5).map(snapshotFromEvaluation)).toEqual([
      { version: 1, controls: [] },
      { version: 1, controls: [] },
      { version: 1, controls: [] },
    ])
  })

  it('reports the target current main-frame URL with page responses', async () => {
    const onPageResponse = vi.fn()
    const { stub, engine } = await createHarness({ onPageResponse })
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    const currentUrl = 'http://localhost:5173/current/path'
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: currentUrl } })
    stub.emit('T1', 'Runtime.bindingCalled', {
      name: REDLINE_BINDING_NAME,
      payload: JSON.stringify({ question: 'Ship it?', answer: 'yes', queueKey: 'ship' }),
    })

    await until(() => onPageResponse.mock.calls.length === 1, 'page response callback')
    expect(onPageResponse).toHaveBeenCalledWith(
      'w-11111111',
      { question: 'Ship it?', answer: 'yes', queueKey: 'ship' },
      currentUrl,
    )
  })

  it('retains the latest snapshot across target recreation', async () => {
    const { stub, engine, onTargetDown } = await createHarness()
    engine.updatePendingSnapshot('w-11111111', pendingSnapshot([responseNote(1, 'Enterprise')]))
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: 'http://localhost:5173/' } })
    await until(() => pagePendingEvaluations(stub, 'T1').length === 1, 'first target hydration')

    stub.sockets.get('T1')?.close()
    await until(() => onTargetDown.mock.calls.length === 1, 'target crash')
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    stub.emit('T2', 'Page.frameNavigated', { frame: { id: 'F2', url: 'http://localhost:5173/' } })
    await until(() => pagePendingEvaluations(stub, 'T2').length === 1, 'recreated target hydration')

    expect(snapshotFromEvaluation(pagePendingEvaluations(stub, 'T2')[0])).toMatchObject({
      controls: [{ response: { answer: 'Enterprise' } }],
    })
  })

  it('clears a live page without retaining the empty lifecycle reset', async () => {
    const { stub, engine, onTargetDown } = await createHarness()
    engine.updatePendingSnapshot('w-11111111', pendingSnapshot([responseNote(1, 'Pro')]))
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: 'http://localhost:5173/' } })
    await until(() => pagePendingEvaluations(stub, 'T1').length === 1, 'pending hydration before clear')

    engine.clearPendingSnapshot('w-11111111')
    await until(() => pagePendingEvaluations(stub, 'T1').length === 2, 'live pending clear')
    expect(snapshotFromEvaluation(pagePendingEvaluations(stub, 'T1')[1])).toEqual({ version: 1, controls: [] })

    stub.sockets.get('T1')?.close()
    await until(() => onTargetDown.mock.calls.length === 1, 'target close after clear')
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    stub.emit('T2', 'Page.frameNavigated', { frame: { id: 'F2', url: 'http://localhost:5173/' } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(pagePendingEvaluations(stub, 'T2')).toHaveLength(0)
  })

  it('reactivates a navigated target immediately before starting its screencast', async () => {
    const { stub, engine } = await createHarness()

    await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', vi.fn())

    const navigateIndex = stub.calls.findIndex((call) => call.method === 'Page.navigate')
    const startIndex = stub.calls.findIndex((call) => call.method === 'Page.startScreencast')
    const activateIndex = stub.calls.map((call) => call.method).lastIndexOf('Target.activateTarget')
    expect(activateIndex).toBeGreaterThan(navigateIndex)
    expect(startIndex).toBeGreaterThan(activateIndex)
  })

  it('recovers from a failed screencast start instead of wedging the tile', async () => {
    const { stub, engine } = await createHarness()
    stub.failNext('Page.startScreencast')
    const stale = vi.fn()
    await expect(
      engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', stale),
    ).rejects.toThrow(/startScreencast/)

    // A later subscriber must retry the start and receive frames; the failed
    // subscriber's sink must not linger.
    const frames: ScreencastFrame[] = []
    await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', (frame) => {
      frames.push(frame)
    })
    await until(
      () => stub.calls.filter((call) => call.method === 'Page.startScreencast').length === 2,
      'screencast retry',
    )
    stub.emit('T1', 'Page.screencastFrame', { data: 'AFTER', sessionId: 3, metadata: {} })
    await until(() => frames.length === 1, 'frame after retry')
    expect(stale).not.toHaveBeenCalled()
  })

  it('rejects every concurrent subscriber when their shared screencast start fails', async () => {
    const { stub, engine } = await createHarness()
    stub.failNext('Page.startScreencast')

    const starts = await Promise.allSettled([
      engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', vi.fn()),
      engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', vi.fn()),
    ])

    expect(starts.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(stub.calls.filter((call) => call.method === 'Page.startScreencast')).toHaveLength(1)

    const frames: ScreencastFrame[] = []
    await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', (frame) => {
      frames.push(frame)
    })
    stub.emit('T1', 'Page.screencastFrame', { data: 'AFTER', sessionId: 4, metadata: {} })
    await until(() => frames.length === 1, 'frame after concurrent start retry')
  })

  it('accepts the first frame when Chrome never acknowledges startScreencast', async () => {
    const { stub, engine } = await createHarness({ connectTimeoutMs: 50 })
    stub.holdNext('Page.startScreencast')
    const frames: ScreencastFrame[] = []

    const subscribing = engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', (frame) => {
      frames.push(frame)
    })
    await until(
      () => stub.calls.some((call) => call.method === 'Page.startScreencast'),
      'unacknowledged screencast start',
    )
    stub.emit('T1', 'Page.screencastFrame', { data: 'LIVE', sessionId: 5, metadata: {} })

    await expect(subscribing).resolves.toBeTypeOf('function')
    expect(frames).toHaveLength(1)
  })

  it('fails fast when the browser devtools http endpoint hangs', async () => {
    const silent = createServer(() => {
      // Never respond: a wedged browser must not hang the relay forever.
    })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
    cleanups.push(() => new Promise<void>((resolve) => silent.close(() => resolve())))
    const engine = new ChromiumEngine({
      launcher: () => Promise.resolve({
        port: (silent.address() as AddressInfo).port,
        kill: () => undefined,
        exited: new Promise<void>(() => undefined),
      }),
      classify: () => ({ kind: 'open' }),
      onExternalNavigation: () => undefined,
      httpTimeoutMs: 50,
    })
    cleanups.push(() => engine.dispose())
    await expect(engine.cdpInfo('w-11111111', 'http://localhost:5173/')).rejects.toThrow(/timed out/)
  })

  it('fails fast when the CDP websocket never completes its handshake', async () => {
    // Accepts TCP connections but never answers the websocket upgrade.
    const muteSockets: Array<{ destroy: () => void }> = []
    const mute = createNetServer((socket) => {
      muteSockets.push(socket)
    })
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', () => resolve()))
    cleanups.push(() => new Promise<void>((resolve) => {
      for (const socket of muteSockets) socket.destroy()
      mute.close(() => resolve())
    }))
    const mutePort = (mute.address() as AddressInfo).port
    const version = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${mutePort}/devtools/browser/mute`,
      }))
    })
    await new Promise<void>((resolve) => version.listen(0, '127.0.0.1', () => resolve()))
    cleanups.push(() => new Promise<void>((resolve) => version.close(() => resolve())))
    const engine = new ChromiumEngine({
      launcher: () => Promise.resolve({
        port: (version.address() as AddressInfo).port,
        kill: () => undefined,
        exited: new Promise<void>(() => undefined),
      }),
      classify: () => ({ kind: 'open' }),
      onExternalNavigation: () => undefined,
      connectTimeoutMs: 50,
    })
    cleanups.push(() => engine.dispose())
    await expect(engine.cdpInfo('w-11111111', 'http://localhost:5173/')).rejects.toThrow(/timed out/)
  })

  it('fans screencast frames out to subscribers and acks them', async () => {
    const { stub, engine } = await createHarness()
    const frames: ScreencastFrame[] = []
    const unsubscribe = await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', (frame) => {
      frames.push(frame)
    })
    await until(() => stub.calls.some((call) => call.method === 'Page.startScreencast'), 'startScreencast')

    stub.emit('T1', 'Page.screencastFrame', { data: 'BASE64', sessionId: 7, metadata: { deviceWidth: 800 } })
    await until(() => frames.length === 1, 'frame delivery')
    expect(frames[0]).toMatchObject({ data: 'BASE64', format: 'png' })
    await until(
      () => stub.calls.some((call) => call.method === 'Page.screencastFrameAck' && call.params?.sessionId === 7),
      'frame ack',
    )

    unsubscribe()
    await until(() => stub.calls.some((call) => call.method === 'Page.stopScreencast'), 'stopScreencast')
  })

  it('falls back to screenshot polling when the screencast never produces a frame', async () => {
    const { stub, engine } = await createHarness({ screencastFallbackAfterMs: 30, screencastPollIntervalMs: 20 })
    const frames: ScreencastFrame[] = []
    await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', (frame) => {
      frames.push(frame)
    })
    // No screencastFrame is ever emitted (the "hidden window" starvation).
    await until(() => frames.length === 1, 'fallback frame')
    expect(frames[0]).toMatchObject({ data: 'SHOT', format: 'png' })
    const stopIndex = stub.calls.findIndex((call) => call.method === 'Page.stopScreencast')
    const captureIndex = stub.calls.findIndex((call) => call.method === 'Page.captureScreenshot')
    expect(stopIndex).toBeGreaterThan(-1)
    expect(captureIndex).toBeGreaterThan(stopIndex)
    // Identical screenshots are not re-sent…
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(frames).toHaveLength(1)
    // …but changed content flows.
    stub.screenshotData = 'SHOT2'
    await until(() => frames.length === 2, 'changed fallback frame')
    expect(frames[1]).toMatchObject({ data: 'SHOT2' })
  })

  it('stops the fallback poller as soon as a real screencast frame arrives', async () => {
    const { stub, engine } = await createHarness({ screencastFallbackAfterMs: 30, screencastPollIntervalMs: 20 })
    const frames: ScreencastFrame[] = []
    await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', (frame) => {
      frames.push(frame)
    })
    await until(() => frames.some((frame) => frame.data === 'SHOT'), 'fallback engaged')
    stub.emit('T1', 'Page.screencastFrame', { data: 'REAL', sessionId: 1, metadata: {} })
    await until(() => frames.some((frame) => frame.data === 'REAL'), 'real frame')
    const shots = stub.calls.filter((call) => call.method === 'Page.captureScreenshot').length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(stub.calls.filter((call) => call.method === 'Page.captureScreenshot').length).toBe(shots)
  })

  it('rearms screenshot polling when a live screencast becomes invisible', async () => {
    const { stub, engine } = await createHarness({ screencastFallbackAfterMs: 30, screencastPollIntervalMs: 20 })
    const frames: ScreencastFrame[] = []
    await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', (frame) => {
      frames.push(frame)
    })
    stub.emit('T1', 'Page.screencastFrame', { data: 'REAL', sessionId: 1, metadata: {} })
    await until(() => frames.some((frame) => frame.data === 'REAL'), 'real frame')

    stub.emit('T1', 'Page.screencastVisibilityChanged', { visible: false })
    await until(() => frames.some((frame) => frame.data === 'SHOT'), 'rearmed fallback frame')
    expect(stub.calls.some((call) => call.method === 'Page.captureScreenshot')).toBe(true)
  })

  it('immediately replays the cached last frame to a joining sink', async () => {
    const { stub, engine } = await createHarness()
    await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', () => undefined)
    stub.emit('T1', 'Page.screencastFrame', {
      data: 'CACHED', sessionId: 1, metadata: { deviceWidth: 800 },
    })
    await until(
      () => stub.calls.some((call) => call.method === 'Page.screencastFrameAck'),
      'cached frame acknowledgement',
    )

    const joiningSink = vi.fn()
    await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', joiningSink)
    expect(joiningSink).toHaveBeenCalledOnce()
    expect(joiningSink).toHaveBeenCalledWith({
      data: 'CACHED', format: 'png', metadata: { deviceWidth: 800 },
    })
  })

  it('caps fallback screenshots to the screencast maximum dimension', async () => {
    const { stub, engine } = await createHarness({ screencastFallbackAfterMs: 30, screencastPollIntervalMs: 20 })
    await engine.setViewport('w-11111111', { width: 4_000, height: 2_000, deviceScaleFactor: 1 })
    await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', () => undefined)
    await until(
      () => stub.calls.some((call) => call.method === 'Page.captureScreenshot'),
      'clipped fallback capture',
    )

    const capture = stub.calls.find((call) => call.method === 'Page.captureScreenshot')
    expect(capture?.params).toEqual({
      format: 'png',
      clip: { x: 0, y: 0, width: 4_000, height: 2_000, scale: 2_560 / 4_000 },
    })
  })

  it('stops screenshot polling after five consecutive capture failures', async () => {
    const { stub, engine } = await createHarness({ screencastFallbackAfterMs: 30, screencastPollIntervalMs: 20 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    cleanups.push(() => warn.mockRestore())
    stub.failNext('Page.captureScreenshot', 5)
    await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', () => undefined)
    await until(
      () => stub.calls.filter((call) => call.method === 'Page.captureScreenshot').length === 5,
      'five failed fallback captures',
    )
    await until(
      () => warn.mock.calls.some(([message]) => message === 'giving up on screenshot fallback for w-11111111'),
      'fallback failure warning',
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(stub.calls.filter((call) => call.method === 'Page.captureScreenshot')).toHaveLength(5)
    expect(warn.mock.calls.filter(
      ([message]) => message === 'giving up on screenshot fallback for w-11111111',
    )).toHaveLength(1)
  })

  it('stops the fallback poller when the last subscriber leaves', async () => {
    const { stub, engine } = await createHarness({ screencastFallbackAfterMs: 30, screencastPollIntervalMs: 20 })
    const unsubscribe = await engine.subscribeScreencast('w-11111111', 'http://localhost:5173/', () => undefined)
    await until(() => stub.calls.some((call) => call.method === 'Page.captureScreenshot'), 'fallback engaged')
    unsubscribe()
    await until(() => stub.calls.some((call) => call.method === 'Page.stopScreencast'), 'stopScreencast')
    const shots = stub.calls.filter((call) => call.method === 'Page.captureScreenshot').length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(stub.calls.filter((call) => call.method === 'Page.captureScreenshot').length).toBe(shots)
  })

  it('forwards validated input events', async () => {
    const { stub, engine } = await createHarness()
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    engine.dispatchInput('w-11111111', {
      kind: 'mouse', type: 'mousePressed', x: 12, y: 34, button: 'left', clickCount: 1,
    })
    engine.dispatchInput('w-11111111', { kind: 'wheel', x: 5, y: 6, deltaX: 0, deltaY: -120 })
    engine.dispatchInput('w-11111111', { kind: 'key', type: 'char', text: 'a' })
    await until(
      () => stub.calls.filter((call) => call.method.startsWith('Input.')).length === 3,
      'input forwarding',
    )
    const mouse = stub.calls.find((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed')
    expect(mouse?.params).toMatchObject({ x: 12, y: 34, button: 'left', clickCount: 1 })
    const wheel = stub.calls.find((call) => call.params?.type === 'mouseWheel')
    expect(wheel?.params).toMatchObject({ deltaY: -120 })
  })

  it('forwards windowsVirtualKeyCode without inventing a native keycode', async () => {
    const { stub, engine } = await createHarness()
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    engine.dispatchInput('w-11111111', {
      kind: 'key', type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    })
    await until(
      () => stub.calls.some((call) => call.method === 'Input.dispatchKeyEvent'),
      'key forwarding',
    )
    const key = stub.calls.find((call) => call.method === 'Input.dispatchKeyEvent')
    expect(key?.params).toMatchObject({ type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 })
    // A Windows code is not a platform keycode: mirroring it into
    // nativeVirtualKeyCode hangs the macOS headless renderer mid-sequence.
    expect(key?.params).not.toHaveProperty('nativeVirtualKeyCode')
  })

  it('re-pends tiles when the main frame navigates somewhere un-allowlisted', async () => {
    const { stub, engine, onExternalNavigation } = await createHarness()
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')

    // Allowed localhost navigation: no callback.
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: 'http://localhost:5173/deep' } })
    // Same-origin as the current (confirmed) URL: no callback either.
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: 'http://localhost:5173/other?page=2' } })
    // Subframe navigation anywhere: no callback.
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F2', parentId: 'F1', url: 'https://ads.example/embed' } })
    // Main frame external navigation: watchdog fires and blanks the page.
    stub.emit('T1', 'Page.frameNavigated', { frame: { id: 'F1', url: 'https://tracking.example/away' } })

    await until(() => onExternalNavigation.mock.calls.length > 0, 'watchdog callback')
    expect(onExternalNavigation).toHaveBeenCalledTimes(1)
    expect(onExternalNavigation).toHaveBeenCalledWith('w-11111111', 'https://tracking.example/away')
    await until(
      () => stub.calls.some((call) => call.method === 'Page.navigate' && call.params?.url === 'about:blank'),
      'blank navigation',
    )
  })

  it('closes targets for removed tiles and syncs against the live set', async () => {
    const { stub, engine } = await createHarness()
    await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    await engine.cdpInfo('w-22222222', 'http://localhost:5174/')

    engine.closeTile('w-11111111')
    await until(() => stub.closedTargets.includes('T1'), 'target close')

    engine.syncTiles(new Set())
    await until(() => stub.closedTargets.includes('T2'), 'sync close')
    expect(engine.hasTile('w-22222222')).toBe(false)
  })

  it('recovers after the browser process dies', async () => {
    const harness = await createHarness()
    await harness.engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    expect(harness.launches).toBe(1)

    harness.exitBrowser()
    await until(() => harness.onTargetDown.mock.calls.length > 0, 'target-down callback')
    expect(harness.engine.hasTile('w-11111111')).toBe(false)

    const info = await harness.engine.cdpInfo('w-11111111', 'http://localhost:5173/')
    expect(harness.launches).toBe(2)
    expect(info.target).toContain('/devtools/page/')
  })

  describe('inspectAt', () => {
    it('evaluates the probe and returns the validated result', async () => {
      const { stub, engine } = await createHarness()
      await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
      stub.evaluateValue = {
        ok: true,
        selector: '#root > button',
        tag: 'button',
        rect: { x: 1, y: 2, width: 3, height: 4 },
      }
      const result = await engine.inspectAt('w-11111111', 10, 20, 'hover')
      expect(result).toEqual(stub.evaluateValue)
      const call = stub.calls.find((entry) => entry.method === 'Runtime.evaluate')
      expect(call?.params?.returnByValue).toBe(true)
      expect(String(call?.params?.expression)).toContain('(document, 10, 20, "hover")')
    })

    it('reports a friendly failure for a tile with no live target', async () => {
      const { engine } = await createHarness()
      const result = await engine.inspectAt('w-99999999', 1, 1, 'hover')
      expect(result).toEqual({ ok: false, error: 'Tile has no live chromium target' })
    })

    it('reports a failure when the page returns garbage', async () => {
      const { stub, engine } = await createHarness()
      await engine.cdpInfo('w-11111111', 'http://localhost:5173/')
      stub.evaluateValue = { ok: true, selector: 42 }
      const result = await engine.inspectAt('w-11111111', 1, 1, 'hover')
      expect(result.ok).toBe(false)
    })
  })
})

describe('parseTileInspectRequest', () => {
  it('accepts a valid inspect request', () => {
    expect(
      parseTileInspectRequest({ type: 'inspect', id: 'i-1', x: 10.5, y: 20, grade: 'hover' }),
    ).toEqual({ id: 'i-1', x: 10.5, y: 20, grade: 'hover' })
  })

  it('rejects bad grades, coordinates, and ids', () => {
    expect(parseTileInspectRequest({ type: 'inspect', id: 'i', x: 1, y: 1, grade: 'poke' })).toBeNull()
    expect(parseTileInspectRequest({ type: 'inspect', id: 'i', x: -1, y: 1, grade: 'hover' })).toBeNull()
    expect(parseTileInspectRequest({ type: 'inspect', id: 'x'.repeat(65), x: 1, y: 1, grade: 'hover' })).toBeNull()
    expect(parseTileInspectRequest({ type: 'inspect', x: 1, y: 1, grade: 'hover' })).toBeNull()
  })
})

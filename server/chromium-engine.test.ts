import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChromiumEngine,
  findChromiumBinary,
  parseTileInputEvent,
  parseTileInspectRequest,
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
  /** Methods that should fail with a CDP error on their next call. */
  private readonly failingMethods = new Set<string>()

  failNext(method: string): void {
    this.failingMethods.add(method)
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
        if (this.failingMethods.delete(message.method)) {
          socket.send(JSON.stringify({ id: message.id, error: { message: `${message.method} failed (stub)` } }))
          return
        }
        if (message.method === 'Runtime.evaluate') {
          socket.send(JSON.stringify({ id: message.id, result: { result: { type: 'object', value: this.evaluateValue } } }))
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

async function createHarness(): Promise<Harness> {
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
      params: { url: 'http://localhost:5173/', newWindow: true },
    })
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

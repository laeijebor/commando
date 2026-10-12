import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_WEB_PANES, MAX_WEB_PANE_TITLE_LENGTH, type WebPane } from '../shared/protocol.js'
import {
  buildWebPanesMessage,
  WebPaneError,
  WebPaneService,
  classifyWebPaneUrl,
  defaultWebPaneStatePath,
} from './web-panes.js'

const temporaryDirectories: string[] = []
const services: WebPaneService[] = []

async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-web-panes-'))
  temporaryDirectories.push(directory)
  return join(directory, 'web-panes.json')
}

function track(service: WebPaneService): WebPaneService {
  services.push(service)
  return service
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  // Persistence is queued asynchronously; settle it before deleting the
  // directories or an in-flight temp file races the rm.
  await Promise.all(services.splice(0).map((service) => service.flush()))
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const anchor = {
  anchorPaneId: '%12',
  sessionId: '$1',
  windowId: '@3',
  openedBy: 'agent' as const,
}

describe('classifyWebPaneUrl', () => {
  it('opens localhost and loopback urls immediately', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://127.0.0.1:41300/streaks-plan',
      'http://app.localhost:3000/page',
      'http://[::1]:8080/',
    ]) {
      expect(classifyWebPaneUrl(url, new Set()).kind, url).toBe('open')
    }
  })

  it('requires confirmation for external origins until allowlisted', () => {
    const external = classifyWebPaneUrl('https://reactnative.dev/docs/flatlist', new Set())
    expect(external).toMatchObject({ kind: 'confirm', origin: 'https://reactnative.dev' })

    const allowed = classifyWebPaneUrl(
      'https://reactnative.dev/docs/flatlist',
      new Set(['https://reactnative.dev']),
    )
    expect(allowed.kind).toBe('open')
  })

  it('rejects non-http schemes, credentials, and oversized urls', () => {
    expect(classifyWebPaneUrl('file:///etc/passwd', new Set()).kind).toBe('invalid')
    expect(classifyWebPaneUrl('javascript:alert(1)', new Set()).kind).toBe('invalid')
    expect(classifyWebPaneUrl('https://user:pw@example.com/', new Set()).kind).toBe('invalid')
    expect(classifyWebPaneUrl('not a url', new Set()).kind).toBe('invalid')
    expect(classifyWebPaneUrl(`https://example.com/${'a'.repeat(3000)}`, new Set()).kind).toBe('invalid')
  })

  it('does not treat localhost lookalike hostnames as local', () => {
    expect(classifyWebPaneUrl('https://localhost.evil.com/', new Set()).kind).toBe('confirm')
    expect(classifyWebPaneUrl('https://127.0.0.1.evil.com/', new Set()).kind).toBe('confirm')
  })
})

describe('WebPaneService', () => {
  it('scopes the default state path by tmux socket unless explicitly overridden', () => {
    const homeDirectory = '/tmp/commando-home'
    const legacy = defaultWebPaneStatePath({}, homeDirectory)
    const first = defaultWebPaneStatePath({ COMMANDO_TMUX_SOCKET_NAME: 'first' }, homeDirectory)
    const second = defaultWebPaneStatePath({ COMMANDO_TMUX_SOCKET_NAME: 'second' }, homeDirectory)
    const byPath = defaultWebPaneStatePath({ COMMANDO_TMUX_SOCKET_PATH: '/tmp/tmux.sock' }, homeDirectory)

    expect(new Set([legacy, first, second, byPath]).size).toBe(4)
    expect(defaultWebPaneStatePath({ COMMANDO_WEB_PANES_PATH: '/tmp/custom.json' }, homeDirectory))
      .toBe('/tmp/custom.json')
  })

  it('caps, persists and clears Chromium titles only when they change', async () => {
    const statePath = await temporaryStatePath()
    const service = track(new WebPaneService(statePath))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/', engine: 'chromium' })
    expect(service.setTitle(pane.id, 'x'.repeat(MAX_WEB_PANE_TITLE_LENGTH + 20))).toBe(true)
    expect(service.get(pane.id)?.title).toHaveLength(MAX_WEB_PANE_TITLE_LENGTH)
    const titled = service.get(pane.id)
    expect(service.setTitle(pane.id, 'x'.repeat(MAX_WEB_PANE_TITLE_LENGTH + 30))).toBe(false)
    expect(service.get(pane.id)).toBe(titled)
    await service.flush()
    const restored = track(new WebPaneService(statePath))
    await restored.load()
    expect(restored.list()[0].title).toBe(titled?.title)
    expect(service.setTitle(pane.id, '')).toBe(true)
    expect(service.get(pane.id)).not.toHaveProperty('title')
    expect(service.setTitle(pane.id, '')).toBe(false)
    const webkit = service.open({ ...anchor, url: 'http://localhost:5173/webkit' })
    expect(service.setTitle(webkit.id, 'Ignored')).toBe(false)
    service.close(pane.id)
    expect(service.setTitle(pane.id, 'Closed tile')).toBe(false)
  })

  it.each([
    ['navigate', 'http://localhost:5173/other', 'open'],
    ['navigate', 'https://untrusted.example/page', 'pending'],
    ['repend', 'https://untrusted.example/page', 'pending'],
  ] as const)('%s clears the title when the URL changes to %s', async (method, url, status) => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/', engine: 'chromium' })
    service.setTitle(pane.id, 'Original page')
    expect(service[method](pane.id, pane.url)?.title).toBe('Original page')
    const navigated = service[method](pane.id, url)
    expect(navigated).toMatchObject({ url, status })
    expect(navigated).not.toHaveProperty('title')
    await service.flush()
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { panes: WebPane[] }
    expect(persisted.panes[0]).not.toHaveProperty('title')
  })

  it('coalesces title-only disk writes every two seconds while publishing state immediately', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    const first = service.open({ ...anchor, url: 'http://localhost:5173/', engine: 'chromium' })
    const second = service.open({ ...anchor, url: 'http://localhost:5173/second', engine: 'chromium' })
    await service.flush()
    vi.useFakeTimers()
    for (let index = 0; index < 8; index++) {
      service.setTitle(first.id, `First ${index}`)
      service.setTitle(second.id, `Second ${index}`)
      expect(service.get(first.id)?.title).toBe(`First ${index}`)
      expect(service.list()[1].title).toBe(`Second ${index}`)
      const persisted = JSON.parse(await readFile(path, 'utf8')) as { panes: WebPane[] }
      expect(persisted.panes.every((pane) => pane.title === undefined)).toBe(true)
      await vi.advanceTimersByTimeAsync(250)
    }
    await service.flush()
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { panes: WebPane[] }
    expect(persisted.panes.map((pane) => pane.title)).toEqual(['First 7', 'Second 7'])
    service.setTitle(first.id, 'Next batch')
    await vi.advanceTimersByTimeAsync(1_999)
    expect((JSON.parse(await readFile(path, 'utf8')) as { panes: WebPane[] }).panes[0].title).toBe('First 7')
    await vi.advanceTimersByTimeAsync(1)
    await service.flush()
    expect((JSON.parse(await readFile(path, 'utf8')) as { panes: WebPane[] }).panes[0].title).toBe('Next batch')
  })

  it('flushes a pending title write and cancels its timer', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/', engine: 'chromium' })
    await service.flush()
    vi.useFakeTimers()
    service.setTitle(pane.id, 'Pending title')
    expect(vi.getTimerCount()).toBe(1)
    await service.flush()
    expect(vi.getTimerCount()).toBe(0)
    expect((JSON.parse(await readFile(path, 'utf8')) as { panes: WebPane[] }).panes[0].title).toBe('Pending title')
  })

  it('includes pending titles in a normal write without delaying other pane changes', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/', engine: 'chromium' })
    await service.flush()
    vi.useFakeTimers()
    service.setTitle(pane.id, 'Current title')
    service.open({ ...anchor, url: 'http://localhost:5173/new' })
    expect(vi.getTimerCount()).toBe(0)
    await service.flush()
    expect((JSON.parse(await readFile(path, 'utf8')) as { panes: WebPane[] }).panes).toHaveLength(2)
    expect((JSON.parse(await readFile(path, 'utf8')) as { panes: WebPane[] }).panes[0].title).toBe('Current title')
  })

  it('opens localhost tiles immediately and external tiles as pending', async () => {
    const service = track(new WebPaneService(await temporaryStatePath(), () => 1_000))
    const local = service.open({ ...anchor, url: 'http://127.0.0.1:41300/plan' })
    expect(local).toMatchObject({ status: 'open', anchorPaneId: '%12', placement: 'right' })

    const external = service.open({ ...anchor, url: 'https://reactnative.dev/docs', placement: 'right' })
    expect(external).toMatchObject({ status: 'pending', placement: 'right' })
  })

  it('confirm opens a pending tile and optionally allowlists the origin', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pending = service.open({ ...anchor, url: 'https://reactnative.dev/docs' })
    expect(service.confirm(pending.id, true).status).toBe('open')

    const next = service.open({ ...anchor, url: 'https://reactnative.dev/blog' })
    expect(next.status).toBe('open')
  })

  it('persists panes and the allowlist across restarts', async () => {
    const statePath = await temporaryStatePath()
    const service = track(new WebPaneService(statePath, () => 42))
    const pending = service.open({ ...anchor, url: 'https://reactnative.dev/docs' })
    service.confirm(pending.id, true)
    service.open({ ...anchor, url: 'http://localhost:5173/' })
    await service.flush()

    const stored = JSON.parse(await readFile(statePath, 'utf8')) as {
      allowedOrigins: string[]
      panes: unknown[]
    }
    expect(stored.allowedOrigins).toEqual(['https://reactnative.dev'])
    expect(stored.panes).toHaveLength(2)

    const restored = track(new WebPaneService(statePath))
    await restored.load()
    expect(restored.list()).toHaveLength(2)
    expect(restored.open({ ...anchor, url: 'https://reactnative.dev/blog' }).status).toBe('open')
  })

  it('copies legacy state into an isolated registry without removing the source', async () => {
    const legacyPath = await temporaryStatePath()
    const isolatedPath = join(dirname(legacyPath), 'web-panes-isolated.json')
    const pane: WebPane = {
      id: 'w-0badcafe',
      ...anchor,
      url: 'http://localhost:5173/',
      placement: 'right',
      dock: 'panel',
      order: 0,
      unseen: false,
      layoutState: 'settled',
      engine: 'chromium',
      status: 'open',
      createdAt: 42,
    }
    await writeFile(legacyPath, `${JSON.stringify({
      version: 1,
      allowedOrigins: [],
      panes: [pane],
    })}\n`)

    const isolated = track(new WebPaneService(
      isolatedPath,
      Date.now,
      legacyPath,
      'name:isolated',
    ))
    await isolated.load()
    await isolated.flush()

    expect(isolated.get(pane.id)).toEqual(pane)
    const copied = JSON.parse(await readFile(isolatedPath, 'utf8')) as { panes: WebPane[] }
    const source = JSON.parse(await readFile(legacyPath, 'utf8')) as { panes: WebPane[] }
    expect(copied.panes).toEqual([pane])
    expect(source.panes).toEqual([pane])
  })

  it('rejects invalid urls, anchors, and enforces the pane cap', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    expect(() => service.open({ ...anchor, url: 'ftp://example.com/' })).toThrow(WebPaneError)
    expect(() => service.open({ ...anchor, url: 'http://localhost/', anchorPaneId: 'nope' })).toThrow(WebPaneError)

    for (let index = 0; index < MAX_WEB_PANES; index += 1) {
      service.open({ ...anchor, url: `http://localhost:${5000 + index}/` })
    }
    expect(() => service.open({ ...anchor, url: 'http://localhost:9999/' })).toThrow(/At most/)
  })

  it('defaults to the webkit engine and validates explicit engines', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    expect(service.open({ ...anchor, url: 'http://localhost:5173/' }).engine).toBe('webkit')
    expect(
      service.open({ ...anchor, url: 'http://localhost:5174/', engine: 'chromium' }).engine,
    ).toBe('chromium')
    expect(() =>
      service.open({ ...anchor, url: 'http://localhost:5175/', engine: 'gecko' as never }),
    ).toThrow(WebPaneError)
  })

  it('persists the engine and defaults legacy records to webkit', async () => {
    const statePath = await temporaryStatePath()
    const service = track(new WebPaneService(statePath))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/', engine: 'chromium' })
    await service.flush()

    const stored = JSON.parse(await readFile(statePath, 'utf8')) as { panes: Record<string, unknown>[] }
    expect(stored.panes[0].engine).toBe('chromium')
    delete stored.panes[0].engine
    const { writeFile } = await import('node:fs/promises')
    await writeFile(statePath, JSON.stringify(stored), 'utf8')

    const restored = track(new WebPaneService(statePath))
    await restored.load()
    expect(restored.get(pane.id)?.engine).toBe('webkit')
  })

  it('repend flips an open tile back to pending for un-allowlisted urls only', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/', engine: 'chromium' })

    const pended = service.repend(pane.id, 'https://tracking.example/away')
    expect(pended).toMatchObject({ status: 'pending', url: 'https://tracking.example/away' })

    // Local and allowlisted destinations never re-pend.
    expect(service.confirm(pane.id, true).status).toBe('open')
    expect(service.repend(pane.id, 'http://localhost:9999/fine')).toMatchObject({
      status: 'open',
      url: 'https://tracking.example/away',
    })
    expect(service.repend(pane.id, 'https://tracking.example/deeper')?.status).toBe('open')
    expect(service.repend(pane.id, 'https://other.example/page')?.status).toBe('pending')

    expect(service.repend('w-00000000', 'https://elsewhere.example/')).toBeUndefined()
  })

  it('close removes a tile and unknown ids are reported', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    expect(service.close(pane.id)).toBe(true)
    expect(service.close(pane.id)).toBe(false)
    expect(() => service.confirm('w-00000000', true)).toThrow(WebPaneError)
  })

  it('does not prune anything when every discovered window has no panes', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const windows = Array.from({ length: 23 }, (_, index) => ({
      id: `@${index}`,
      sessionId: '$1',
      paneIds: [] as string[],
    }))

    expect(service.prune(windows)).toBe(false)
    expect(service.panelActiveTabs()).toEqual({ '%12': pane.id })
    expect(service.get(pane.id)).toEqual(pane)
    expect(warn).toHaveBeenCalledWith(
      'web panes: skipped prune for degraded tmux snapshot (windows=23, panes=0)',
    )
  })

  it('preserves panes in an empty window inside an otherwise healthy snapshot', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })

    expect(service.prune([
      { id: '@3', sessionId: '$1', paneIds: [] },
      { id: '@4', sessionId: '$1', paneIds: ['%40'] },
    ])).toBe(false)
    expect(service.panelActiveTabs()).toEqual({ '%12': pane.id })
    expect(service.get(pane.id)).toEqual(pane)
  })

  it('prunes a pane whose window is absent from a healthy snapshot', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, windowId: '@9', url: 'http://localhost:5174/' })

    expect(service.prune([
      { id: '@3', sessionId: '$1', paneIds: ['%40'] },
    ])).toBe(true)
    expect(service.get(pane.id)).toBeUndefined()
  })

  it('re-anchors a pane when its anchor dies but its window has surviving panes', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })

    expect(service.prune([
      { id: '@3', sessionId: '$1', paneIds: ['%40', '%41'] },
    ])).toBe(true)
    expect(service.get(pane.id)).toMatchObject({ id: pane.id, anchorPaneId: '%40' })
  })

  it('prunes an owned pane when its whole session disappears', async () => {
    const statePath = await temporaryStatePath()
    const owner = track(new WebPaneService(
      statePath,
      Date.now,
      undefined,
      'name:first',
    ))
    const pane = owner.open({
      ...anchor,
      sessionId: '$18',
      windowId: '@18',
      url: 'http://localhost:5173/',
      engine: 'chromium',
    })
    await owner.flush()
    const restored = track(new WebPaneService(statePath, Date.now, undefined, 'name:first'))
    await restored.load()
    const remainingWindows = [
      { id: '@1', sessionId: '$2', paneIds: ['%1'] },
    ]

    expect(restored.prune(remainingWindows)).toBe(true)
    expect(restored.get(pane.id)).toBeUndefined()
  })

  it('does not prune a pane owned by another tmux socket', async () => {
    const statePath = await temporaryStatePath()
    const owner = track(new WebPaneService(statePath, Date.now, undefined, 'name:first'))
    const pane = owner.open({
      ...anchor,
      sessionId: '$18',
      windowId: '@18',
      url: 'http://localhost:5173/',
      engine: 'chromium',
    })
    await owner.flush()

    const foreign = track(new WebPaneService(statePath, Date.now, undefined, 'name:second'))
    await foreign.load()
    expect(foreign.prune([{ id: '@1', sessionId: '$18', paneIds: ['%1'] }])).toBe(false)
    expect(foreign.panelActiveTabs()).toEqual({ '%12': pane.id })
    expect(foreign.get(pane.id)).toEqual(pane)
  })

  it('does not prune an unstamped legacy pane when its session is absent', async () => {
    const statePath = await temporaryStatePath()
    await writeFile(statePath, `${JSON.stringify({
      version: 1,
      allowedOrigins: [],
      panes: [{
        id: 'w-0badcafe',
        ...anchor,
        sessionId: '$18',
        windowId: '@18',
        url: 'http://localhost:5173/',
        placement: 'right',
        engine: 'chromium',
        status: 'open',
        createdAt: 42,
      }],
    })}\n`)
    const service = track(new WebPaneService(statePath, Date.now, undefined, 'name:first'))
    await service.load()

    expect(service.prune([{ id: '@1', sessionId: '$2', paneIds: ['%1'] }])).toBe(false)
    expect(service.panelActiveTabs()).toEqual({ '%12': 'w-0badcafe' })
    expect(service.get('w-0badcafe')).toBeDefined()
  })

  it('keeps services with different state paths isolated', async () => {
    const firstPath = await temporaryStatePath()
    const secondPath = await temporaryStatePath()
    const first = track(new WebPaneService(firstPath))
    const second = track(new WebPaneService(secondPath))
    const firstPane = first.open({ ...anchor, url: 'http://localhost:5173/' })
    const secondPane = second.open({
      ...anchor,
      sessionId: '$2',
      windowId: '@4',
      url: 'http://localhost:5174/',
    })
    await Promise.all([first.flush(), second.flush()])

    second.prune([{ id: '@4', sessionId: '$2', paneIds: ['%40'] }])
    await second.flush()

    const restoredFirst = track(new WebPaneService(firstPath))
    const restoredSecond = track(new WebPaneService(secondPath))
    await Promise.all([restoredFirst.load(), restoredSecond.load()])
    expect(restoredFirst.list().map((pane) => pane.id)).toEqual([firstPane.id])
    expect(restoredSecond.list().map((pane) => pane.id)).toEqual([secondPane.id])
  })

  it('resolves auto placement from the anchor size at open', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const wide = service.open({
      ...anchor,
      dock: 'split',
      url: 'http://localhost:5173/',
      anchorSize: { cols: 200, rows: 50 },
    })
    expect(wide.placement).toBe('right')
    expect(wide).toMatchObject({
      layoutState: 'pending',
      anchorSize: { cols: 200, rows: 50 },
    })

    const tall = service.open({
      ...anchor,
      dock: 'split',
      url: 'http://localhost:5174/',
      anchorSize: { cols: 100, rows: 60 },
    })
    expect(tall.placement).toBe('below')
  })

  it('defaults auto placement to right when the anchor size is unknown', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/', placement: 'auto' })
    expect(pane.placement).toBe('right')
  })

  it('keeps an explicit placement even when the anchor size disagrees', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({
      ...anchor,
      dock: 'split',
      url: 'http://localhost:5173/',
      placement: 'below',
      anchorSize: { cols: 200, rows: 50 },
    })
    expect(pane.placement).toBe('below')
  })

  it('resolves persisted layout metadata once pane geometry is known', async () => {
    const statePath = await temporaryStatePath()
    await writeFile(statePath, `${JSON.stringify({
      version: 1,
      allowedOrigins: [],
      panes: [{
        id: 'w-0badcafe',
        url: 'http://localhost:5173/',
        sessionId: '$1',
        windowId: '@3',
        anchorPaneId: '%12',
        placement: 'auto',
        dock: 'split',
        openedBy: 'agent',
        status: 'open',
        createdAt: 42,
      }],
    })}\n`)
    const service = track(new WebPaneService(statePath))
    await service.load()

    const changed = service.resolveLayoutMetadata(
      (paneId) => (paneId === '%12' ? { cols: 80, rows: 60 } : undefined),
    )
    expect(changed).toBe(true)
    expect(service.get('w-0badcafe')).toMatchObject({
      placement: 'below',
      layoutState: 'pending',
      anchorSize: { cols: 80, rows: 60 },
    })

    await service.flush()
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as { panes: Array<Record<string, unknown>> }
    expect(stored.panes[0]).toMatchObject({
      placement: 'below',
      layoutState: 'pending',
      anchorSize: { cols: 80, rows: 60 },
    })

    expect(service.resolveLayoutMetadata(() => ({ cols: 80, rows: 60 }))).toBe(false)
  })

  it('leaves an auto placement pending until its anchor geometry appears', async () => {
    const statePath = await temporaryStatePath()
    await writeFile(statePath, `${JSON.stringify({
      version: 1,
      allowedOrigins: [],
      panes: [{
        id: 'w-0badcafe',
        url: 'http://localhost:5173/',
        sessionId: '$1',
        windowId: '@3',
        anchorPaneId: '%12',
        placement: 'auto',
        dock: 'split',
        openedBy: 'agent',
        status: 'open',
        createdAt: 42,
      }],
    })}\n`)
    const service = track(new WebPaneService(statePath))
    await service.load()

    expect(service.resolveLayoutMetadata(() => undefined)).toBe(false)
    expect(service.get('w-0badcafe')?.placement).toBe('auto')
  })

  it('settles pending tile layouts once the anchor snapshot reflects the split grid', async () => {
    const statePath = await temporaryStatePath()
    const service = track(new WebPaneService(statePath))
    const pane = service.open({
      ...anchor,
      dock: 'split',
      url: 'http://localhost:5173/',
      anchorSize: { cols: 104, rows: 50 },
    })

    expect(service.resolveLayoutMetadata(() => ({ cols: 52, rows: 50 }))).toBe(true)
    expect(service.get(pane.id)).toMatchObject({ layoutState: 'settled' })
    expect(service.get(pane.id)?.anchorSize).toBeUndefined()
    expect(service.resolveLayoutMetadata(() => ({ cols: 52, rows: 50 }))).toBe(false)

    await service.flush()
    const restored = track(new WebPaneService(statePath))
    await restored.load()
    expect(restored.get(pane.id)).toMatchObject({ layoutState: 'settled' })
    expect(restored.get(pane.id)?.anchorSize).toBeUndefined()
  })

  it('does not warn for an empty snapshot without web panes or selections', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(service.prune([])).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not prune anything from an empty snapshot', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(service.prune([])).toBe(false)
    expect(service.panelActiveTabs()).toEqual({ '%12': pane.id })
    expect(service.list()).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(
      'web panes: skipped prune for degraded tmux snapshot (windows=0, panes=0)',
    )
  })

  it('ignores a corrupt allowlist entry instead of failing the whole load', async () => {
    const statePath = await temporaryStatePath()
    const service = track(new WebPaneService(statePath))
    service.open({ ...anchor, url: 'http://localhost:5173/' })
    await service.flush()

    const stored = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    stored.allowedOrigins = ['not a url', 'https://ok.example']
    const { writeFile } = await import('node:fs/promises')
    await writeFile(statePath, JSON.stringify(stored), 'utf8')

    const restored = track(new WebPaneService(statePath))
    await restored.load()
    expect(restored.list()).toHaveLength(1)
    expect(restored.open({ ...anchor, url: 'https://ok.example/page' }).status).toBe('open')
  })

  it('move re-anchors a tile with a new concrete placement and persists it', async () => {
    const statePath = await temporaryStatePath()
    const service = track(new WebPaneService(statePath))
    const pane = service.open({ ...anchor, dock: 'split', url: 'http://localhost:5173/' })

    const moved = service.move(pane.id, {
      anchorPaneId: '%40',
      placement: 'below',
      sessionId: '$1',
      windowId: '@3',
      anchorSize: { cols: 80, rows: 60 },
    })
    expect(moved).toMatchObject({
      id: pane.id,
      anchorPaneId: '%40',
      placement: 'below',
      layoutState: 'pending',
      anchorSize: { cols: 80, rows: 60 },
    })
    expect(service.get(pane.id)).toMatchObject({
      anchorPaneId: '%40',
      placement: 'below',
      layoutState: 'pending',
      anchorSize: { cols: 80, rows: 60 },
    })

    await service.flush()
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as {
      panes: Array<Record<string, unknown>>
    }
    expect(stored.panes[0]).toMatchObject({
      anchorPaneId: '%40',
      placement: 'below',
      layoutState: 'pending',
      anchorSize: { cols: 80, rows: 60 },
    })
  })

  it('move rejects unknown tiles, bad anchor ids, and non-concrete placements', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    const target = {
      anchorPaneId: '%40',
      placement: 'below' as const,
      sessionId: '$1',
      windowId: '@3',
    }
    expect(() => service.move('w-00000000', target)).toThrow(WebPaneError)
    expect(() => service.move(pane.id, { ...target, anchorPaneId: 'nope' })).toThrow(/anchor/i)
    expect(() => service.move(pane.id, { ...target, placement: 'auto' as never })).toThrow(/placement/i)
  })

  it('move rejects a target anchor in a different window', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    expect(() =>
      service.move(pane.id, {
        anchorPaneId: '%40',
        placement: 'right',
        sessionId: '$1',
        windowId: '@9',
      }),
    ).toThrow(/window/i)
  })

  it('navigate swaps the url and keeps localhost tiles open', async () => {
    const statePath = await temporaryStatePath()
    const service = track(new WebPaneService(statePath))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })

    const navigated = service.navigate(pane.id, 'http://127.0.0.1:4310/other')
    expect(navigated).toMatchObject({ url: 'http://127.0.0.1:4310/other', status: 'open' })

    await service.flush()
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as { panes: Array<{ url: string }> }
    expect(stored.panes[0].url).toBe('http://127.0.0.1:4310/other')
  })

  it('navigate to an unconfirmed external origin flips the tile to pending', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    expect(service.navigate(pane.id, 'https://reactnative.dev/docs')).toMatchObject({
      url: 'https://reactnative.dev/docs',
      status: 'pending',
    })
  })

  it('navigate to an allowlisted external origin stays open', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pending = service.open({ ...anchor, url: 'https://reactnative.dev/docs' })
    service.confirm(pending.id, true)
    expect(service.navigate(pending.id, 'https://reactnative.dev/blog')).toMatchObject({
      status: 'open',
    })
  })

  it('navigate rejects invalid urls and unknown tiles', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })
    expect(() => service.navigate(pane.id, 'ftp://example.com/')).toThrow(WebPaneError)
    expect(() => service.navigate('w-00000000', 'http://localhost:5173/')).toThrow(WebPaneError)
  })

  it('navigate with attribution updates openedBy and openerLabel', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({
      ...anchor,
      url: 'http://localhost:5173/',
      openedBy: 'user',
    })

    const navigated = service.navigate(pane.id, 'http://127.0.0.1:4310/other', {
      openedBy: 'agent',
      openerLabel: 'claude · gizmo',
    })
    expect(navigated).toMatchObject({ openedBy: 'agent', openerLabel: 'claude · gizmo' })
  })

  it('navigate without attribution preserves the existing openedBy and openerLabel', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({
      ...anchor,
      url: 'http://localhost:5173/',
      openedBy: 'user',
    })

    const navigated = service.navigate(pane.id, 'http://127.0.0.1:4310/other')
    expect(navigated).toMatchObject({ openedBy: 'user' })
    expect(navigated.openerLabel).toBeUndefined()
  })

  it('navigate with an agent attribution lacking a label drops openerLabel', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const pane = service.open({
      ...anchor,
      url: 'http://localhost:5173/',
      openedBy: 'user',
      openerLabel: 'stale-label',
    })

    const navigated = service.navigate(pane.id, 'http://127.0.0.1:4310/other', {
      openedBy: 'agent',
    })
    expect(navigated.openedBy).toBe('agent')
    expect(navigated.openerLabel).toBeUndefined()
  })
})


describe('persisted simulator tiles', () => {
  const udid = 'AAAAAAAA-1111-1111-1111-111111111111'
  it('deduplicates by udid, preserves its anchor across restart and reuses move/close behavior', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    const tile = service.open({ ...anchor, url: '', content: { kind: 'simulator', udid: udid.toLowerCase() }, anchorSize: { cols: 180, rows: 50 } })
    expect(tile).toMatchObject({ content: { kind: 'simulator', udid }, url: '', status: 'open', placement: 'right', layoutState: 'settled' })
    expect(service.open({ ...anchor, anchorPaneId: '%13', url: '', content: { kind: 'simulator', udid } })).toEqual(tile)
    expect(service.list()).toHaveLength(1)
    await service.flush()
    const stored = await readFile(path, 'utf8'); expect(stored).not.toContain('token'); expect(stored).not.toContain('/view')
    const restarted = track(new WebPaneService(path)); await restarted.load()
    expect(restarted.list()).toEqual([{ ...tile, activeTab: true }])
    expect(restarted.move(tile.id, { ...anchor, anchorPaneId: '%13', placement: 'below' })).toMatchObject({ anchorPaneId: '%13', placement: 'below' })
    expect(() => restarted.navigate(tile.id, 'http://localhost/')).toThrow('Simulator tiles cannot navigate')
    expect(restarted.close(tile.id)).toBe(true); await restarted.flush()
    const closed = track(new WebPaneService(path)); await closed.load(); expect(closed.list()).toEqual([])
  })
  it('rejects invalid simulator identities and restores legacy URL tiles alongside simulator tiles', async () => {
    const path = await temporaryStatePath(); const service = track(new WebPaneService(path))
    expect(() => service.open({ ...anchor, url: '', content: { kind: 'simulator', udid: 'bad' } })).toThrow('Invalid simulator')
    const browser = service.open({ ...anchor, url: 'http://localhost/plan' })
    const simulator = service.open({ ...anchor, url: '', content: { kind: 'simulator', udid } })
    await service.flush(); const restarted = track(new WebPaneService(path)); await restarted.load()
    expect(restarted.list()).toEqual([{ ...browser, activeTab: true }, { ...simulator, activeTab: false }])
  })
})

describe('panel tab state', () => {
  it('defaults new tiles to settled panel tabs with per-anchor order and agent unseen state', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const first = service.open({ ...anchor, url: 'http://localhost/1', anchorSize: { cols: 100, rows: 30 } })
    const other = service.open({ ...anchor, anchorPaneId: '%13', url: 'http://localhost/other', openedBy: 'user' })
    const second = service.open({ ...anchor, url: 'http://localhost/2' })
    expect(first).toMatchObject({ dock: 'panel', order: 0, unseen: true, layoutState: 'settled' })
    expect(first.anchorSize).toBeUndefined()
    expect(other).toMatchObject({ order: 0, unseen: false })
    expect(second.order).toBe(1)
    expect(service.resolveLayoutMetadata(() => ({ cols: 50, rows: 15 }))).toBe(false)
  })

  it('migrates legacy records in creation order and persists the result', async () => {
    const statePath = await temporaryStatePath()
    const legacy = (id: string, createdAt: number, anchorPaneId = '%12') => ({
      ...anchor, id, createdAt, anchorPaneId, url: 'http://localhost/', placement: 'below',
      engine: 'webkit', status: 'open', layoutState: 'pending', anchorSize: { cols: 100, rows: 30 },
    })
    await writeFile(statePath, JSON.stringify({ version: 1, allowedOrigins: [], panes: [
      legacy('w-00000003', 30), legacy('w-00000001', 10), legacy('w-00000002', 20), legacy('w-00000004', 40, '%13'),
    ] }))
    const service = track(new WebPaneService(statePath))
    await service.load()
    expect(service.list().map((pane) => [pane.id, pane.order])).toEqual([
      ['w-00000003', 2], ['w-00000001', 0], ['w-00000002', 1], ['w-00000004', 0],
    ])
    expect(service.list().every((pane) => pane.dock === 'panel' && pane.layoutState === 'settled' && !pane.anchorSize && !pane.unseen)).toBe(true)
    expect(service.list().find((pane) => pane.activeTab)?.id).toBe('w-00000001')
    await service.flush()
    const stored = JSON.parse(await readFile(statePath, 'utf8'))
    expect(stored.activeTabs).toEqual({ '%12': 'w-00000001', '%13': 'w-00000004' })
    expect(stored.panes[0].dock).toBe('panel')
  })

  it('persists selection without clearing unseen and falls to neighbouring tabs after deletion', async () => {
    const statePath = await temporaryStatePath()
    const service = track(new WebPaneService(statePath))
    const tabs = [1, 2, 3].map((n) => service.open({ ...anchor, url: `http://localhost/${n}` }))
    service.setActiveTab(tabs[1].id)
    expect(service.get(tabs[1].id)?.unseen).toBe(true)
    await service.flush()
    const restored = track(new WebPaneService(statePath))
    await restored.load()
    expect(restored.list().find((pane) => pane.activeTab)?.id).toBe(tabs[1].id)
    expect(restored.get(tabs[1].id)?.unseen).toBe(true)
    restored.clearUnseen(tabs[1].id)
    expect(restored.get(tabs[1].id)?.unseen).toBe(false)
    restored.close(tabs[1].id)
    expect(restored.list().find((pane) => pane.activeTab)?.id).toBe(tabs[2].id)
    restored.close(tabs[2].id)
    expect(restored.list().find((pane) => pane.activeTab)?.id).toBe(tabs[0].id)
    restored.close(tabs[0].id)
    await restored.flush()
    expect(JSON.parse(await readFile(statePath, 'utf8')).activeTabs).toEqual({ [anchor.anchorPaneId]: 'session' })
  })

  it('appends moved and orphaned tabs without losing either anchor selection', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const source = [1, 2].map((n) => service.open({ ...anchor, url: `http://localhost/${n}` }))
    const destination = service.open({ ...anchor, anchorPaneId: '%13', url: 'http://localhost/dest' })
    service.setActiveTab(source[0].id)
    const moved = service.move(source[0].id, { ...anchor, anchorPaneId: '%13', placement: 'right', anchorSize: { cols: 100, rows: 30 } })
    expect(moved).toMatchObject({ dock: 'panel', order: 1, layoutState: 'settled' })
    expect(service.list().filter((pane) => pane.activeTab).map((pane) => pane.id)).toEqual([source[1].id, destination.id])
    expect(service.prune([{ id: '@3', sessionId: '$1', paneIds: ['%13'] }])).toBe(true)
    expect(service.get(source[1].id)).toMatchObject({ anchorPaneId: '%13', order: 2, layoutState: 'settled' })
    expect(service.list().filter((pane) => pane.activeTab).map((pane) => pane.id)).toEqual([destination.id])
    service.move(source[1].id, { ...anchor, anchorPaneId: '%13', placement: 'below' })
    expect(service.get(source[1].id)?.order).toBe(2)
  })
})

describe('canvas tabs', () => {
  const content = { kind: 'canvas' as const, artifactId: '0123456789abcdef', manifest: 'canvas.json' }
  it('reuses and activates the same artifact at the same anchor, but keeps other anchors separate', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    const first = service.open({ ...anchor, url: 'http://localhost/redline/artifacts/0123456789abcdef/', content, engine: 'chromium', dock: 'split' })
    const other = service.open({ ...anchor, url: 'http://localhost/other' })
    service.setActiveTab(other.id)
    expect(service.open({ ...anchor, url: first.url, content }).id).toBe(first.id)
    expect(service.list().find((pane) => pane.activeTab)?.id).toBe(first.id)
    expect(first).toMatchObject({ engine: 'webkit', dock: 'panel', layoutState: 'settled', status: 'open' })
    expect(first.anchorSize).toBeUndefined()
    const second = service.open({ ...anchor, anchorPaneId: '%13', url: first.url, content })
    expect(second.id).not.toBe(first.id)
    await service.flush()
    const restored = track(new WebPaneService(path)); await restored.load()
    expect(restored.list()).toEqual(service.list())
    expect(() => restored.navigate(first.id, 'http://localhost/')).toThrow()
    expect(restored.close(first.id)).toBe(true)
  })
  it.each([{ ...content, artifactId: 'bad' }, { ...content, manifest: '../outside.json' }, { ...content, manifest: '' }, { kind: 'unknown' }])('rejects malformed content %j', async (bad) => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    expect(() => service.open({ ...anchor, url: 'http://localhost/', content: bad as never })).toThrow(WebPaneError)
  })
  it('defaults the manifest and ignores invalid persisted content', async () => {
    const path = await temporaryStatePath(), service = track(new WebPaneService(path))
    const pane = service.open({ ...anchor, url: 'http://localhost/', content: { kind: 'canvas', artifactId: content.artifactId } as never })
    expect(pane.content).toEqual(content)
    await service.flush()
    const raw = JSON.parse(await readFile(path, 'utf8'))
    raw.panes.push({ ...raw.panes[0], id: 'w-deadbeef', content: { ...content, manifest: '/outside' } })
    await writeFile(path, JSON.stringify(raw))
    const restored = track(new WebPaneService(path)); await restored.load()
    expect(restored.list()).toHaveLength(1)
  })
})

it('opens two manifests in the same canvas folder as separate tabs', async () => {
  const service = track(new WebPaneService(await temporaryStatePath()))
  const content = { kind: 'canvas' as const, artifactId: '0123456789abcdef', manifest: 'canvas.json' }
  const first = service.open({ ...anchor, url: 'http://localhost/', content })
  const second = service.open({ ...anchor, url: first.url, content: { ...content, manifest: 'second.json' } })
  expect(second.id).not.toBe(first.id)
  expect(service.open({ ...anchor, url: first.url, content }).id).toBe(first.id)
})

describe('built-in panel selection', () => {
  it.each(['pr', 'pr:12'])('retains legacy %s for client migration without web tabs', async (key) => {
    const path = await temporaryStatePath()
    await writeFile(path, JSON.stringify({ version: 1, panes: [], activeTabs: { '%12': key } }))
    const service = track(new WebPaneService(path))
    await service.load()
    expect(service.panelActiveTabs()).toEqual({ '%12': key })
  })

  it.each(['session', 'changes', 'pr:acme:widgets:12'])('prunes a disappeared pane with built-in %s selected and no web panes', async (key) => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    service.setActiveTab(key, '%12', () => true)
    service.setActiveTab('session', '%13', () => true)
    await service.flush()
    const before = await stat(path)
    expect(service.list()).toEqual([])
    expect(service.prune([{ id: '@3', sessionId: '$1', paneIds: ['%12', '%13'] }])).toBe(false)
    await service.flush()
    expect((await stat(path)).ino).toBe(before.ino)

    const windows = [{ id: '@3', sessionId: '$1', paneIds: ['%13'] }]
    expect(service.prune(windows)).toBe(true)
    expect(service.panelActiveTabs()).toEqual({ '%13': 'session' })
    await service.flush()
    const restored = track(new WebPaneService(path))
    await restored.load()
    expect(restored.panelActiveTabs()).toEqual({ '%13': 'session' })
    const after = await stat(path)
    expect(service.prune(windows)).toBe(false)
    // Reusing the pane id must not restore its previous conversation's tab.
    expect(service.prune([{ id: '@3', sessionId: '$1', paneIds: ['%12', '%13'] }])).toBe(false)
    expect(service.panelActiveTabs()).toEqual({ '%13': 'session' })
    await service.flush()
    expect((await stat(path)).ino).toBe(after.ino)
  })

  it.each([
    { name: 'empty', windows: [] },
    { name: 'all-empty windows', windows: [{ id: '@3', sessionId: '$1', paneIds: [] }] },
    { name: 'partially discovered', windows: [
      { id: '@3', sessionId: '$1', paneIds: [] },
      { id: '@4', sessionId: '$1', paneIds: ['%40'] },
    ] },
  ])('preserves built-in selections without web panes in a $name snapshot', async ({ windows }) => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    service.setActiveTab('pr:acme:widgets:12', '%12', () => true)
    await service.flush()
    const before = await stat(path)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(service.prune(windows)).toBe(false)
    expect(service.panelActiveTabs()).toEqual({ '%12': 'pr:acme:widgets:12' })
    await service.flush()
    expect((await stat(path)).ino).toBe(before.ino)
  })

  it.each(['session', 'changes', 'pr:acme:widgets:12'])('preserves built-in %s selections from another tmux socket', async (key) => {
    const path = await temporaryStatePath()
    const owner = track(new WebPaneService(path, Date.now, undefined, 'name:first'))
    owner.open({ ...anchor, url: 'http://localhost:5173/' })
    owner.setActiveTab(key, '%12', () => true)
    owner.setActiveTab('session', '%13', () => true)
    await owner.flush()
    const before = await stat(path)

    const foreign = track(new WebPaneService(path, Date.now, undefined, 'name:second'))
    await foreign.load()
    expect(foreign.prune([{ id: '@3', sessionId: '$1', paneIds: ['%40'] }])).toBe(false)
    expect(foreign.panelActiveTabs()).toEqual({ '%12': key, '%13': 'session' })
    await foreign.flush()
    expect((await stat(path)).ino).toBe(before.ino)
  })

  it('validates keys against live panes and persists anchors without web tabs', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    for (const key of ['session', 'changes', 'pr:acme:widgets:12']) {
      expect(() => service.setActiveTab(key, '%999', (id) => id === '%12')).toThrow('Anchor pane does not exist')
      service.setActiveTab(key, '%12', (id) => id === '%12')
      expect(service.panelActiveTabs()).toEqual({ '%12': key })
    }
    for (const key of ['pr', 'pr:12', 'pr:acme:widgets:0', 'pr:acme:widgets:-1', 'pr:acme:widgets:01', 'pr:acme:widgets:1.5', 'pr:acme:widgets:NaN', 'pr:acme:widgets:12junk', 'pr:acme:widgets:9007199254740992']) {
      expect(() => service.setActiveTab(key, '%12', () => true)).toThrow('Web pane does not exist')
    }
    expect(() => service.setActiveTab('unknown', '%12', () => true)).toThrow('Web pane does not exist')
    await service.flush()
    const restored = track(new WebPaneService(path))
    await restored.load()
    expect(restored.panelActiveTabs()).toEqual({ '%12': 'pr:acme:widgets:12' })
    const tile = restored.open({ ...anchor, url: 'http://localhost/plan' })
    expect(() => restored.setActiveTab(tile.id, '%13', () => true)).toThrow('Web pane is not a panel tab of this pane')
    restored.setActiveTab('session', '%12', () => true)
    expect(restored.get(tile.id)?.unseen).toBe(true)
    expect(restored.list()[0].activeTab).toBe(false)
  })
})

describe('dock changes', () => {
  it('keeps order, falls back to the next then previous tab, and activates on return across persistence', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    const tabs = [1, 2, 3].map((n) => service.open({ ...anchor, url: `http://localhost/${n}` }))
    service.setActiveTab(tabs[1].id)
    const split = service.dock(tabs[1].id, 'split', { cols: 80, rows: 50 })
    expect(split).toMatchObject({ dock: 'split', order: 1, placement: 'below', layoutState: 'pending', anchorSize: { cols: 80, rows: 50 } })
    expect(service.panelActiveTabs()['%12']).toBe(tabs[2].id)
    service.dock(tabs[2].id, 'split', { cols: 180, rows: 40 })
    expect(service.panelActiveTabs()['%12']).toBe(tabs[0].id)
    service.dock(tabs[0].id, 'split', { cols: 180, rows: 40 })
    expect(service.panelActiveTabs()['%12']).toBe('session')
    const returned = service.dock(tabs[1].id, 'panel')
    expect(returned).toMatchObject({ dock: 'panel', order: 1, layoutState: 'settled', unseen: false })
    expect(returned.anchorSize).toBeUndefined()
    expect(service.panelActiveTabs()['%12']).toBe(returned.id)
    await service.flush()
    const restored = track(new WebPaneService(path))
    await restored.load()
    expect(restored.get(returned.id)).toEqual(returned)
    expect(restored.panelActiveTabs()['%12']).toBe(returned.id)
    service.dock(tabs[0].id, 'panel')
    expect(service.list().filter((tab) => tab.dock === 'panel').sort((a, b) => a.order! - b.order!).map((tab) => tab.id)).toEqual([tabs[0].id, tabs[1].id])
  })

  it('rejects canvas splits, unknown dock values and invalid sizes', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const canvas = service.open({ ...anchor, url: 'http://localhost/canvas', content: { kind: 'canvas', artifactId: '0123456789abcdef', manifest: 'canvas.json' } })
    const web = service.open({ ...anchor, url: 'http://localhost/web' })
    for (const action of [() => service.dock(canvas.id, 'split', { cols: 100, rows: 30 }), () => service.dock(web.id, 'other'), () => service.dock(web.id, 'split', { cols: 0, rows: 30 }), () => service.dock(web.id, 'split')]) {
      expect(action).toThrow(expect.objectContaining({ status: 400 }))
    }
  })

  it('does not change selection, placement or metadata when already docked there', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const tab = service.open({ ...anchor, url: 'http://localhost/web' })
    service.setActiveTab('session', '%12', () => true)
    expect(service.dock(tab.id, 'panel')).toBe(tab)
    expect(service.panelActiveTabs()['%12']).toBe('session')
    const split = service.dock(tab.id, 'split', { cols: 180, rows: 40 })
    expect(service.dock(tab.id, 'split', { cols: 60, rows: 40 })).toBe(split)
  })
})

describe('URL open reuse', () => {
  it('does not reuse a URL tile stamped by another tmux socket', async () => {
    const path = await temporaryStatePath()
    const owner = track(new WebPaneService(path, Date.now, undefined, 'name:first'))
    const first = owner.open({ ...anchor, url: 'http://localhost/' })
    await owner.flush()
    const foreign = track(new WebPaneService(path, Date.now, undefined, 'name:second'))
    await foreign.load()
    const reopened = foreign.open({ ...anchor, url: first.url })
    expect(reopened.id).not.toBe(first.id)
    expect(foreign.list()).toHaveLength(2)
    expect(foreign.get(first.id)).toEqual(first)
    expect(foreign.open({ ...anchor, url: first.url }).id).toBe(reopened.id)
  })

  it.each([{ windowId: '@4' }, { sessionId: '$2' }])('does not reuse a URL tile outside its window or session: %j', async (target) => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const first = service.open({ ...anchor, url: 'http://localhost/' })
    const reopened = service.open({ ...anchor, ...target, url: first.url })
    expect(reopened.id).not.toBe(first.id)
    expect(service.list()).toHaveLength(2)
    expect(service.get(first.id)).toEqual(first)
  })

  it('normalizes URLs, increments each reopen even while unseen, and persists its revision', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    const first = service.open({ ...anchor, url: 'http://LOCALHOST:80' })
    const second = service.open({ ...anchor, url: 'http://localhost/' })
    expect(second).toMatchObject({ id: first.id, unseen: true, openRevision: 1, order: first.order })
    expect(service.open({ ...anchor, url: first.url }).openRevision).toBe(2)
    await service.flush()
    const restored = track(new WebPaneService(path))
    await restored.load()
    expect(restored.get(first.id)?.openRevision).toBe(2)
  })

  it('reuses split tiles without an unseen badge and leaves pending tiles untouched', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const split = service.open({ ...anchor, url: 'http://localhost/', dock: 'split' })
    expect(service.open({ ...anchor, url: split.url })).toMatchObject({ id: split.id, dock: 'split', unseen: false })
    const pending = service.open({ ...anchor, url: 'https://unconfirmed.example/' })
    expect(service.open({ ...anchor, url: pending.url })).toBe(pending)
  })
})


describe('PR tab dismissals', () => {
  const key = 'pr:acme:widgets:12'
  const exists = (id: string) => id === '%12'
  it('dismisses an active tab to Session, persists and restores it', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    service.setActiveTab(key, '%12', exists)
    service.dismissPrTab('%12', key, 'open|false|now', exists)
    expect(service.panelActiveTabs()['%12']).toBe('session')
    expect(service.panelDismissedPrTabs()).toEqual({ '%12': { [key]: 'open|false|now' } })
    const copy = service.panelDismissedPrTabs()
    copy['%12'][key] = 'mutated'
    await service.flush()
    const restored = track(new WebPaneService(path))
    await restored.load()
    expect(restored.panelDismissedPrTabs()['%12'][key]).toBe('open|false|now')
    restored.restorePrTab('%12', key, exists)
    await restored.flush()
    await service.load()
    expect(service.panelDismissedPrTabs()).toEqual({})
  })
  it('caps entries at 200 and drops the oldest dismissal, including after reload', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    for (let n = 1; n <= 201; n++) service.dismissPrTab('%12', `pr:acme:widgets:${n}`, '', exists)
    expect(Object.keys(service.panelDismissedPrTabs()['%12'])).toHaveLength(200)
    expect(service.panelDismissedPrTabs()['%12']['pr:acme:widgets:1']).toBeUndefined()
    service.dismissPrTab('%12', 'pr:acme:widgets:2', 'new', exists)
    service.dismissPrTab('%12', 'pr:acme:widgets:202', '', exists)
    expect(service.panelDismissedPrTabs()['%12']['pr:acme:widgets:3']).toBeUndefined()
    await service.flush()
    const restored = track(new WebPaneService(path))
    await restored.load()
    expect(restored.panelDismissedPrTabs()).toEqual(service.panelDismissedPrTabs())
  })
  it('rejects invalid keys, signatures and missing anchors without changing state', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    for (const invalid of ['session', 'pr:12', 'pr:acme:widgets:0', undefined]) {
      expect(() => service.dismissPrTab('%12', invalid as string, '', exists)).toThrow('Invalid PR tab key')
      expect(() => service.restorePrTab('%12', invalid as string, exists)).toThrow('Invalid PR tab key')
    }
    for (const invalid of ['x'.repeat(257), 1, null]) expect(() => service.dismissPrTab('%12', key, invalid as string, exists)).toThrow('Invalid PR tab signature')
    for (const anchor of ['%99', 'invalid', undefined]) {
      expect(() => service.dismissPrTab(anchor as string, key, '', exists)).toThrow('Anchor pane does not exist')
      expect(() => service.restorePrTab(anchor as string, key, exists)).toThrow('Anchor pane does not exist')
    }
    service.dismissPrTab('%12', key, 'x'.repeat(256), exists)
    expect(service.panelDismissedPrTabs()['%12'][key]).toHaveLength(256)
  })
  it('prunes dismissal-only panes only with a complete snapshot', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    service.dismissPrTab('%12', key, '', exists)
    expect(service.prune([])).toBe(false)
    expect(service.prune([{ id: '@1', sessionId: '$1', paneIds: ['%13'] }, { id: '@2', sessionId: '$1', paneIds: [] }])).toBe(false)
    expect(service.prune([{ id: '@1', sessionId: '$1', paneIds: ['%12'] }])).toBe(false)
    expect(service.prune([{ id: '@1', sessionId: '$1', paneIds: ['%13'] }])).toBe(true)
    expect(service.panelDismissedPrTabs()).toEqual({})
  })
  it('preserves dismissals when foreign or unstamped panes prevent pruning selections', async () => {
    const path = await temporaryStatePath()
    const owner = track(new WebPaneService(path, Date.now, undefined, 'owner-socket'))
    owner.open({ ...anchor, url: 'http://localhost/' })
    owner.dismissPrTab('%12', key, '', exists)
    await owner.flush()
    const foreign = track(new WebPaneService(path, Date.now, undefined, 'foreign-socket'))
    await foreign.load()
    const snapshot = [{ id: '@3', sessionId: '$2', paneIds: ['%13'] }]
    expect(foreign.prune(snapshot)).toBe(false)
    expect(foreign.panelDismissedPrTabs()['%12'][key]).toBe('')
    const raw = JSON.parse(await readFile(path, 'utf8'))
    delete raw.panes[0].tmuxSocketHash
    await writeFile(path, JSON.stringify(raw))
    await owner.load()
    expect(owner.prune(snapshot)).toBe(false)
    expect(owner.panelDismissedPrTabs()['%12'][key]).toBe('')
  })
  it.each(['session', 'changes', 'pr:acme:widgets:13'])('dismisses the active PR directly to %s and persists that selection', async (nextKey) => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    service.setActiveTab(key, '%12', exists)
    service.dismissPrTab('%12', key, 'old', exists, nextKey)
    expect(buildWebPanesMessage(service)).toMatchObject({ activeTabs: { '%12': nextKey }, dismissedPrTabs: { '%12': { [key]: 'old' } } })
    await service.flush()
    const restored = track(new WebPaneService(path))
    await restored.load()
    expect(restored.panelActiveTabs()['%12']).toBe(nextKey)
  })
  it('accepts only a panel web tab belonging to the dismissal anchor', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const next = service.open({ ...anchor, url: 'http://localhost/next' })
    const foreign = service.open({ ...anchor, anchorPaneId: '%13', url: 'http://localhost/foreign' })
    const split = service.open({ ...anchor, dock: 'split', url: 'http://localhost/split' })
    service.setActiveTab(key, '%12', exists)
    for (const invalid of [foreign.id, split.id, 'w-00000000', 'pr', key, '', 42, null]) {
      expect(() => service.dismissPrTab('%12', key, 'old', exists, invalid as string)).toThrow('Invalid next panel tab')
      expect(service.panelDismissedPrTabs()).toEqual({})
      expect(service.panelActiveTabs()['%12']).toBe(key)
    }
    service.dismissPrTab('%12', key, 'old', exists, next.id)
    expect(service.panelActiveTabs()['%12']).toBe(next.id)
    expect(service.list().find((pane) => pane.activeTab)?.id).toBe(next.id)
  })
  it.each(['session', 'changes', 'pr:other:widgets:12', 'pr:13'])('does not change an unrelated active selection (%s)', async (active) => {
    const path = await temporaryStatePath()
    await writeFile(path, JSON.stringify({ version: 1, activeTabs: { '%12': active }, allowedOrigins: [], panes: [] }))
    const service = track(new WebPaneService(path))
    await service.load()
    service.dismissPrTab('%12', key, 'old', exists, 'changes')
    expect(service.panelActiveTabs()['%12']).toBe(active)
  })
  it.each([
    ['pr', 'changes'], ['pr:12', 'pr:acme:widgets:13'], ['pr', undefined], ['pr:12', undefined],
  ])('dismisses a matching legacy active selection (%s) to %s', async (active, nextKey) => {
    const path = await temporaryStatePath()
    await writeFile(path, JSON.stringify({ version: 1, activeTabs: { '%12': active }, allowedOrigins: [], panes: [] }))
    const service = track(new WebPaneService(path))
    await service.load()
    service.dismissPrTab('%12', key, 'old', exists, nextKey)
    expect(service.panelActiveTabs()['%12']).toBe(nextKey ?? 'session')
    await service.flush()
    const restored = track(new WebPaneService(path))
    await restored.load()
    expect(restored.panelActiveTabs()['%12']).toBe(nextKey ?? 'session')
  })
  it('preserves the active PR on reload despite a stale dismissal entry', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    service.dismissPrTab('%12', key, 'old', exists)
    service.setActiveTab(key, '%12', exists)
    await service.flush()
    const restored = track(new WebPaneService(path))
    await restored.load()
    expect(restored.panelActiveTabs()['%12']).toBe(key)
    expect(restored.panelDismissedPrTabs()['%12'][key]).toBe('old')
  })
  it('restores without selecting by default and optionally restores and selects together', async () => {
    const path = await temporaryStatePath()
    const service = track(new WebPaneService(path))
    service.setActiveTab('changes', '%12', exists)
    service.dismissPrTab('%12', key, 'old', exists)
    service.restorePrTab('%12', key, exists)
    expect(service.panelActiveTabs()['%12']).toBe('changes')
    service.dismissPrTab('%12', key, 'old', exists)
    service.restorePrTab('%12', key, exists, true)
    expect(buildWebPanesMessage(service)).toMatchObject({ activeTabs: { '%12': key }, dismissedPrTabs: {} })
    await service.flush()
    const restored = track(new WebPaneService(path))
    await restored.load()
    expect(restored.panelActiveTabs()['%12']).toBe(key)
    expect(restored.panelDismissedPrTabs()).toEqual({})
  })

})


it('builds the web_panes broadcast with stored selection, dismissals and the remaining live state', async () => {
  const service = track(new WebPaneService(await temporaryStatePath()))
  const pane = service.open({ ...anchor, url: 'http://localhost/' })
  service.dismissPrTab('%12', 'pr:acme:widgets:12', 'old', (id) => id === '%12')
  const state = { feedback: {}, navigateRequests: {}, spotlightRequests: {}, reloads: { [pane.id]: 2 } }
  expect(buildWebPanesMessage(service, state)).toEqual({
    type: 'web_panes', webPanes: service.list(), activeTabs: { '%12': pane.id },
    dismissedPrTabs: { '%12': { 'pr:acme:widgets:12': 'old' } }, ...state,
  })
})

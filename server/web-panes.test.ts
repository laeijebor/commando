import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_WEB_PANES } from '../shared/protocol.js'
import { WebPaneError, WebPaneService, classifyWebPaneUrl } from './web-panes.js'

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

  it('prunes tiles for dead windows and re-anchors when the anchor pane dies', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const kept = service.open({ ...anchor, url: 'http://localhost:5173/' })
    const dead = service.open({ ...anchor, windowId: '@9', url: 'http://localhost:5174/' })

    const changed = service.prune([
      { id: '@3', paneIds: ['%40', '%41'] },
    ])
    expect(changed).toBe(true)
    const remaining = service.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ id: kept.id, anchorPaneId: '%40' })
    expect(service.get(dead.id)).toBeUndefined()
  })

  it('resolves auto placement from the anchor size at open', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    const wide = service.open({
      ...anchor,
      url: 'http://localhost:5173/',
      anchorSize: { cols: 200, rows: 50 },
    })
    expect(wide.placement).toBe('right')

    const tall = service.open({
      ...anchor,
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
      url: 'http://localhost:5173/',
      placement: 'below',
      anchorSize: { cols: 200, rows: 50 },
    })
    expect(pane.placement).toBe('below')
  })

  it('resolves persisted auto placements once pane geometry is known', async () => {
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
        openedBy: 'agent',
        status: 'open',
        createdAt: 42,
      }],
    })}\n`)
    const service = track(new WebPaneService(statePath))
    await service.load()

    const changed = service.resolveAutoPlacements(
      (paneId) => (paneId === '%12' ? { cols: 80, rows: 60 } : undefined),
    )
    expect(changed).toBe(true)
    expect(service.get('w-0badcafe')?.placement).toBe('below')

    await service.flush()
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as { panes: Array<{ placement: string }> }
    expect(stored.panes[0].placement).toBe('below')

    expect(service.resolveAutoPlacements(() => ({ cols: 80, rows: 60 }))).toBe(false)
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
        openedBy: 'agent',
        status: 'open',
        createdAt: 42,
      }],
    })}\n`)
    const service = track(new WebPaneService(statePath))
    await service.load()

    expect(service.resolveAutoPlacements(() => undefined)).toBe(false)
    expect(service.get('w-0badcafe')?.placement).toBe('auto')
  })

  it('does not prune anything from an empty snapshot', async () => {
    const service = track(new WebPaneService(await temporaryStatePath()))
    service.open({ ...anchor, url: 'http://localhost:5173/' })
    expect(service.prune([])).toBe(false)
    expect(service.list()).toHaveLength(1)
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
    const pane = service.open({ ...anchor, url: 'http://localhost:5173/' })

    const moved = service.move(pane.id, {
      anchorPaneId: '%40',
      placement: 'below',
      sessionId: '$1',
      windowId: '@3',
    })
    expect(moved).toMatchObject({ id: pane.id, anchorPaneId: '%40', placement: 'below' })
    expect(service.get(pane.id)).toMatchObject({ anchorPaneId: '%40', placement: 'below' })

    await service.flush()
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as {
      panes: Array<{ anchorPaneId: string; placement: string }>
    }
    expect(stored.panes[0]).toMatchObject({ anchorPaneId: '%40', placement: 'below' })
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

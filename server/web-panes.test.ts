import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    expect(local).toMatchObject({ status: 'open', anchorPaneId: '%12', placement: 'auto' })

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
})

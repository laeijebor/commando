import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRef } from '../shared/protocol.js'
import { CLOSED_WEB_PANE_TTL_MS, MAX_CLOSED_WEB_PANES_PER_TARGET } from './closed-web-panes.js'
import { buildWebPanesMessage, WebPaneError, WebPaneService } from './web-panes.js'

const TARGET = '11111111-1111-4111-8111-111111111111'
const OTHER_TARGET = '22222222-2222-4222-8222-222222222222'
const anchor = { anchorPaneId: '%12', sessionId: '$1', windowId: '@3', openedBy: 'agent' as const }
const directories: string[] = []
const services: WebPaneService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.flush()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup(options: { now?: () => number; path?: string; sessions?: Map<string, AgentSessionRef> } = {}) {
  let path = options.path
  if (!path) {
    const directory = await mkdtemp(join(tmpdir(), 'commando-closed-tabs-'))
    directories.push(directory)
    path = join(directory, 'web-panes.json')
  }
  const sessions = options.sessions ?? new Map<string, AgentSessionRef>()
  const targets = new Map([['%12', TARGET], ['%13', OTHER_TARGET]])
  const service = new WebPaneService(path, options.now ?? Date.now, undefined, 'owner', (paneId) => sessions.get(paneId))
  services.push(service)
  service.closedTabHooks = { targetIdFor: (paneId) => targets.get(paneId), titleFor: (pane) => pane.title }
  return { path, service, targets, sessions }
}

describe('closed tabs', () => {
  it('records closed tabs under the anchor target, newest first, with the closing client\'s title', async () => {
    const { service } = await setup()
    const page = service.open({ ...anchor, url: 'http://localhost:3000/report' })
    const redline = service.open({ ...anchor, url: 'http://127.0.0.1:4310/redline/artifacts/abc/plan.html' })
    expect(service.close(page.id, 'Coverage report')).toBe(true)
    service.close(redline.id)
    expect(service.closedTabs()).toEqual({
      [TARGET]: [
        expect.objectContaining({ id: redline.id, kind: 'redline', title: 'plan.html', url: redline.url }),
        expect.objectContaining({ id: page.id, kind: 'page', title: 'Coverage report', url: page.url }),
      ],
    })
    expect(buildWebPanesMessage(service).closedTabs).toEqual(service.closedTabs())
  })

  it('names canvases, slides and guides by kind', async () => {
    const { service } = await setup()
    const canvas = service.open({ ...anchor, url: 'http://127.0.0.1:4310/redline/artifacts/00000000000000a1/', content: { kind: 'canvas', artifactId: '00000000000000a1', manifest: 'canvas.json' } })
    const slides = service.open({ ...anchor, url: 'http://127.0.0.1:4310/redline/artifacts/00000000000000a2/', content: { kind: 'canvas', artifactId: '00000000000000a2', manifest: 'deck/index.html' } })
    const guide = service.open({ ...anchor, url: 'http://127.0.0.1:4310/redline/artifacts/00000000000000a3/', content: { kind: 'guide', artifactId: '00000000000000a3', file: 'docs/rotate.md' } })
    for (const pane of [canvas, slides, guide]) service.close(pane.id)
    expect(service.closedTabs()[TARGET].map(({ kind, title }) => [kind, title])).toEqual([
      ['guide', 'rotate.md'], ['slides', 'index.html'], ['canvas', 'canvas.json'],
    ])
  })

  it('skips simulators, unconfirmed and DevTools tabs, and anchors without a known target', async () => {
    const { service } = await setup()
    const simulator = service.open({ ...anchor, url: '', content: { kind: 'simulator', udid: '00000000-0000-0000-0000-000000000001' } })
    const pending = service.open({ ...anchor, url: 'https://example.com/' })
    const devtools = service.open({ ...anchor, url: 'http://127.0.0.1:9222/devtools/inspector.html?ws=x' })
    const unknown = service.open({ ...anchor, anchorPaneId: '%14', url: 'http://localhost/unknown' })
    for (const pane of [simulator, pending, devtools, unknown]) service.close(pane.id)
    expect(service.closedTabs()).toEqual({})
  })

  it('records tabs pruned with their pane but leaves conversation tabs to parking', async () => {
    const sessions = new Map<string, AgentSessionRef>()
    const { service } = await setup({ sessions })
    const plain = service.open({ ...anchor, url: 'http://localhost/plain' })
    sessions.set('%12', { provider: 'claude', id: 'conversation-123' })
    const owned = service.open({ ...anchor, url: 'http://localhost/owned' })
    expect(service.prune([{ id: '@9', sessionId: '$2', paneIds: ['%40'] }])).toBe(true)
    expect(service.get(plain.id)).toBeUndefined()
    expect(service.closedTabs()[TARGET].map((tab) => tab.id)).toEqual([plain.id])
    expect(service.parkedIds()).toContain(owned.id)
  })

  it('keeps one entry per content, at most 30 per target, for 14 days', async () => {
    let now = 1_000_000
    const { service } = await setup({ now: () => now })
    const first = service.open({ ...anchor, url: 'http://localhost/again' })
    service.close(first.id)
    now += 1
    const second = service.open({ ...anchor, url: 'http://localhost/again' })
    service.close(second.id)
    expect(service.closedTabs()[TARGET].map((tab) => tab.id)).toEqual([second.id])
    for (let index = 0; index < MAX_CLOSED_WEB_PANES_PER_TARGET + 5; index += 1) {
      now += 1
      service.close(service.open({ ...anchor, url: `http://localhost/page-${index}` }).id)
    }
    const tabs = service.closedTabs()[TARGET]
    expect(tabs).toHaveLength(MAX_CLOSED_WEB_PANES_PER_TARGET)
    expect(tabs[0].url).toBe(`http://localhost/page-${MAX_CLOSED_WEB_PANES_PER_TARGET + 4}`)
    now += CLOSED_WEB_PANE_TTL_MS
    expect(service.closedTabs()).toEqual({})
  })

  it('reopens under the original id beside the pane that now holds the target, selected', async () => {
    const { service, targets } = await setup()
    const live = service.open({ ...anchor, url: 'http://localhost/live' })
    const closed = service.open({ ...anchor, url: 'http://localhost/closed', dock: 'split', anchorSize: { cols: 200, rows: 50 } })
    service.close(closed.id)
    // An archive → restore gives the pane a new tmux id, but the same target.
    targets.set('%40', TARGET)
    const restored = { anchorPaneId: '%40', sessionId: '$2', windowId: '@9' }
    expect(() => service.reopenClosed(OTHER_TARGET, closed.id, restored)).toThrow(WebPaneError)
    const reopened = service.reopenClosed(TARGET, closed.id, restored)
    expect(reopened).toMatchObject({ id: closed.id, url: closed.url, ...restored, dock: 'panel', layoutState: 'settled', status: 'open' })
    expect(reopened.anchorSize).toBeUndefined()
    expect(service.panelActiveTabs()['%40']).toBe(closed.id)
    expect(service.closedTabs()).toEqual({})
    expect(service.get(live.id)).toBeDefined()
  })

  it('selects a live tab with the same content instead of duplicating it', async () => {
    const { service } = await setup()
    const closed = service.open({ ...anchor, url: 'http://localhost/same' })
    service.close(closed.id)
    const live = service.open({ ...anchor, url: 'http://localhost/same' })
    service.open({ ...anchor, url: 'http://localhost/other' })
    expect(service.reopenClosed(TARGET, closed.id, anchor).id).toBe(live.id)
    expect(service.panelActiveTabs()['%12']).toBe(live.id)
    expect(service.closedTabs()).toEqual({})
  })

  it('forgets entries, and round-trips the rest through the state file', async () => {
    let now = 5_000_000
    const { service, path } = await setup({ now: () => now })
    const kept = service.open({ ...anchor, url: 'http://localhost/kept' })
    const forgotten = service.open({ ...anchor, url: 'http://localhost/forgotten' })
    service.close(kept.id, 'Kept page')
    service.close(forgotten.id)
    expect(service.forgetClosed(TARGET, forgotten.id)).toBe(true)
    expect(service.forgetClosed(TARGET, forgotten.id)).toBe(false)
    await service.flush()
    expect(JSON.parse(await readFile(path, 'utf8')).closedPanes).toEqual([
      expect.objectContaining({ targetId: TARGET, closedAt: now, title: 'Kept page', pane: expect.objectContaining({ id: kept.id }) }),
    ])

    const { service: loaded } = await setup({ path, now: () => now })
    await loaded.load()
    expect(loaded.closedTabs()).toEqual({ [TARGET]: [expect.objectContaining({ id: kept.id, title: 'Kept page', closedAt: now })] })
    expect(loaded.parkedIds()).toContain(kept.id)

    now += CLOSED_WEB_PANE_TTL_MS
    const { service: expired } = await setup({ path, now: () => now })
    await expired.load()
    expect(expired.closedTabs()).toEqual({})
    await expired.flush()
    expect(JSON.parse(await readFile(path, 'utf8')).closedPanes).toEqual([])
  })
})

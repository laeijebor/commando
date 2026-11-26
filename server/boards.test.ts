import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_AUTO_TTL_MS, BoardStore, MAX_BOARD_ITEMS, MAX_BOARD_HISTORY, MAX_BOARD_STATE_BYTES, boardInput, copyBoardSnapshot, packBoardGroup, packBoardItem } from './boards.js'
import type { Board, BoardGroup, BoardItem } from '../shared/board.js'
import type { SessionBrief, WebPane } from '../shared/protocol.js'
import { MAX_ARTIFACT_DIRS, REDLINE_ARTIFACT_TTL_MS, RedlineArtifactRegistry } from './redline-artifacts.js'
import { WebPaneService } from './web-panes.js'
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, statSync: vi.fn(fs.statSync) }
})
const target = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const session = { provider: 'codex' as const, id: 'conversation-one' }
const anchor = { anchorPaneId: '%1', sessionId: '$1', windowId: '@1' }
const dirs: string[] = [], stores: BoardStore[] = []
function temp() { const d = realpathSync(mkdtempSync(join(tmpdir(), 'board-test-'))); dirs.push(d); return d }
function store(options: ConstructorParameters<typeof BoardStore>[0] = {}) { const s = new BoardStore(options); stores.push(s); return s }
function item(id = 'a', source: BoardItem['source'] = 'auto') { return { key: `url:https://example.com/${id}`, kind: 'link' as const, title: id, source, ref: { url: `https://example.com/${id}` } } }
afterEach(() => { for (const s of stores.splice(0)) s.flush(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('BoardStore', () => {
  it('merges references by canonical key, preserves added time/manual fields and notifies revisions', () => {
    let now = 1000
    const changed = vi.fn(), s = store({ now: () => now, onChange: changed })
    s.upsert(target, { ...item(), origin: { at: now, agentSession: session } })
    now++
    s.patch(target, item().key, { title: 'Curated', pinned: true, caption: 'Keep' }, 'user')
    now++
    s.upsert(target, { ...item(), title: 'Automatic', ref: { webPaneId: 'w-12345678' } })
    expect(s.get(target).items).toMatchObject([{ title: 'Curated', pinned: true, source: 'user', caption: 'Keep', addedAt: 1000, updatedAt: 1002, ref: { url: 'https://example.com/a', webPaneId: 'w-12345678' }, origin: { agentSession: session } }])
    expect(s.get(target).rev).toBe(3); expect(changed).toHaveBeenLastCalledWith(target, 3)
    expect(s.get(other).items).toEqual([])
    const external = s.get(target); external.items[0].title = 'mutated'
    expect(s.get(target).items[0].title).toBe('Curated')
  })
  it('atomically persists per target without derived state, reloads and rejects malformed state', () => {
    const root = temp(), s = store({ root })
    s.upsert(target, item()); s.upsert(other, item('b', 'agent')); s.flush()
    expect(readdirSync(root).sort()).toEqual([`${target}.json`, `${other}.json`])
    expect(readFileSync(join(root, `${target}.json`), 'utf8')).not.toContain('"state"')
    expect(store({ root }).view(target).items[0].state).toBe('open')
    writeFileSync(join(root, `${other}.json`), '{"board":{"targetId":"bad"}}')
    const onError = vi.fn(); expect(store({ root, onError }).get(other).items).toEqual([]); expect(onError).toHaveBeenCalled()
    expect(() => s.get('../../escape')).toThrow('Invalid board target')
  })
  it('expires only unpinned automatic items after their last update and cascades placements/links', () => {
    let now = 1000
    const s = store({ now: () => now })
    s.upsert(target, item()); s.upsert(target, { ...item('p'), pinned: true }); s.upsert(target, item('manual', 'agent'))
    s.group(target, 'g', { title: 'Group' }, 'agent', true)
    s.place(target, item().key, { group: 'g' }, 'agent'); s.link(target, item().key, 'g')
    now += BOARD_AUTO_TTL_MS
    expect(s.get(target).items.map((i) => i.title)).toEqual(['p', 'manual'])
    expect(s.get(target).placements).toEqual({}); expect(s.get(target).links).toEqual([])
  })
  it('evicts oldest unpinned auto first at the cap and refuses to discard protected items', () => {
    const s = store({ now: () => 1000 })
    s.upsert(target, { ...item('p'), pinned: true })
    for (let i = 0; i < MAX_BOARD_ITEMS - 1; i++) s.upsert(target, item(String(i)))
    s.upsert(target, item('last', 'agent'))
    expect(s.get(target).items).toHaveLength(500)
    expect(s.get(target).items.some((i) => i.title === '0')).toBe(false)
    expect(s.get(target).items.some((i) => i.title === 'p')).toBe(true)
    const full = store()
    for (let i = 0; i < MAX_BOARD_ITEMS; i++) full.upsert(target, item(String(i), 'user'))
    expect(() => full.upsert(target, item('overflow'))).toThrow('Board is full')
    expect(full.get(target).items).toHaveLength(500)
  })
  it('keeps captures idempotent and forgets dropped-item history across reload', () => {
    const root = temp(); let now = 1000
    const s = store({ root, now: () => now })
    s.capture(target, { ...item(), origin: { at: now, agentSession: session } }, 'event-one')
    now += 1000; s.capture(target, item(), 'event-one')
    expect(s.get(target).rev).toBe(1); expect(s.get(target).items[0].updatedAt).toBe(1000)
    s.remove(target, item().key); s.flush()
    const restored = store({ root, now: () => now })
    restored.capture(target, item(), 'event-one'); expect(restored.get(target).items).toHaveLength(1)
    restored.capture(target, item(), 'event-two'); expect(restored.get(target).items).toHaveLength(1)
  })
  it('bounds persisted capture history, hashes large fingerprints, and forgets evicted items', () => {
    const root = temp(), s = store({ root, now: () => 1000 })
    for (let i = 0; i <= MAX_BOARD_ITEMS; i++) s.capture(target, item(String(i)), 'large fingerprint '.repeat(1000))
    s.flush()
    const data = JSON.parse(readFileSync(join(root, `${target}.json`), 'utf8'))
    expect(Object.keys(data.observed)).toHaveLength(MAX_BOARD_ITEMS)
    expect(data.observed[item('0').key]).toBeUndefined()
    expect(Object.values(data.observed).every((v) => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v))).toBe(true)
    const legacy = Object.fromEntries(Array.from({ length: MAX_BOARD_HISTORY + 20 }, (_, i) => [item(`legacy-${i}`).key, 'raw history']))
    writeFileSync(join(root, `${other}.json`), JSON.stringify({ version: 1, board: { ...s.get(other), rev: 1 }, observed: legacy }))
    const restored = store({ root }); restored.capture(other, item('new')); restored.flush()
    const history = JSON.parse(readFileSync(join(root, `${other}.json`), 'utf8')).observed
    expect(Object.keys(history)).toHaveLength(MAX_BOARD_HISTORY)
    expect(history[item('legacy-0').key]).toBeUndefined()
  })
  it('never persists a payload above the loader limit and loudly reports oversized input files', () => {
    const root = temp(), board: Board = { targetId: target, rev: 1, items: Array.from({ length: 350 }, (_, i) => ({ ...item(String(i), 'user'), caption: '', addedAt: 0, updatedAt: 0 })), groups: [], links: [], placements: {} }
    let remaining = MAX_BOARD_STATE_BYTES - 1024 - Buffer.byteLength(JSON.stringify({ version: 1, board, observed: {} }))
    for (const i of board.items) { const chars = Math.min(16000, Math.floor(remaining / 3)); i.caption = '漢'.repeat(chars); remaining -= chars * 3 }
    const path = join(root, `${target}.json`)
    writeFileSync(path, JSON.stringify({ version: 1, board, observed: {} }))
    const s = store({ root, now: () => 0 })
    expect(s.get(target).items).toHaveLength(350)
    for (const i of board.items.slice(0, 12)) s.capture(target, i, 'new event')
    s.flush(); expect(statSync(path).size).toBeLessThanOrEqual(MAX_BOARD_STATE_BYTES)
    expect(() => s.upsert(target, { ...item('too-big', 'user'), caption: '漢'.repeat(16000) })).toThrow('16 MiB')
    expect(s.get(target).items).toHaveLength(350)
    const oversized = join(root, `${other}.json`); writeFileSync(oversized, ' '.repeat(MAX_BOARD_STATE_BYTES + 1))
    const onError = vi.fn(); store({ root, onError })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('16 MiB') }))
  }, 20000)
  it('keeps a learned PR title when a bare persisted ref is seen again', () => {
    const s = store()
    s.capturePr(target, { repo: 'Owner/Repo', number: 42, title: 'Add Board' }, session)
    const rev = s.get(target).rev
    s.capturePr(target, { repo: 'Owner/Repo', number: 42 }, session)
    expect(s.get(target).items[0].title).toBe('Add Board')
    expect(s.get(target).rev).toBe(rev)
  })
  it.each(['link', 'clip', 'pr'] as const)('always derives %s items as available without a tab or file', (kind) => {
    const s = store(), stored = s.upsert(target, { ...item(), kind, ref: {} })
    expect(s.state(stored, target)).toBe('open')
    expect(s.view(target).items[0].state).toBe('open')
  })
  it('stats shared file paths once per read and refreshes both positive and negative availability on the next read', () => {
    const dir = temp(), path = join(dir, 'present'), missing = join(dir, 'absent'), s = store()
    writeFileSync(path, 'file')
    for (const p of [path, missing]) for (const kind of ['screenshot', 'video', 'file', 'diagram'] as const) {
      s.upsert(target, { key: `file:${p}#${kind}`, kind, title: kind, source: 'user', ref: { path: p } })
    }
    const board = s.get(target), stats = vi.mocked(statSync)
    stats.mockClear()
    expect(s.view(target).items.map((i) => i.state)).toEqual(['open', 'open', 'open', 'open', 'missing', 'missing', 'missing', 'missing'])
    expect(stats.mock.calls.map(([p]) => p)).toEqual([path, missing])
    rmSync(path); writeFileSync(missing, 'now available'); stats.mockClear()
    expect(s.view(target).items.map((i) => i.state)).toEqual(['missing', 'missing', 'missing', 'missing', 'open', 'open', 'open', 'open'])
    expect(stats.mock.calls.map(([p]) => p)).toEqual([path, missing])
    expect(s.get(target)).toEqual(board)
  })
  it.each(['screenshot', 'video', 'file', 'diagram'] as const)('revives an available %s as a file path without requiring web panes', (kind) => {
    const dir = temp(), path = join(dir, 'file'), s = store()
    writeFileSync(path, 'file')
    const stored = s.upsert(target, { key: `file:${path}`, kind, title: kind, source: 'user', ref: { path } })
    expect(s.state(stored, target)).toBe('open')
    expect(s.revive(target, stored.key, anchor, 'user')).toEqual({ path })
    rmSync(path)
    expect(() => s.revive(target, stored.key, anchor, 'user')).toThrow('missing')
  })
  it('defaults agent groups to two columns, stacks them below all groups, and keeps existing/custom widths', () => {
    const s = store()
    const first = s.group(target, 'first', { title: 'First' }, 'agent', true)
    expect(first).toMatchObject({ w: 464, x: 0, y: 0 })
    for (const id of ['a', 'b', 'c']) s.upsert(target, item(id), 'first')
    const board = s.get(target), expanded = board.groups[0]
    expect(board.placements[item('a').key]).toMatchObject({ x: 12, y: 40 })
    expect(board.placements[item('b').key]).toMatchObject({ x: 232, y: 40 })
    expect(board.placements[item('c').key]).toMatchObject({ x: 12, y: 210 })
    const second = s.group(target, 'second', { title: 'Second' }, 'agent', true)
    expect(second).toMatchObject({ w: 464, x: 0, y: expanded.y + expanded.h + 32 })
    expect(s.group(target, 'adjacent', { title: 'Adjacent', near: 'first' }, 'agent', true)).toMatchObject({ x: 496, y: 0 })
    const custom = s.group(target, 'custom', { title: 'Custom', w: 900 }, 'user', true)
    expect(custom.w).toBe(900)
    expect(custom.y).toBe(second.y + second.h + 32)
    expect(s.group(target, 'custom', { title: 'Renamed' }, 'agent').w).toBe(900)
    expect(s.group(target, 'manual', { title: 'Manual', w: 800, x: 100, y: 200 }, 'user', true)).toMatchObject({ w: 800, x: 100, y: 200 })
  })
  it('packs group items, protects user drags, removes group into unplaced inbox and cascades links', () => {
    const s = store(); s.upsert(target, item()); s.upsert(target, item('b'))
    s.group(target, 'g', { title: 'First' }, 'agent', true); s.group(target, 'h', { title: 'Second', near: 'g' }, 'agent', true)
    s.place(target, item().key, { group: 'g', x: 10, y: 10, fixed: false }, 'user')
    expect(s.get(target).placements[item().key].fixed).toBe(true)
    expect(() => s.place(target, item().key, { group: 'h' }, 'agent')).toThrow('fixed')
    s.upsert(target, item(), 'h'); expect(s.get(target).placements[item().key].group).toBe('g')
    s.place(target, item('b').key, { group: 'g' }, 'agent'); s.link(target, 'g', item('b').key)
    expect(() => s.link(target, 'absent', 'g')).toThrow('endpoints')
    expect(() => s.group(target, 'g', { x: 10 }, 'agent')).toThrow('coordinates')
    s.removeGroup(target, 'g'); expect(s.get(target).placements).toEqual({ [item().key]: { x: 10, y: 10, fixed: true } }); expect(s.get(target).links).toEqual([])
  })
  it('captures brief URLs and image/video folders with correct origin and a 24 file cap', () => {
    const dir = temp(), s = store()
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `${i}.png`), 'image')
    writeFileSync(join(dir, '.secret.png'), 'secret'); symlinkSync('/etc/passwd', join(dir, 'escape.png'))
    const brief = { targetId: target, agentSession: session, references: [{ kind: 'url', value: 'https://example.com', label: 'Example' }, { kind: 'issue', value: 'https://github.com/a/b/issues/1' }, { kind: 'feature_flag', value: 'flag' }, { kind: 'session', value: 'codex resume abc' }, { kind: 'build', value: 'b1', url: 'https://ci.example/b1' }, { kind: 'release', value: 'v1' }], screenshots: [{ dir, updatedAt: 1000 }] } as SessionBrief
    s.captureBrief(brief)
    expect(s.get(target).items.filter((i) => i.kind === 'screenshot')).toHaveLength(24)
    expect(s.get(target).items.filter((i) => i.kind === 'link')).toHaveLength(3)
    expect(s.get(target).items.every((i) => i.origin?.agentSession?.id === session.id)).toBe(true)
    const video = temp(); writeFileSync(join(video, 'movie.mp4'), 'movie'); writeFileSync(join(video, 'anim.gif'), 'gif')
    s.captureFolder(target, video, 10, session)
    expect(s.get(target).items.find((i) => i.title === 'movie.mp4')?.kind).toBe('video')
    expect(s.get(target).items.find((i) => i.title === 'anim.gif')?.kind).toBe('screenshot')
  })
  it('infers manual input keys/kinds and rejects nonexistent, relative or special files', () => {
    const dir = temp(); writeFileSync(join(dir, 'a.gif'), 'gif'); writeFileSync(join(dir, 'a.mp4'), 'video'); writeFileSync(join(dir, 'canvas.json'), '{}'); writeFileSync(join(dir, 'index.html'), 'html')
    const artifacts = new RedlineArtifactRegistry()
    expect(boardInput({ path: dir }, 'agent', artifacts).kind).toBe('canvas')
    expect(boardInput({ path: join(dir, 'index.html') }, 'agent', artifacts).key).toBe(`canvas:${dir}#canvas.json`)
    expect(boardInput({ path: join(dir, 'a.gif') }, 'agent').kind).toBe('screenshot')
    expect(boardInput({ path: join(dir, 'a.mp4') }, 'agent').kind).toBe('video')
    expect(boardInput({ text: 'Decision' }, 'agent').caption).toBe('Decision')
    expect(() => boardInput({ path: '/definitely/missing' }, 'agent')).toThrow('exist')
    expect(() => boardInput({ path: 'relative' }, 'agent')).toThrow('absolute')
    expect(() => boardInput({ path: '/dev/null' }, 'agent')).toThrow('file')
    expect(() => boardInput({ text: 'a', url: 'https://a.com' }, 'agent')).toThrow('exactly one')
  })
})

describe('pure packing', () => {
  const g: BoardGroup = { id: 'g', title: 'Group', by: 'agent', x: 0, y: 0, w: 464, h: 100 }
  it('uses 220 by 170 cells, grows height and never mutates input', () => {
    const board: Board = { targetId: target, rev: 0, items: [], groups: [g], placements: {}, links: [] }
    const first = packBoardItem(board, 'a', 'g'); board.placements.a = first.placement
    const second = packBoardItem(board, 'b', 'g'); board.placements.b = second.placement
    const third = packBoardItem(board, 'c', 'g')
    expect(first.placement).toEqual({ group: 'g', x: 12, y: 40 }); expect(second.placement.x).toBe(232); expect(third.placement.y).toBe(210)
    expect(third.group.h).toBe(392); expect(g.h).toBe(100)
    board.groups[0] = { ...g, w: 244 }; expect(packBoardItem({ ...board, placements: { a: first.placement } }, 'b', 'g').placement.y).toBe(210)
  })
  it('places near a group without colliding with existing groups', () => {
    const obstacle = { ...g, id: 'obstacle', x: 496 }
    const result = packBoardGroup([g, obstacle], { ...g, id: 'new' }, 'g')
    expect(result).toMatchObject({ x: 496, y: 132 })
    expect(() => packBoardGroup([g], g, 'absent')).toThrow('Near group')
  })
  it('stacks below the lowest existing group rather than the last or rightmost one', () => {
    const lower = { ...g, id: 'lower', x: 100, y: 500 }
    const right = { ...g, id: 'right', x: 496 }
    expect(packBoardGroup([lower, right], { ...g, id: 'new' })).toMatchObject({ x: 0, y: 632 })
    expect(packBoardGroup([], g)).toMatchObject({ x: 0, y: 0 })
  })
})

describe('artifact lifetime, snapshot and revive', () => {
  async function fixture() {
    const dir = temp(), root = temp(), snapshots = temp()
    writeFileSync(join(dir, 'canvas.json'), '{"title":"Review","frames":[]}'); writeFileSync(join(dir, 'deck.html'), '<main class="deck"></main>'); writeFileSync(join(dir, 'guide.md'), '# Guide'); writeFileSync(join(dir, 'index.html'), '<h1>Redline</h1>')
    const artifacts = new RedlineArtifactRegistry(), id = artifacts.register(dir).id
    const webPanes = new WebPaneService(join(root, 'web.json'), undefined, undefined, 'board-test', () => session)
    const s = store({ root: join(root, 'boards'), snapshotRoot: snapshots, artifacts, webPanes })
    webPanes.closedTabHooks = { targetIdFor: () => target, onClosed: (t, p, title) => s.snapshotOnClose(t, p, title, session) }
    return { dir, root, snapshots, artifacts, id, webPanes, s }
  }
  it.each(['canvas', 'guide', 'redline'] as const)('revives %s as a durable read-only copy and restores to an editable folder under the same id', async (kind) => {
    const f = await fixture()
    const content: WebPane['content'] = kind === 'canvas' ? { kind, artifactId: f.id, manifest: 'canvas.json' } : kind === 'guide' ? { kind, artifactId: f.id, file: 'guide.md' } : undefined
    const pane = f.webPanes.open({ ...anchor, url: `http://localhost/redline/artifacts/${f.id}/index.html`, content, openedBy: 'user' })
    const key = f.s.captureWebPane(target, pane)!
    f.webPanes.close(pane.id)
    const savedAt = f.s.item(target, key).updatedAt
    rmSync(f.dir, { recursive: true })
    expect(f.s.revive(target, key, anchor, 'user')).toEqual({ webPaneId: pane.id })
    const copy = f.webPanes.get(pane.id)!
    expect(copy).toMatchObject({ readOnly: true, snapshotSavedAt: savedAt })
    if (copy.content?.kind !== 'simulator' && copy.content) expect(copy.content.readOnly).toBe(true)
    const copyId = f.s.item(target, key).ref.artifactId!
    expect(f.artifacts.isReadOnly(copyId)).toBe(true)
    expect(f.artifacts.register(f.artifacts.directory(copyId)!).id).toBe(copyId)
    expect(f.artifacts.isReadOnly(copyId)).toBe(true)
    await f.webPanes.flush()
    const loaded = new WebPaneService(join(f.root, 'web.json'), undefined, undefined, 'board-test')
    await loaded.load()
    expect(loaded.get(pane.id)).toMatchObject({ readOnly: true, snapshotSavedAt: savedAt, ...(copy.content ? { content: copy.content } : {}) })
    const dest = join(f.root, 'restored')
    mkdirSync(dest)
    writeFileSync(join(dest, 'keep.txt'), 'keep')
    expect(() => f.s.restoreSnapshot(pane.id, dest)).toThrow('already exists')
    expect(readFileSync(join(dest, 'keep.txt'), 'utf8')).toBe('keep')
    expect(() => f.s.restoreSnapshot(pane.id, 'relative')).toThrow('absolute')
    expect(() => f.s.restoreSnapshot(pane.id, join(f.snapshots, 'unsafe'))).toThrow('outside saved copies')
    rmSync(dest, { recursive: true })
    const restored = f.s.restoreSnapshot(pane.id, dest)
    expect(restored.id).toBe(pane.id)
    expect(restored.readOnly).toBeUndefined()
    if (restored.content && restored.content.kind !== 'simulator') expect(restored.content.readOnly).toBeUndefined()
    expect(f.s.get(target).items).toHaveLength(1)
    expect(f.s.item(target, key).ref.path).toBe(dest)
    expect(readFileSync(join(dest, 'guide.md'), 'utf8')).toBe('# Guide')
    expect(f.artifacts.isReadOnly(f.s.item(target, key).ref.artifactId!)).toBe(false)
    expect(f.s.view(target).items[0].state).toBe('open')
    expect(() => f.s.restoreSnapshot(pane.id, join(f.root, 'again'))).toThrow('not a saved copy')
    await f.webPanes.flush()
    await loaded.flush()
  })
  it('backfills every retained kind, including absent owners, once with the original close time', async () => {
    const f = await fixture()
    f.webPanes.closedTabHooks = { targetIdFor: () => other }
    for (const kind of ['canvas', 'slides', 'guide', 'redline', 'page'] as const) {
      const content: WebPane['content'] = kind === 'canvas' || kind === 'slides' ? { kind: 'canvas', artifactId: f.id, manifest: kind === 'slides' ? 'deck.html' : 'canvas.json' } : kind === 'guide' ? { kind, artifactId: f.id, file: 'guide.md' } : undefined
      const pane = f.webPanes.open({ ...anchor, url: kind === 'page' ? 'http://localhost/docs' : `http://localhost/redline/artifacts/${f.id}/index.html`, content, openedBy: 'user' })
      f.webPanes.close(pane.id)
    }
    f.webPanes.closedTabHooks.liveTargets = () => new Set()
    expect(f.webPanes.closedTabs()).toEqual({})
    f.s.backfillClosedTabs()
    expect(f.s.view(other).items.map((i) => i.kind).sort()).toEqual(['canvas', 'guide', 'page', 'redline', 'slides'])
    for (const entry of f.webPanes.closedEntries()) expect(f.s.get(other).items.find((i) => i.ref.webPaneId === entry.pane.id)?.closedAt).toBe(entry.closedAt)
    const before = f.s.get(other)
    f.s.backfillClosedTabs()
    expect(f.s.get(other)).toEqual(before)
    const page = before.items.find((i) => i.kind === 'page')!
    expect(f.s.revive(other, page.key, anchor, 'user')).toEqual({ webPaneId: page.ref.webPaneId })
    await f.webPanes.flush()
  })
  it.each(['page', 'redline'] as const)('preserves separate WebKit and Chromium %s cards, discussions ids, revival and forgetting', async (kind) => {
    const f = await fixture()
    f.webPanes.closedTabHooks = { targetIdFor: () => target }
    const url = kind === 'page' ? 'http://localhost/same-page' : `http://localhost/redline/artifacts/${f.id}/index.html`
    const panes = (['webkit', 'chromium'] as const).map((engine) => {
      const pane = f.webPanes.open({ ...anchor, url, engine, openedBy: 'user' })
      f.webPanes.close(pane.id)
      return pane
    })
    f.s.backfillClosedTabs(); f.s.flush()
    const s = store({ root: join(f.root, 'boards'), artifacts: f.artifacts, webPanes: f.webPanes })
    expect(s.get(target).items).toHaveLength(2)
    for (const pane of panes) {
      const item = s.get(target).items.find((i) => i.ref.webPaneId === pane.id)!
      expect(item.ref.engine).toBe(pane.engine)
      expect(s.revive(target, item.key, anchor, 'user').webPaneId).toBe(pane.id)
      expect(f.webPanes.get(pane.id)?.engine).toBe(pane.engine)
    }
    for (const pane of panes) f.webPanes.close(pane.id)
    const removed = s.get(target).items.find((i) => i.ref.webPaneId === panes[0].id)!
    s.remove(target, removed.key)
    expect(f.webPanes.closedEntries().map((e) => e.pane.id)).toEqual([panes[1].id])
    expect(s.get(target).items[0].ref.webPaneId).toBe(panes[1].id)
    expect(s.revive(target, s.get(target).items[0].key, anchor, 'user').webPaneId).toBe(panes[1].id)
    f.webPanes.close(panes[1].id); f.webPanes.forgetClosed(target, panes[1].id)
    const fresh = s.revive(target, s.get(target).items[0].key, anchor, 'user')
    expect(f.webPanes.get(fresh.webPaneId!)?.engine).toBe('chromium')
    await f.webPanes.flush()
  })
  it.each([
    ['http://localhost/x/', 'http://localhost/x'],
    ['http://localhost/x?utm_source=chat#notes', 'http://localhost/x'],
    ['http://localhost/x?b=2&a=1', 'http://localhost/x?a=1&b=2'],
  ])('merges cosmetic URL aliases %s and %s within one engine', async (first, second) => {
    const f = await fixture()
    const panes = [first, second].map((url) => {
      const pane = f.webPanes.open({ ...anchor, url, engine: 'chromium', openedBy: 'user' })
      f.webPanes.close(pane.id)
      return pane
    })
    expect(f.s.get(target).items).toHaveLength(1)
    const card = f.s.get(target).items[0]
    expect(card.key).toBe(`page:chromium:${second}`)
    expect(card.ref.webPaneId).toBe(panes[1].id)
    f.s.remove(target, card.key)
    expect(f.webPanes.closedEntries()).toEqual([])
    f.s.backfillClosedTabs()
    expect(f.s.get(target).items).toEqual([])
    await f.webPanes.flush()
  })
  it.each(['webkit', 'chromium'] as const)('merges a manual redline URL with a later %s close while preserving user fields', async (engine) => {
    const f = await fixture(), url = `http://localhost/redline/artifacts/${f.id}/index.html`
    const manual = f.s.upsert(target, boardInput({ url, title: 'Curated redline', caption: 'Keep this', pinned: true }, 'user', f.artifacts))
    const pane = f.webPanes.open({ ...anchor, url: `${url}?utm_source=preview#notes`, engine, openedBy: 'user' })
    f.webPanes.close(pane.id)
    expect(f.s.get(target).items).toHaveLength(1)
    expect(f.s.get(target).items[0]).toMatchObject({ key: manual.key, kind: 'redline', source: 'user', title: 'Curated redline', caption: 'Keep this', pinned: true, ref: { engine, webPaneId: pane.id } })
    expect(f.s.revive(target, manual.key, anchor, 'user').webPaneId).toBe(pane.id)
    await f.webPanes.flush()
  })
  it('migrates raw engine keys and duplicate manual cards while retaining metadata, placements, links and other engines', async () => {
    const f = await fixture()
    f.webPanes.closedTabHooks = { targetIdFor: () => target }
    const panes = [
      f.webPanes.open({ ...anchor, url: 'http://localhost/x/?utm_source=one#note', engine: 'webkit', openedBy: 'user' }),
      f.webPanes.open({ ...anchor, url: 'http://localhost/x', engine: 'webkit', openedBy: 'user' }),
      f.webPanes.open({ ...anchor, url: 'http://localhost/x/', engine: 'chromium', openedBy: 'user' }),
    ]
    for (const pane of panes) f.webPanes.close(pane.id)
    const cards: BoardItem[] = panes.map((pane, i) => ({ key: `page:${pane.engine}:${pane.url}`, kind: 'page', title: 'Captured', source: 'auto', ref: { url: pane.url, engine: pane.engine, webPaneId: pane.id }, addedAt: 1, updatedAt: 10 + i, closedAt: 10 + i }))
    const manual: BoardItem = { ...boardInput({ url: 'http://localhost/x', title: 'My page', caption: 'Preserve this', pinned: true }, 'user'), addedAt: 0, updatedAt: 2 }
    const clip: BoardItem = { key: 'clip:evidence', kind: 'clip', title: 'Evidence', source: 'user', ref: {}, addedAt: 1, updatedAt: 1 }
    const board: Board = { targetId: target, rev: 1, items: [...cards, manual, clip], groups: [], placements: { [manual.key]: { x: 50, y: 60, fixed: true }, [cards[0].key]: { x: 0, y: 0 } }, links: [{ id: 'evidence', from: cards[0].key, to: clip.key }, { id: 'existing-self-link', from: clip.key, to: clip.key }] }
    const root = join(f.root, 'boards'); mkdirSync(root)
    writeFileSync(join(root, `${target}.json`), JSON.stringify({ version: 1, board, observed: { [cards[0].key]: 'old capture' } }))
    const s = store({ root, now: () => 1000, webPanes: f.webPanes })
    const migrated = s.get(target), key = 'page:webkit:http://localhost/x'
    expect(migrated.items).toHaveLength(3)
    expect(migrated.items.find((i) => i.key === key)).toMatchObject({ title: 'My page', caption: 'Preserve this', source: 'user', pinned: true, addedAt: 0, ref: { engine: 'webkit', webPaneId: panes[1].id } })
    expect(migrated.items.find((i) => i.ref.engine === 'chromium')?.key).toBe('page:chromium:http://localhost/x')
    expect(migrated.placements).toEqual({ [key]: { x: 50, y: 60, fixed: true } })
    expect(migrated.links).toEqual([{ id: 'evidence', from: key, to: clip.key }, { id: 'existing-self-link', from: clip.key, to: clip.key }])
    s.flush()
    expect(store({ root, now: () => 1000, webPanes: f.webPanes }).get(target)).toEqual(migrated)
    const history = JSON.parse(readFileSync(join(root, `${target}.json`), 'utf8')).observed
    expect(history[cards[0].key]).toBeUndefined()
    expect(history[key]).toMatch(/^sha256:/)
    s.remove(target, key)
    expect(f.webPanes.closedEntries().map((e) => e.pane.id)).toEqual([panes[2].id])
    await f.webPanes.flush()
  })
  it('repairs close timestamps on existing cards, including previously marked migration ids', async () => {
    const f = await fixture()
    f.webPanes.closedTabHooks = { targetIdFor: () => target }
    const pane = f.webPanes.open({ ...anchor, url: 'http://localhost/long-running', openedBy: 'user' })
    const key = f.s.captureWebPane(target, pane)!
    f.webPanes.close(pane.id)
    const closedAt = f.webPanes.closedEntries()[0].closedAt
    expect(f.s.item(target, key).closedAt).toBeUndefined()
    f.s.backfillClosedTabs(); f.s.flush()
    expect(f.s.item(target, key).closedAt).toBe(closedAt)
    const path = join(f.root, 'boards', `${target}.json`), saved = JSON.parse(readFileSync(path, 'utf8'))
    delete saved.board.items[0].closedAt // A previous v2 run marked this id before copying its timestamp.
    writeFileSync(path, JSON.stringify(saved))
    const s = store({ root: join(f.root, 'boards'), webPanes: f.webPanes })
    s.backfillClosedTabs()
    expect(s.item(target, key).closedAt).toBe(closedAt)
    const rev = s.get(target).rev
    s.backfillClosedTabs()
    expect(s.get(target).rev).toBe(rev)
    await f.webPanes.flush()
  })
  it.each(['canvas', 'slides', 'guide', 'redline', 'page'] as const)('removing a closed %s card forgets only its retained tab', async (kind) => {
    const f = await fixture()
    const content: WebPane['content'] = kind === 'canvas' || kind === 'slides' ? { kind: 'canvas', artifactId: f.id, manifest: kind === 'slides' ? 'deck.html' : 'canvas.json' } : kind === 'guide' ? { kind, artifactId: f.id, file: 'guide.md' } : undefined
    const pane = f.webPanes.open({ ...anchor, url: kind === 'page' ? 'http://localhost/docs' : `http://localhost/redline/artifacts/${f.id}/index.html`, content, openedBy: 'user' })
    f.webPanes.close(pane.id)
    const key = f.s.get(target).items.find((i) => i.ref.webPaneId === pane.id)!.key
    const keep = f.webPanes.open({ ...anchor, url: 'http://localhost/keep', openedBy: 'user' })
    f.webPanes.close(keep.id)
    expect(f.webPanes.closedEntries().map((e) => e.pane.id)).toContain(pane.id)
    f.s.remove(target, key)
    expect(f.webPanes.closedEntries().map((e) => e.pane.id)).toEqual([keep.id])
    expect(f.webPanes.closedTabs()[target].map((p) => p.id)).toEqual([keep.id])
    expect(() => f.webPanes.reopenClosed(target, pane.id, anchor)).toThrow('Closed tab does not exist')
    f.s.backfillClosedTabs()
    expect(f.s.get(target).items.map((i) => i.ref.webPaneId)).toEqual([keep.id])
    await f.webPanes.flush()
  })
  it.each([{ backfilled: false, stale: false }, { backfilled: false, stale: true }, { backfilled: true, stale: false }, { backfilled: true, stale: true }])('does not resurrect a removed card across restarts (backfilled: $backfilled, stale closed-tab file: $stale)', async ({ backfilled, stale }) => {
    const f = await fixture()
    if (backfilled) f.webPanes.closedTabHooks = { targetIdFor: () => target }
    const pane = f.webPanes.open({ ...anchor, url: 'http://localhost/legacy', openedBy: 'user' })
    f.webPanes.close(pane.id)
    await f.webPanes.flush()
    const webPath = join(f.root, 'web.json'), closedState = readFileSync(webPath, 'utf8')
    if (backfilled) f.s.backfillClosedTabs()
    f.s.flush()
    const key = f.s.get(target).items[0].key
    const reloaded = store({ root: join(f.root, 'boards'), snapshotRoot: f.snapshots, artifacts: f.artifacts, webPanes: f.webPanes })
    reloaded.remove(target, key)
    // remove() must persist the Board marker even before callers flush either store.
    const removed = store({ root: join(f.root, 'boards') })
    expect(removed.get(target).items).toEqual([])
    await f.webPanes.flush()
    if (stale) writeFileSync(webPath, closedState)
    for (let restart = 0; restart < 2; restart++) {
      const webPanes = new WebPaneService(webPath, undefined, undefined, 'board-test')
      await webPanes.load()
      expect(webPanes.closedEntries().map((e) => e.pane.id)).toEqual(stale ? [pane.id] : [])
      const s = store({ root: join(f.root, 'boards'), artifacts: f.artifacts, webPanes })
      const before = s.get(target)
      s.backfillClosedTabs(); s.backfillClosedTabs(); s.flush()
      expect(s.get(target)).toEqual(before)
      expect(s.get(target).items).toEqual([])
      await webPanes.flush()
    }
  })
  it('remembers backfilled ids after restart without replaying an entry whose card disappeared', async () => {
    const f = await fixture()
    f.webPanes.closedTabHooks = { targetIdFor: () => target }
    const pane = f.webPanes.open({ ...anchor, url: 'http://localhost/legacy', openedBy: 'user' })
    f.webPanes.close(pane.id)
    f.s.backfillClosedTabs(); f.s.flush()
    const path = join(f.root, 'boards', `${target}.json`), saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.backfilledClosedTabs).toEqual([pane.id])
    // Model a card evicted independently of the still-retained closed-tab record.
    saved.board.items = []
    writeFileSync(path, JSON.stringify(saved))
    const s = store({ root: join(f.root, 'boards'), webPanes: f.webPanes })
    s.backfillClosedTabs()
    expect(s.get(target).items).toEqual([])
    expect(f.webPanes.closedEntries().map((e) => e.pane.id)).toEqual([pane.id])
    await f.webPanes.flush()
  })
  it.each(['canvas', 'slides', 'guide', 'redline'] as const)('captures %s, snapshots on close, reopens same id, revives after source and history disappear', async (kind) => {
    const f = await fixture()
    const content: WebPane['content'] = kind === 'canvas' || kind === 'slides' ? { kind: 'canvas', artifactId: f.id, manifest: kind === 'slides' ? 'deck.html' : 'canvas.json' } : kind === 'guide' ? { kind: 'guide', artifactId: f.id, file: 'guide.md' } : undefined
    const pane = f.webPanes.open({ ...anchor, url: `http://127.0.0.1:4410/redline/artifacts/${f.id}/index.html`, content, openedBy: 'agent' })
    const key = f.s.captureWebPane(target, pane, session)!
    expect(f.s.view(target).items[0]).toMatchObject({ kind, state: 'open' })
    f.webPanes.close(pane.id)
    expect(f.s.view(target).items[0].state).toBe('closed'); expect(f.s.item(target, key).ref.snapshotId).toBeDefined()
    expect(f.s.revive(target, key, anchor, 'user')).toEqual({ webPaneId: pane.id })
    f.webPanes.close(pane.id); f.webPanes.forgetClosed(target, pane.id); rmSync(f.dir, { recursive: true })
    expect(f.s.view(target).items[0].state).toBe('snapshot')
    const revived = f.s.revive(target, key, anchor, 'user')
    expect(revived.webPaneId).not.toBe(pane.id)
    expect(f.artifacts.directory(f.s.item(target, key).ref.artifactId!)).toContain(f.snapshots)
    f.s.captureWebPane(target, f.webPanes.get(revived.webPaneId!)!, session)
    expect(f.s.get(target).items).toHaveLength(1)
    await f.webPanes.flush()
  })
  it.each(['live', 'parked', 'closed'] as const)('preserves snapshot ownership when removing a Board card for a %s pane', async (owner) => {
    const f = await fixture()
    const pane = f.webPanes.open({ ...anchor, url: `http://127.0.0.1:4410/redline/artifacts/${f.id}/`, content: { kind: 'canvas', artifactId: f.id, manifest: 'canvas.json' }, openedBy: 'agent' })
    const key = f.s.captureWebPane(target, pane, session)!
    f.webPanes.close(pane.id); f.webPanes.forgetClosed(target, pane.id)
    const snapshotId = f.s.item(target, key).ref.snapshotId!, path = join(f.snapshots, snapshotId)
    rmSync(f.dir, { recursive: true })
    const revived = f.s.revive(target, key, anchor, 'user')
    if (owner === 'closed') f.webPanes.close(revived.webPaneId!)
    if (owner === 'parked') f.webPanes.prune([{ id: '@2', sessionId: '$2', paneIds: ['%2'] }])
    expect(f.webPanes.retainedUrls().some((url) => url.includes(f.s.item(target, key).ref.artifactId!))).toBe(true)
    f.s.remove(target, key); f.s.flush()
    expect(existsSync(join(path, 'canvas.json'))).toBe(owner !== 'closed')
    if (owner === 'closed') {
      expect(f.webPanes.closedEntries()).toEqual([])
      f.s.backfillClosedTabs()
      expect(f.s.get(target).items).toEqual([])
    }
    await f.webPanes.flush()
  })
  it.each(['canvas', 'slides', 'guide'] as const)('uses the daemon origin to revive path-added %s artifacts', async (kind) => {
    const f = await fixture(), s = store({ artifacts: f.artifacts, webPanes: f.webPanes, origin: 'http://127.0.0.1:4499' })
    const path = kind === 'canvas' ? f.dir : join(f.dir, kind === 'slides' ? 'deck.html' : 'guide.md')
    const added = s.upsert(target, boardInput({ path, kind }, 'user', f.artifacts))
    const revived = s.revive(target, added.key, anchor, 'user'), pane = f.webPanes.get(revived.webPaneId!)!
    expect(new URL(pane.url).origin).toBe('http://127.0.0.1:4499')
    await f.webPanes.flush()
  })
  it('returns split-out live pane identities without selecting a panel tab', async () => {
    const f = await fixture(), pane = f.webPanes.open({ ...anchor, url: 'http://localhost:4410/split', engine: 'chromium', openedBy: 'user', dock: 'split', anchorSize: { cols: 200, rows: 50 } })
    const key = f.s.captureWebPane(target, pane, session)!, active = vi.spyOn(f.webPanes, 'setActiveTab')
    expect(f.s.revive(target, key, anchor, 'user')).toEqual({ webPaneId: pane.id })
    expect(active).not.toHaveBeenCalled()
    await f.webPanes.flush()
  })
  it('opens links through the existing confirmation policy, focuses open tabs and returns file paths', async () => {
    const f = await fixture()
    const link = f.s.upsert(target, item('external', 'agent'))
    const result = f.s.revive(target, link.key, anchor, 'agent')
    expect(f.webPanes.get(result.webPaneId!)?.status).toBe('pending')
    const path = join(f.dir, 'index.html'); const file = f.s.upsert(target, { key: `file:${path}`, title: 'File', kind: 'file', source: 'agent', ref: { path } })
    expect(f.s.revive(target, file.key, anchor, 'user')).toEqual({ path })
    rmSync(path); expect(f.s.view(target).items.find((i) => i.key === file.key)?.state).toBe('missing')
    expect(() => f.s.revive(target, file.key, anchor, 'user')).toThrow('missing')
    await f.webPanes.flush()
  })
  it('focuses a matching existing tab and re-registers a source when closed history expired', async () => {
    const f = await fixture()
    const pane = f.webPanes.open({ ...anchor, url: `http://127.0.0.1:4410/redline/artifacts/${f.id}/`, content: { kind: 'canvas', artifactId: f.id, manifest: 'canvas.json' }, openedBy: 'agent' })
    const key = f.s.captureWebPane(target, pane, session)!
    expect(f.s.revive(target, key, anchor, 'user').webPaneId).toBe(pane.id)
    expect(f.webPanes.panelActiveTabs()['%1']).toBe(pane.id)
    f.webPanes.close(pane.id); f.webPanes.forgetClosed(target, pane.id); f.artifacts.unregister(f.id)
    const result = f.s.revive(target, key, anchor, 'user')
    expect(result.webPaneId).not.toBe(pane.id)
    expect(f.artifacts.resolve(f.s.item(target, key).ref.artifactId!, 'canvas.json')).toBe(join(f.dir, 'canvas.json'))
    await f.webPanes.flush()
  })
  it('derives matching manually added URLs as open only within the board target', async () => {
    const f = await fixture()
    const pane = f.webPanes.open({ ...anchor, url: 'http://localhost:4410/page/?utm_source=x', openedBy: 'agent', engine: 'chromium' })
    const input = boardInput({ url: 'http://localhost:4410/page', kind: 'page' }, 'agent')
    f.s.upsert(target, input); f.s.upsert(other, input)
    expect(f.s.view(target).items[0].state).toBe('open')
    expect(f.s.view(other).items[0].state).toBe('closed')
    expect(f.s.revive(target, input.key, anchor, 'user').webPaneId).toBe(pane.id)
    await f.webPanes.flush()
  })
  it('does not capture simulator, pending or devtools panes', async () => {
    const f = await fixture()
    for (const pane of [{ status: 'pending', url: 'https://example.com' }, { status: 'open', url: 'devtools://target' }, { status: 'open', url: '', content: { kind: 'simulator', udid: 'a' } }]) expect(f.s.captureWebPane(target, pane as WebPane)).toBeUndefined()
    await f.webPanes.flush()
  })
  it('snapshot copy skips hidden files, node_modules, symlinks, oversize files and enforces the total cap', () => {
    const dir = temp(), snapshots = temp()
    writeFileSync(join(dir, 'canvas.json'), '{}'); writeFileSync(join(dir, '.secret'), 'secret'); mkdirSync(join(dir, 'node_modules')); writeFileSync(join(dir, 'node_modules', 'dep'), 'dep'); symlinkSync('/etc', join(dir, 'outside')); symlinkSync('/etc/passwd', join(dir, 'link'))
    writeFileSync(join(dir, 'too-big'), Buffer.alloc(5 * 1024 * 1024 + 1))
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `file-${i}`), Buffer.alloc(5 * 1024 * 1024))
    const id = copyBoardSnapshot(dir, snapshots, 'canvas.json')!
    const names = readdirSync(join(snapshots, id))
    expect(names).toContain('canvas.json'); expect(names).not.toEqual(expect.arrayContaining(['.secret', 'node_modules', 'outside', 'link', 'too-big']))
    expect(names.reduce((n, name) => n + statSync(join(snapshots, id, name)).size, 0)).toBeLessThanOrEqual(50 * 1024 * 1024)
    expect(copyBoardSnapshot(dir, snapshots, 'absent')).toBeUndefined()
  })
  it('keeps board registrations across downtime and registry capacity churn', () => {
    const root = temp(), dir = temp(), statePath = join(root, 'artifacts.json'); let now = 1000
    writeFileSync(join(dir, 'index.html'), 'hello')
    const registry = new RedlineArtifactRegistry({ statePath, now: () => now }), id = registry.register(dir).id
    registry.retain([id])
    for (let i = 0; i < MAX_ARTIFACT_DIRS + 2; i++) { const d = join(root, `d${i}`); mkdirSync(d); registry.register(d) }
    expect(registry.resolve(id, 'index.html')).toBe(join(dir, 'index.html'))
    now += REDLINE_ARTIFACT_TTL_MS + 1
    const loaded = new RedlineArtifactRegistry({ statePath, now: () => now, retainedIds: [id] })
    expect(loaded.resolve(id, 'index.html')).toBe(join(dir, 'index.html'))
  })
})

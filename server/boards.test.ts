import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_AUTO_TTL_MS, BoardStore, MAX_BOARD_ITEMS, boardInput, copyBoardSnapshot, packBoardGroup, packBoardItem } from './boards.js'
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
  it('keeps auto captures idempotent, preserving deletion and origin across reload', () => {
    const root = temp(); let now = 1000
    const s = store({ root, now: () => now })
    s.capture(target, { ...item(), origin: { at: now, agentSession: session } }, 'event-one')
    now += 1000; s.capture(target, item(), 'event-one')
    expect(s.get(target).rev).toBe(1); expect(s.get(target).items[0].updatedAt).toBe(1000)
    s.remove(target, item().key); s.flush()
    const restored = store({ root, now: () => now })
    restored.capture(target, item(), 'event-one'); expect(restored.get(target).items).toEqual([])
    restored.capture(target, item(), 'event-two'); expect(restored.get(target).items).toHaveLength(1)
  })
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

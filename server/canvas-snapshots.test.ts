import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CanvasSnapshotsStore, CANVAS_SNAPSHOT_FILE_LIMIT } from './canvas-snapshots.js'
import { REDLINE_ARTIFACT_TTL_MS, RedlineArtifactRegistry } from './redline-artifacts.js'

let dir: string, artifact: string, id: string, store: CanvasSnapshotsStore, registry: RedlineArtifactRegistry, now: number
const board = { title: 'Board', frames: [{ id: 'f', title: 'Frame', src: 'Frame.html', x: 0, y: 0 }] }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snapshots-')); artifact = join(dir, 'artifact'); mkdirSync(artifact)
  now = 1_800_000_000_000; registry = new RedlineArtifactRegistry({ now: () => now }); id = registry.register(artifact).id
  store = new CanvasSnapshotsStore(registry, join(dir, 'snapshots'), () => now++)
  writeFileSync(join(artifact, 'canvas.json'), JSON.stringify(board)); writeFileSync(join(artifact, 'Frame.html'), '<body>Round one</body>')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const saved = (snapshot: string, path: string) => readFileSync(store.resolve(id, snapshot, path)!, 'utf8')
describe('canvas snapshots', () => {
  it('copies the entire eligible tree and metadata, stays immutable and deduplicates consecutive contents across restarts', () => {
    mkdirSync(join(artifact, 'assets')); writeFileSync(join(artifact, 'assets', 'style.css'), 'body{}')
    writeFileSync(join(artifact, 'extra.txt'), 'extra'); writeFileSync(join(artifact, 'meta.json'), '{"local":true}')
    const first = store.capture(id, 'canvas.json', 3)!
    expect(first).toMatchObject({ comments: 3, partial: false, manifestTitle: 'Board' })
    expect(saved(first.id, 'assets/style.css')).toBe('body{}'); expect(saved(first.id, 'extra.txt')).toBe('extra')
    expect(saved(first.id, 'meta.json')).toBe('{"local":true}')
    expect(JSON.parse(readFileSync(join(store.root, id, first.id, 'meta.json'), 'utf8'))).toEqual(first)
    expect(new CanvasSnapshotsStore(registry, store.root).capture(id)).toBeNull()
    writeFileSync(join(artifact, 'extra.txt'), 'changed')
    const second = store.capture(id)!
    expect(store.list(id).map((s) => s.id)).toEqual([second.id, first.id]); expect(saved(first.id, 'extra.txt')).toBe('extra')
    rmSync(join(artifact, 'extra.txt')); expect(store.capture(id)).not.toBeNull()
  })
  it('skips hidden entries, dependencies, oversized files and all symlinks, including symlinked frame sources', () => {
    for (const folder of ['.hidden', 'node_modules']) { mkdirSync(join(artifact, folder)); writeFileSync(join(artifact, folder, 'secret'), 'secret') }
    writeFileSync(join(artifact, '.secret'), 'hidden')
    writeFileSync(join(artifact, 'large'), Buffer.alloc(CANVAS_SNAPSHOT_FILE_LIMIT + 1))
    const external = join(dir, 'secret'); writeFileSync(external, 'outside')
    symlinkSync(external, join(artifact, 'escape')); symlinkSync(dir, join(artifact, 'linked-dir'))
    symlinkSync(join(artifact, 'Frame.html'), join(artifact, 'inside-link'))
    const snapshot = store.capture(id)!
    for (const path of ['.secret', '.hidden/secret', 'node_modules/secret', 'large', 'escape', 'linked-dir/secret', 'inside-link', '../secret', '%2e%2e%2fsecret']) expect(store.resolve(id, snapshot.id, path)).toBeNull()
    rmSync(join(artifact, 'Frame.html')); symlinkSync(external, join(artifact, 'Frame.html'))
    const next = store.capture(id)!
    expect(store.resolve(id, next.id, 'Frame.html')).toBeNull()
    expect(store.resolve(id, snapshot.id, 'Frame.html')).not.toBeNull()
  })
  it('allows the exact 5 MiB and 50 MiB boundaries; overflow retains only manifests/frame sources with partial=true', () => {
    // Use a frame large enough that the rest fills the cap exactly.
    const manifest = JSON.stringify(board)
    writeFileSync(join(artifact, 'Frame.html'), Buffer.alloc(CANVAS_SNAPSHOT_FILE_LIMIT - Buffer.byteLength(manifest)))
    for (let i = 0; i < 9; i++) writeFileSync(join(artifact, `asset${i}`), Buffer.alloc(CANVAS_SNAPSHOT_FILE_LIMIT, i))
    const complete = store.capture(id)!
    expect(complete.partial).toBe(false); expect(store.resolve(id, complete.id, 'asset8')).not.toBeNull()
    writeFileSync(join(artifact, 'overflow'), 'one more byte')
    const partial = store.capture(id)!
    expect(partial.partial).toBe(true)
    expect(store.resolve(id, partial.id, 'canvas.json')).not.toBeNull(); expect(store.resolve(id, partial.id, 'Frame.html')).not.toBeNull()
    expect(store.resolve(id, partial.id, 'asset0')).toBeNull(); expect(store.resolve(id, partial.id, 'overflow')).toBeNull()
    expect(store.capture(id)).toBeNull()
    writeFileSync(join(artifact, 'asset0'), Buffer.alloc(CANVAS_SNAPSHOT_FILE_LIMIT, 42))
    expect(store.capture(id)).not.toBeNull() // Hash covers omitted eligible files too.
  })
  it('prunes to newest 30 and removes expired/unregistered artifact history', () => {
    const ids: string[] = []
    for (let i = 0; i < 32; i++) { writeFileSync(join(artifact, 'Frame.html'), String(i)); ids.push(store.capture(id)!.id) }
    expect(store.list(id).map((s) => s.id)).toEqual(ids.slice(2).reverse())
    expect(readdirSync(join(store.root, id))).toHaveLength(30)
    registry.unregister(id); store.prune(); expect(readdirSync(store.root)).toEqual([])
    id = registry.register(artifact).id; store.capture(id)
    now += REDLINE_ARTIFACT_TTL_MS + 1; store.prune(); expect(readdirSync(store.root)).toEqual([])
  })
  it('keeps manifests first when frame sources alone exceed the total cap', () => {
    const frames = Array.from({ length: 11 }, (_, i) => ({ id: `f${i}`, title: `Frame ${i}`, src: `A${i}.html`, x: 0, y: 0 }))
    writeFileSync(join(artifact, 'canvas.json'), JSON.stringify({ title: 'Many frames', frames }))
    for (const frame of frames) writeFileSync(join(artifact, frame.src), Buffer.alloc(CANVAS_SNAPSHOT_FILE_LIMIT))
    const snapshot = store.capture(id)!
    expect(snapshot.partial).toBe(true)
    expect(saved(snapshot.id, 'canvas.json')).toContain('Many frames')
    expect(frames.filter((frame) => store.resolve(id, snapshot.id, frame.src))).toHaveLength(9)
  })
  it('deduplicates by folder contents regardless of which manifest sent feedback', () => {
    writeFileSync(join(artifact, 'board.json'), JSON.stringify({ title: 'Other', frames: [] }))
    expect(store.capture(id)).not.toBeNull()
    expect(store.capture(id, 'board.json')).toBeNull()
  })
  it('includes a custom manifest as well as canvas.json', () => {
    writeFileSync(join(artifact, 'board.json'), JSON.stringify({ ...board, title: 'Custom' }))
    const snapshot = store.capture(id, 'board.json')!
    expect(snapshot.manifestTitle).toBe('Custom'); expect(saved(snapshot.id, 'canvas.json')).toContain('Board'); expect(saved(snapshot.id, 'board.json')).toContain('Custom')
  })
})

it('refuses a canonical registration rebound through a parent symlink', () => {
  const parent = join(dir, 'parent'), moved = join(dir, 'moved'), outside = join(dir, 'outside')
  mkdirSync(parent); mkdirSync(join(parent, 'board')); mkdirSync(outside); mkdirSync(join(outside, 'board'))
  const registered = join(parent, 'board'), capability = registry.register(registered).id
  writeFileSync(join(registered, 'canvas.json'), JSON.stringify(board))
  writeFileSync(join(outside, 'board', 'canvas.json'), JSON.stringify(board))
  renameSync(parent, moved); symlinkSync(outside, parent)
  expect(store.capture(capability)).toBeNull()
})
it('stops traversal and input reads at their capture budgets and marks partial', () => {
  for (let i = 0; i < 15; i++) writeFileSync(join(artifact, `asset${i}`), 'x'.repeat(100))
  const entries = new CanvasSnapshotsStore(registry, join(dir, 'entries'), () => now++, { entries: 5, inputBytes: 10000 })
  const snap = entries.capture(id)!; expect(snap.partial).toBe(true)
  expect(readdirSync(join(entries.root, id, snap.id, 'files')).length).toBeLessThanOrEqual(5)
  const bytes = new CanvasSnapshotsStore(registry, join(dir, 'bytes'), () => now++, { entries: 5000, inputBytes: 300 })
  const limited = bytes.capture(id)!; expect(limited.partial).toBe(true)
  expect(readdirSync(join(bytes.root, id, limited.id, 'files')).length).toBeLessThan(17)
})

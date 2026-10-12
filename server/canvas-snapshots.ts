import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, opendirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { canvasRelativePath, parseCanvasManifest } from '../shared/canvas-manifest.js'
import type { CanvasSnapshot } from '../shared/canvas-snapshot.js'
import type { WebPane, WebPaneFeedbackNote } from '../shared/protocol.js'
import type { RedlineArtifactRegistry } from './redline-artifacts.js'

export const CANVAS_SNAPSHOT_FILE_LIMIT = 5 * 1024 * 1024
export const CANVAS_SNAPSHOT_TOTAL_LIMIT = 50 * 1024 * 1024
export const CANVAS_SNAPSHOT_ENTRY_LIMIT = 5_000
export const CANVAS_SNAPSHOT_INPUT_LIMIT = 200 * 1024 * 1024
const validId = (id: string) => /^[0-9a-f]{16}$/.test(id)
const validSnapshot = (id: string) => /^[0-9a-f-]{36}$/.test(id)
const eligiblePath = (path: string) => !!canvasRelativePath(path) && path.split('/').every((part) => !part.startsWith('.') && part !== 'node_modules')
export const defaultCanvasSnapshotsPath = (port: number) => join(homedir(), '.commando', `canvas-snapshots-${port}`)

/** Never follow symlinks, including directory components; validate again after opening. */
function openRegular(root: string, path: string, expectedRoot?: string): number | null {
  if (!eligiblePath(path)) return null
  let fd: number | undefined
  try {
    if (lstatSync(root).isSymbolicLink()) return null
    let file = root
    for (const part of path.split('/')) { file = join(file, part); if (lstatSync(file).isSymbolicLink()) return null }
    const canonicalRoot = realpathSync(root)
    if (expectedRoot !== undefined && canonicalRoot !== expectedRoot) return null
    const confined = () => realpathSync(file).startsWith(canonicalRoot + sep)
    if (!confined()) return null
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd), current = lstatSync(file)
    if (lstatSync(root).isSymbolicLink() || !confined() || !stat.isFile() || current.isSymbolicLink() || stat.ino !== current.ino || stat.dev !== current.dev || stat.size > CANVAS_SNAPSHOT_FILE_LIMIT) {
      closeSync(fd); return null
    }
    return fd
  } catch { if (fd !== undefined) closeSync(fd); return null }
}
function readBounded(root: string, path: string, budget?: { remaining: number; partial: boolean }): Buffer | null {
  const fd = openRegular(root, path, root)
  if (fd === null) return null
  try {
    const size = fstatSync(fd).size
    if (budget && size + 1 > budget.remaining) { budget.partial = true; budget.remaining = 0; return null }
    // An extra byte detects a file that grows after fstat without an unbounded read.
    const buffer = Buffer.alloc(Math.min(size + 1, CANVAS_SNAPSHOT_FILE_LIMIT + 1, budget?.remaining ?? Infinity))
    let length = 0, count = 0
    do { count = readSync(fd, buffer, length, buffer.length - length, null); length += count } while (count && length < buffer.length)
    if (budget) { budget.remaining -= length; if (length === buffer.length) { budget.partial = true; return null } }
    return length > CANVAS_SNAPSHOT_FILE_LIMIT ? null : buffer.subarray(0, length)
  } finally { closeSync(fd) }
}

export class CanvasSnapshotsStore {
  constructor(private readonly artifacts: Pick<RedlineArtifactRegistry, 'directory'>, readonly root: string, private readonly now = Date.now, private readonly limits = { entries: CANVAS_SNAPSHOT_ENTRY_LIMIT, inputBytes: CANVAS_SNAPSHOT_INPUT_LIMIT }) {}

  /** The shared canvas send hook calls this for batches, Send this, follow-ups and status notes. */
  captureSent(pane: WebPane | undefined, notes: readonly WebPaneFeedbackNote[]): CanvasSnapshot | null {
    if (pane?.content?.kind !== 'canvas' || !notes.length) return null
    return this.capture(pane.content.artifactId, pane.content.manifest, notes.length)
  }

  capture(artifactId: string, manifestPath = 'canvas.json', comments = 0): CanvasSnapshot | null {
    const dir = validId(artifactId) && this.artifacts.directory(artifactId)
    if (!dir) { this.prune(); return null }
    try { if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) return null } catch { return null }
    const budget = { remaining: this.limits.inputBytes, partial: false }
    const manifestBytes = readBounded(dir, manifestPath, budget)
    if (!manifestBytes) return null
    const { manifest } = parseCanvasManifest(manifestBytes.toString('utf8'))
    const core = new Set(['canvas.json', manifestPath, ...manifest.frames.map((frame) => frame.src)])
    const paths: string[] = []
    let visited = 0
    const walk = (folder: string, depth = 0) => {
      if (depth >= 64 || visited >= this.limits.entries) { budget.partial = true; return }
      const entries = opendirSync(folder)
      try {
        let entry
        while (visited < this.limits.entries && (entry = entries.readSync())) {
          ++visited
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
          const file = join(folder, entry.name), path = relative(dir, file).split(sep).join('/')
          try {
            if (entry.isDirectory() && !lstatSync(file).isSymbolicLink() && realpathSync(file).startsWith(dir + sep)) walk(file, depth + 1)
            else if (entry.isFile()) paths.push(path)
          } catch { budget.partial = true }
          if (visited >= this.limits.entries) { budget.partial = true; return }
        }
        if (visited >= this.limits.entries) budget.partial = true
      } finally { entries.closeSync() }
    }
    walk(dir)
    const parent = join(this.root, artifactId), id = randomUUID(), staging = join(parent, `.${id}`)
    mkdirSync(join(staging, 'files'), { recursive: true, mode: 0o700 })
    let total = 0, stored = 0, partial = budget.partial
    const fileHashes: Array<[string, string]> = []
    try {
      // Read once: the hash describes the exact bytes copied, including files omitted by the total cap.
      const priority = (path: string) => path === manifestPath || path === 'canvas.json' ? 0 : core.has(path) ? 1 : 2
      for (const path of paths.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))) {
        const body = path === manifestPath ? manifestBytes : readBounded(dir, path, budget)
        if (budget.partial) partial = true
        if (!body) { if (budget.remaining <= CANVAS_SNAPSHOT_FILE_LIMIT + 1 && budget.partial) break; continue }
        fileHashes.push([path, createHash('sha256').update(body).digest('hex')])
        total += body.length
        if (stored + body.length <= CANVAS_SNAPSHOT_TOTAL_LIMIT) {
          const file = join(staging, 'files', path)
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, body, { mode: 0o600 }); stored += body.length
        } else partial = true
      }
      if (total > CANVAS_SNAPSHOT_TOTAL_LIMIT) {
        partial = true
        // Fall back to the manifest and frame sources, still respecting both byte limits.
        for (const path of paths) if (!core.has(path)) rmSync(join(staging, 'files', path), { force: true })
      }
      const contentHash = createHash('sha256').update(JSON.stringify(fileHashes.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex')
      const latest = this.list(artifactId)[0]
      if (latest && readFileSync(join(parent, latest.id, '.hash'), 'utf8') === contentHash) return null
      const meta: CanvasSnapshot = { id, createdAt: Math.max(this.now(), (latest?.createdAt ?? 0) + 1), comments, partial, manifestTitle: manifest.title }
      writeFileSync(join(staging, 'meta.json'), JSON.stringify(meta), { mode: 0o600 })
      writeFileSync(join(staging, '.hash'), contentHash, { mode: 0o600 })
      renameSync(staging, join(parent, id))
      for (const snapshot of this.list(artifactId).slice(30)) rmSync(join(parent, snapshot.id), { recursive: true, force: true })
      return meta
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }

  list(artifactId: string): CanvasSnapshot[] {
    if (!validId(artifactId) || !this.artifacts.directory(artifactId)) { this.prune(); return [] }
    try {
      return readdirSync(join(this.root, artifactId)).filter(validSnapshot).flatMap((id) => {
        try {
          const meta = JSON.parse(readFileSync(join(this.root, artifactId, id, 'meta.json'), 'utf8')) as CanvasSnapshot
          return meta.id === id && Number.isFinite(meta.createdAt) && Number.isFinite(meta.comments) && typeof meta.partial === 'boolean' && typeof meta.manifestTitle === 'string' ? [meta] : []
        } catch { return [] }
      }).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    } catch { return [] }
  }

  resolve(artifactId: string, snapshotId: string, requestPath: string): string | null {
    if (!validId(artifactId) || !validSnapshot(snapshotId) || !this.artifacts.directory(artifactId)) return null
    let path: string
    try {
      const decoded = decodeURIComponent(requestPath)
      path = decoded === '' || decoded.endsWith('/') ? `${decoded}index.html` : decoded
    } catch { return null }
    const root = join(this.root, artifactId, snapshotId, 'files')
    try {
      for (const folder of [join(this.root, artifactId), join(this.root, artifactId, snapshotId), root]) if (lstatSync(folder).isSymbolicLink()) return null
    } catch { return null }
    const fd = openRegular(root, path)
    if (fd === null) return null
    closeSync(fd)
    return join(root, path)
  }

  /** Call at startup, after unregister, and from the daemon's periodic retention sweep. */
  prune(): void {
    try {
      for (const id of readdirSync(this.root)) if (validId(id) && !this.artifacts.directory(id)) rmSync(join(this.root, id), { recursive: true, force: true })
    } catch { /* Missing snapshot root starts empty. */ }
  }
}

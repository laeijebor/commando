import { encodeCanvasPath } from '../shared/canvas-manifest.js'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CANVAS_STATUSES, canvasRelativePath, parseCanvasManifest, type CanvasWriteResult } from '../shared/canvas-manifest.js'
import { RedlineArtifactError, type RedlineArtifactRegistry } from './redline-artifacts.js'

export const CANVAS_WRITE_TEMP_PREFIX = '.commando-canvas-'
export const canvasContentHash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')

/** Input has already passed JSON.parse. Keep source key order and unknown scalar spellings
 * (including integers outside JS precision) while formatting with two-space indentation.
 * An update for a key the object lacks is appended to that object. */
function rewriteJson(text: string, updates: Map<string, unknown>): string {
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/g)!
  let cursor = 0
  const read = (path: Array<string | number>, depth: number): string => {
    const token = tokens[cursor++]
    if (token !== '{' && token !== '[') return updates.has(JSON.stringify(path)) ? JSON.stringify(updates.get(JSON.stringify(path))) : token
    const object = token === '{', close = object ? '}' : ']'
    const entries: string[] = [], keys = new Set<string>()
    const indent = '  '.repeat(depth + 1)
    while (tokens[cursor] !== close) {
      if (entries.length) ++cursor // comma
      if (object) {
        const key = tokens[cursor++]; ++cursor // colon
        keys.add(JSON.parse(key) as string)
        entries.push(indent + key + ': ' + read([...path, JSON.parse(key) as string], depth + 1))
      } else entries.push(indent + read([...path, entries.length], depth + 1))
    }
    ++cursor
    if (object) for (const [updatePath, value] of updates) {
      const target = JSON.parse(updatePath) as Array<string | number>, key = target.at(-1)
      if (target.length === path.length + 1 && typeof key === 'string' && !keys.has(key) && JSON.stringify(target.slice(0, -1)) === JSON.stringify(path)) entries.push(indent + JSON.stringify(key) + ': ' + JSON.stringify(value))
    }
    return entries.length ? token + '\n' + entries.join(',\n') + '\n' + '  '.repeat(depth) + close : token + close
  }
  return read([], 0) + '\n'
}

/** Synchronous compare/write avoids interleaving daemon writes; rename publishes a complete file. */
export function writeCanvas(artifacts: RedlineArtifactRegistry, artifactId: string, body: Record<string, unknown>, kind: 'frames' | 'annotations' | 'sections'): CanvasWriteResult {
  const fail = (status: number, message: string): never => { throw new RedlineArtifactError(status, message) }
  const manifest = canvasRelativePath(body.manifest)
  if (!manifest || !manifest.endsWith('.json')) return fail(400, 'manifest must be a relative JSON path inside the canvas folder')
  const encoded = encodeCanvasPath(manifest)
  const file = artifacts.resolve(artifactId, encoded)
  if (!file) return fail(404, 'Canvas manifest not found')
  if (typeof body.expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedHash)) return fail(400, 'expectedHash must be the loaded manifest content hash')
  const original = readFileSync(file, 'utf8')
  if (canvasContentHash(original) !== body.expectedHash) return fail(409, 'Canvas changed on disk; reloaded. Try again.')
  const parsed = parseCanvasManifest(original)
  if (parsed.errors.length) return fail(400, 'Fix manifest errors before editing the canvas')
  // Locate edits in the raw JSON, never serialize the normalized manifest.
  const raw = JSON.parse(original) as Record<string, unknown>
  const changes = kind === 'sections' ? body.statuses : body.moves
  if (!Array.isArray(changes) || !changes.length || changes.length > 100) return fail(400, 'Expected 1–100 canvas changes')
  const entries = raw[kind] as Array<Record<string, unknown>> | undefined
  const seen = new Set<string>()
  const updates = new Map<string, unknown>()
  for (const change of changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return fail(400, 'Invalid canvas change')
    const item = change as Record<string, unknown>
    if (typeof item.id !== 'string' || seen.has(item.id)) return fail(400, 'Invalid or duplicate canvas id')
    seen.add(item.id)
    const index = entries?.findIndex((entry) => entry.id === item.id) ?? -1
    const entry = entries?.[index]
    if (!entry) return fail(400, 'Unknown canvas id')
    if (kind !== 'sections') {
      if (![item.x, item.y].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1_000_000)) return fail(400, `Invalid ${kind === 'frames' ? 'frame' : 'note'} coordinates`)
      updates.set(JSON.stringify([kind, index, 'x']), item.x); updates.set(JSON.stringify([kind, index, 'y']), item.y)
      // A dragged note stays where it was dropped; `fixed: false` hands it back to auto layout.
      if (kind === 'annotations') {
        if (item.fixed !== undefined && typeof item.fixed !== 'boolean') return fail(400, 'Invalid note fixed flag')
        updates.set(JSON.stringify([kind, index, 'fixed']), item.fixed ?? true)
      }
    } else {
      if (!CANVAS_STATUSES.some((status) => status === item.status)) return fail(400, 'Invalid section status')
      updates.set(JSON.stringify([kind, index, 'status']), item.status)
    }
  }
  const text = rewriteJson(original, updates)
  const temp = join(dirname(file), `${CANVAS_WRITE_TEMP_PREFIX}${randomBytes(12).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, text, { flag: 'wx', mode: statSync(file).mode & 0o777 })
    // Re-resolve as well as compare: a replaced symlink must not redirect the write.
    if (artifacts.resolve(artifactId, encoded) !== file || canvasContentHash(readFileSync(file)) !== body.expectedHash) return fail(409, 'Canvas changed on disk; reloaded. Try again.')
    renameSync(temp, file)
  } finally {
    try { unlinkSync(temp) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return { ...parseCanvasManifest(text), contentHash: canvasContentHash(text) }
}

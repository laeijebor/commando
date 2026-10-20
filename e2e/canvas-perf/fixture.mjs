// Tile an existing canvas folder into a bigger stress-test canvas.
// Usage: node e2e/canvas-perf/fixture.mjs <source-canvas-dir> <out-dir> <copies>
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [source, out, copiesArg = '4'] = process.argv.slice(2)
if (!source || !out) throw new Error('usage: fixture.mjs <source> <out> [copies]')
const copies = Number(copiesArg), columns = Math.ceil(Math.sqrt(copies))
cpSync(source, out, { recursive: true })
const base = JSON.parse(readFileSync(join(source, 'canvas.json'), 'utf8'))
const width = Math.max(...base.frames.map((f) => f.x + (f.w ?? 390))) + 800
const height = Math.max(...base.frames.map((f) => f.y + (f.h ?? 844))) + 800
const manifest = { title: `${base.title} ×${copies}`, sections: [], frames: [], annotations: [] }
for (let copy = 0; copy < copies; copy++) {
  const dx = (copy % columns) * width, dy = Math.floor(copy / columns) * height, id = (value) => copy ? `${value}-${copy}` : value
  manifest.frames.push(...base.frames.map((f) => ({ ...f, id: id(f.id), x: f.x + dx, y: f.y + dy, ...(copy && f.focus ? { focus: undefined } : {}) })))
  manifest.sections.push(...(base.sections ?? []).map((s) => ({ ...s, id: id(s.id), frames: s.frames.map(id) })))
  manifest.annotations.push(...(base.annotations ?? []).map((a) => ({ ...a, id: id(a.id), x: a.x + dx, y: a.y + dy, ...(a.target ? { target: { ...a.target, frame: id(a.target.frame) } } : {}) })))
}
writeFileSync(join(out, 'canvas.json'), JSON.stringify(manifest, null, 2))
console.log(`${manifest.frames.length} frames → ${out}`)

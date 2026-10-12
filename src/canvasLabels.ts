import type { CanvasFrame } from '../shared/canvas-manifest'
import type { CanvasBounds } from './canvasCamera'

export type CanvasLabel = { name: string; group?: string; id?: string; rect: CanvasBounds }
export type CanvasLabelRef = { frameId: string; key: string }
export type CanvasLabelInstance = CanvasLabelRef & { label: CanvasLabel }
export type CanvasLabelReports = Record<string, CanvasLabel[]>
export const labelsForFrame = (reports: CanvasLabelReports, frameId: string): CanvasLabel[] => Object.hasOwn(reports, frameId) ? reports[frameId] : []
export const labelKey = (label: CanvasLabel, index: number) => label.id ? `id:${label.id}` : `index:${index}`
export const sameLabel = (a: CanvasLabelRef | null, b: CanvasLabelRef | null) => !!a && !!b && a.frameId === b.frameId && a.key === b.key

/** Frame and first-seen group order follow the manifest and the iframe's document order. */
export function buildCanvasLabelTree(frames: CanvasFrame[], reports: CanvasLabelReports, filter = '') {
  const query = filter.trim().toLowerCase()
  const byName = new Map<string, CanvasLabelInstance[]>()
  const tree = frames.map((frame) => {
    const groups = new Map<string, CanvasLabelInstance[]>()
    const labels = labelsForFrame(reports, frame.id).map((label, index) => ({ frameId: frame.id, key: labelKey(label, index), label }))
      .filter(({ label }) => label.name.toLowerCase().includes(query))
    for (const instance of labels) {
      const group = instance.label.group ?? ''
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group)!.push(instance)
      if (!byName.has(instance.label.name)) byName.set(instance.label.name, [])
      byName.get(instance.label.name)!.push(instance)
    }
    return { frame, count: labels.length, groups: [...groups].map(([name, labels]) => ({ name, labels })) }
  }).filter(({ count }) => !query || count > 0)
  const shared = [...byName].filter(([, instances]) => new Set(instances.map((i) => i.frameId)).size >= 2)
    .map(([name, instances]) => ({ name, instances }))
  return { frames: tree, shared }
}

export function resolveCanvasLabel(ref: CanvasLabelRef | null, reports: CanvasLabelReports): CanvasLabel | undefined {
  return ref ? labelsForFrame(reports, ref.frameId).find((label, index) => labelKey(label, index) === ref.key) : undefined
}

/** Treat the iframe payload as untrusted even after checking its source window. */
export function readCanvasLabels(value: unknown): CanvasLabel[] | null {
  if (!Array.isArray(value) || value.length > 1_000) return null
  try { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_000_000) return null } catch { return null }
  const labels: CanvasLabel[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || item.name.length > 200 ||
      (item.group !== undefined && (typeof item.group !== 'string' || item.group.length > 200)) || (item.id !== undefined && (typeof item.id !== 'string' || item.id.length > 200))) return null
    const r = item.rect
    if (!r || !['x', 'y', 'w', 'h'].every((key) => typeof r[key] === 'number' && Number.isFinite(r[key]) && Math.abs(r[key]) <= 1_000_000) || r.w < 0 || r.h < 0) return null
    labels.push({ name: item.name, group: item.group, id: item.id, rect: { x: r.x, y: r.y, w: r.w, h: r.h } })
  }
  return labels
}

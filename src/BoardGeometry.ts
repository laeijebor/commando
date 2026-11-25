import type { BoardGroup, BoardPlacement, BoardView } from '../shared/board'
import type { CanvasBounds, CanvasCamera } from './canvasCamera'

export type BoardEntry = BoardView['items'][number]
export const BOARD_CARD_SIZE = { w: 208, h: 158 }
export const BOARD_TYPES = [
  { id: 'pr', label: 'Pull requests', kinds: ['pr'] },
  { id: 'canvas', label: 'Canvases & redlines & guides', kinds: ['canvas', 'redline', 'guide'] },
  { id: 'slides', label: 'Slides & diagrams', kinds: ['slides', 'diagram'] },
  { id: 'media', label: 'Screenshots & video', kinds: ['screenshot', 'video'] },
  { id: 'link', label: 'Links', kinds: ['link', 'page'] },
  { id: 'file', label: 'Exports & files', kinds: ['file'] },
  { id: 'clip', label: 'Clippings', kinds: ['clip'] },
] as const
export type BoardType = typeof BOARD_TYPES[number]['id']
export function boardType(item: BoardEntry): BoardType {
  return BOARD_TYPES.find((type) => (type.kinds as readonly string[]).includes(item.kind))!.id
}
export function boardLod(scale: number): 'full' | 'thumbnail' | 'groups' {
  return scale >= 0.6 ? 'full' : scale >= 0.2 ? 'thumbnail' : 'groups'
}
/** Cull in world coordinates, retaining one viewport of overscan on every side. */
export function boardInViewport(box: CanvasBounds, camera: CanvasCamera, viewport: { w: number; h: number }, margin = 1): boolean {
  const left = (-camera.x - viewport.w * margin) / camera.scale
  const top = (-camera.y - viewport.h * margin) / camera.scale
  const right = (-camera.x + viewport.w * (1 + margin)) / camera.scale
  const bottom = (-camera.y + viewport.h * (1 + margin)) / camera.scale
  return box.x + box.w >= left && box.x <= right && box.y + box.h >= top && box.y <= bottom
}
export function boardWorldPoint(point: { x: number; y: number }, camera: CanvasCamera) {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale }
}
export function boardGroupAt(groups: readonly BoardGroup[], point: { x: number; y: number }): BoardGroup | undefined {
  return [...groups].reverse().find((group) => point.x >= group.x && point.x <= group.x + group.w && point.y >= group.y && point.y <= group.y + group.h)
}
/** Mirror the server's append packing for the optimistic group drop; response is authoritative. */
export function boardPlaced(board: BoardView, key: string, placement: Partial<BoardPlacement>): BoardView {
  if (!placement.group) return { ...board, placements: { ...board.placements, [key]: { x: placement.x ?? 0, y: placement.y ?? 0, fixed: true } } }
  const group = board.groups.find((g) => g.id === placement.group)
  if (!group) return board
  const columns = Math.max(1, Math.floor((group.w - 24) / 220))
  const occupied = Object.entries(board.placements).filter(([k, p]) => k !== key && p.group === group.id).map(([, p]) => p)
  const cell = occupied.reduce((last, p) => Math.max(last, Math.ceil(Math.max(0, p.y - group.y - 40) / 170) * columns + Math.ceil(Math.max(0, p.x - group.x - 12) / 220) + 1), 0)
  const next = { group: group.id, x: group.x + 12 + (cell % columns) * 220, y: group.y + 40 + Math.floor(cell / columns) * 170 }
  return { ...board, placements: { ...board.placements, [key]: next }, groups: board.groups.map((g) => g.id === group.id ? { ...g, h: Math.max(g.h, next.y - g.y + 182) } : g) }
}
export function boardMatches(item: BoardEntry, query: string): boolean {
  return `${item.title}\n${item.caption ?? ''}\n${item.ref.url ?? ''}\n${item.preview?.title ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
}

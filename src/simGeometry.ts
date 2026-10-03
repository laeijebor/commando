import type { SimOrientation } from '../shared/sim-actions'

export type Point = { x: number; y: number }
export type ScreenSize = { width: number; height: number }
export type NativeEdge = 'left' | 'right' | 'top' | 'bottom'

// Clockwise CSS quarter turns that bring the content upright. Checked on a simulator: in landscape-right the content is drawn a quarter turn clockwise in the native frame.
export const ORIENTATION_TURNS: Record<SimOrientation, number> = {
  portrait: 0, 'landscape-left': 1, 'landscape-right': 3, 'portrait-upside-down': 2,
}
export function rotateOrientation(orientation: SimOrientation, direction: 1 | -1): SimOrientation {
  const turns = (ORIENTATION_TURNS[orientation] + direction + 4) % 4
  return (Object.keys(ORIENTATION_TURNS) as SimOrientation[]).find((value) => ORIENTATION_TURNS[value] === turns)!
}
function turn({ x, y }: Point, turns: number): Point {
  switch (turns % 4) {
    case 1: return { x: 1 - y, y: x }
    case 2: return { x: 1 - x, y: 1 - y }
    case 3: return { x: y, y: 1 - x }
    default: return { x, y }
  }
}
export function screenToNative(fraction: Point, size: ScreenSize, orientation: SimOrientation): Point {
  const { x, y } = turn(fraction, 4 - ORIENTATION_TURNS[orientation])
  return { x: x * size.width, y: y * size.height }
}
export function nativeToScreen(point: Point, size: ScreenSize, orientation: SimOrientation): Point {
  return turn({ x: point.x / size.width, y: point.y / size.height }, ORIENTATION_TURNS[orientation])
}
export function screenBottomEdge(orientation: SimOrientation): NativeEdge {
  const { x, y } = screenToNative({ x: 0.5, y: 1 }, { width: 1, height: 1 }, orientation)
  return x === 0 ? 'left' : x === 1 ? 'right' : y === 0 ? 'top' : 'bottom'
}
export function screenSize(size: ScreenSize, orientation: SimOrientation): ScreenSize {
  return ORIENTATION_TURNS[orientation] % 2 ? { width: size.height, height: size.width } : size
}
export function fitCanvas(size: ScreenSize, bounds: ScreenSize, orientation: SimOrientation): ScreenSize {
  const displayed = screenSize(size, orientation)
  const scale = Math.min(bounds.width / displayed.width, bounds.height / displayed.height)
  return { width: size.width * scale, height: size.height * scale }
}

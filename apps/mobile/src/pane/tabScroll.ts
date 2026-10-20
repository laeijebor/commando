export type TabLayout = { x: number; width: number }
export function selectedTabOffset(tab: TabLayout, viewport: number, content: number, current: number, inset = 12): number {
  if (viewport <= 0 || content <= 0) return current
  let next = current
  if (tab.width + inset * 2 > viewport || tab.x - inset < current) next = tab.x - inset
  else if (tab.x + tab.width + inset > current + viewport) next = tab.x + tab.width + inset - viewport
  return Math.max(0, Math.min(next, Math.max(0, content - viewport)))
}

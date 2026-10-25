import { useEffect, useRef, type RefObject } from 'react'
import type { CanvasBounds, CanvasCamera } from './canvasCamera'
import { flyToCanvasRect } from './canvasGeometry'

export function useCanvasFlight(camera: () => CanvasCamera, setCamera: (camera: CanvasCamera) => void, viewport: RefObject<HTMLDivElement | null>) {
  const animation = useRef<number | null>(null)
  const cancel = () => {
    if (animation.current !== null) cancelAnimationFrame(animation.current)
    animation.current = null
  }
  useEffect(() => () => cancel(), [])
  const flyTo = (bounds: CanvasBounds) => {
    cancel()
    const node = viewport.current
    if (!node?.clientWidth || !node.clientHeight) return
    const to = flyToCanvasRect(bounds, { w: node.clientWidth, h: node.clientHeight })
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setCamera(to); return }
    const from = camera(), start = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / 300)), ease = 1 - (1 - progress) ** 3
      setCamera({ x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease, scale: from.scale + (to.scale - from.scale) * ease })
      animation.current = progress < 1 ? requestAnimationFrame(step) : null
    }
    animation.current = requestAnimationFrame(step)
  }
  return { flyTo, cancel }
}

import { useEffect, useRef, type RefObject } from 'react'

/**
 * A pane palette covers only its pane, so a click anywhere else closes it like
 * a menu. A click into an embedded page never reaches this document; it only
 * blurs the window.
 */
export function usePaletteDismiss(dialog: RefObject<HTMLElement | null>, onClose: () => void, keepOnBlur?: () => boolean): void {
  const close = useRef(onClose)
  close.current = onClose
  const keep = useRef(keepOnBlur)
  keep.current = keepOnBlur
  useEffect(() => {
    const onPointerDown = (event: Event) => {
      if (!(event.target instanceof Node) || !dialog.current?.contains(event.target)) close.current()
    }
    const onBlur = () => { if (!keep.current?.()) close.current() }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [dialog])
}

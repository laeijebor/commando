import { Copy, FolderOpen } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type PanePathMenuProps = {
  path: string
  x: number
  y: number
  onClose: () => void
  onCopy: () => void
  onOpen: () => void
}

export function PanePathMenu({ path, x, y, onClose, onCopy, onOpen }: PanePathMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

  useLayoutEffect(() => {
    const bounds = menuRef.current?.getBoundingClientRect()
    const width = bounds?.width || 132
    const height = bounds?.height || 66
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    })
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [x, y])

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onClose)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onClose)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const choose = (action: () => void) => {
    onClose()
    action()
  }

  return createPortal(
    <div
      ref={menuRef}
      className="pane-path-menu"
      data-native-terminal-occluder=""
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={`Path actions for ${path}`}
      onKeyDown={moveFocus}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" onClick={() => choose(onCopy)}>
        <Copy aria-hidden="true" />
        Copy
      </button>
      <button type="button" role="menuitem" onClick={() => choose(onOpen)}>
        <FolderOpen aria-hidden="true" />
        Open
      </button>
    </div>,
    document.body,
  )
}

import { Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { OpenPort } from '../shared/protocol'

type Props = {
  port: OpenPort
  x: number
  y: number
  busy: boolean
  onClose: () => void
  onKill: () => void
}

export function PortContextMenu({ port, x, y, busy, onClose, onKill }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

  useLayoutEffect(() => {
    const bounds = menuRef.current?.getBoundingClientRect()
    const width = bounds?.width || 190
    const height = bounds?.height || 76
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    })
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
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

  return createPortal(
    <div
      ref={menuRef}
      className="port-context-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={`Port actions for ${port.port}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="port-context-menu__title">{port.processName} :{port.port}</div>
      <button
        type="button"
        className="danger"
        role="menuitem"
        disabled={busy}
        onClick={() => {
          onClose()
          onKill()
        }}
      >
        <Trash2 aria-hidden="true" />
        Kill process
      </button>
    </div>,
    document.body,
  )
}

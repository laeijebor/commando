import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Pencil, Terminal, Trash2 } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type PaneSplitDirection = 'up' | 'down' | 'left' | 'right'

type PaneContextMenuProps = {
  paneLabel: string
  x: number
  y: number
  busy?: boolean
  nativeTerminalAvailable?: boolean
  useXtermFallback?: boolean
  onClose: () => void
  onRename: () => void
  onSplit: (direction: PaneSplitDirection) => void
  onUseXtermFallbackChange?: (useXtermFallback: boolean) => void
  onKill: () => void
}

export function PaneContextMenu({
  paneLabel,
  x,
  y,
  busy = false,
  nativeTerminalAvailable = false,
  useXtermFallback = false,
  onClose,
  onRename,
  onSplit,
  onUseXtermFallbackChange,
  onKill,
}: PaneContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

  useLayoutEffect(() => {
    const bounds = menuRef.current?.getBoundingClientRect()
    const width = bounds?.width || 224
    const height = bounds?.height || 224
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

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const choose = (action: () => void) => {
    onClose()
    action()
  }

  return (
    <div
      ref={menuRef}
      className="pane-context-menu"
      data-native-terminal-occluder=""
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={`Pane actions for ${paneLabel}`}
      onKeyDown={moveFocus}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="pane-context-menu__title">{paneLabel}</div>
      <button type="button" role="menuitem" disabled={busy} onClick={() => choose(onRename)}>
        <Pencil aria-hidden="true" />
        Rename
      </button>
      <div className="pane-context-menu__label">Add pane</div>
      <div className="pane-context-menu__directions" role="group" aria-label="Add pane direction">
        <button type="button" role="menuitem" disabled={busy} onClick={() => choose(() => onSplit('up'))}>
          <ArrowUp aria-hidden="true" /> Up
        </button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => choose(() => onSplit('down'))}>
          <ArrowDown aria-hidden="true" /> Down
        </button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => choose(() => onSplit('left'))}>
          <ArrowLeft aria-hidden="true" /> Left
        </button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => choose(() => onSplit('right'))}>
          <ArrowRight aria-hidden="true" /> Right
        </button>
      </div>
      {(nativeTerminalAvailable || useXtermFallback) && onUseXtermFallbackChange ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => choose(() => onUseXtermFallbackChange(!useXtermFallback))}
        >
          <Terminal aria-hidden="true" />
          {useXtermFallback ? 'Use native terminal' : 'Use xterm fallback'}
        </button>
      ) : null}
      <button type="button" className="danger" role="menuitem" disabled={busy} onClick={() => choose(onKill)}>
        <Trash2 aria-hidden="true" />
        Kill pane
      </button>
    </div>
  )
}

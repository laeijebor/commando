import { Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bookmark, Check, Pencil, Terminal, Trash2, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PaneMark, PaneMarkTone } from '../shared/protocol'
import { PANE_MARK_PRESETS } from './paneMarks'

export type PaneSplitDirection = 'up' | 'down' | 'left' | 'right'

type PaneContextMenuProps = {
  paneLabel: string
  x: number
  y: number
  busy?: boolean
  nativeTerminalAvailable?: boolean
  useXtermFallback?: boolean
  mark?: PaneMark
  onClose: () => void
  onRename: () => void
  onSplit: (direction: PaneSplitDirection) => void
  onUseXtermFallbackChange?: (useXtermFallback: boolean) => void
  onSetMark?: (label: string, tone: PaneMarkTone) => void
  onAcknowledgeMark?: () => void
  onClearMark?: () => void
  onKill: () => void
}

export function PaneContextMenu({
  paneLabel,
  x,
  y,
  busy = false,
  nativeTerminalAvailable = false,
  useXtermFallback = false,
  mark,
  onClose,
  onRename,
  onSplit,
  onUseXtermFallbackChange,
  onSetMark = () => {},
  onAcknowledgeMark = () => {},
  onClearMark = () => {},
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
    <>
      <div className="pane-context-menu-backdrop" data-native-terminal-hit-blocker="" aria-hidden="true" />
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
        <div className="pane-context-menu__label">Mark pane</div>
        <div className="pane-mark-options" role="group" aria-label="Pane status">
          {PANE_MARK_PRESETS.map((preset) => {
            const selected = mark?.label === preset.label && mark.tone === preset.tone
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`pane-mark-option tone-${preset.tone}`}
                disabled={busy}
                onClick={() => choose(() => onSetMark(preset.label, preset.tone))}
                key={preset.id}
              >
                <span className="pane-mark-swatch" aria-hidden="true" />
                {preset.label}
                {selected ? <Check className="pane-mark-option-check" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          className="pane-mark-custom"
          role="menuitem"
          disabled={busy}
          onClick={() => {
            const label = window.prompt('Custom pane status', mark?.label ?? '')?.trim()
            if (label) choose(() => onSetMark(label, 'purple'))
          }}
        >
          <Bookmark aria-hidden="true" />
          Custom status…
        </button>
        {mark?.activityCount ? (
          <button type="button" className="pane-mark-acknowledge" role="menuitem" disabled={busy} onClick={() => choose(onAcknowledgeMark)}>
            <Activity aria-hidden="true" />
            Acknowledge {mark.activityCount} {mark.activityCount === 1 ? 'activity' : 'activities'}
          </button>
        ) : null}
        {mark ? (
          <button type="button" className="pane-mark-clear" role="menuitem" disabled={busy} onClick={() => choose(onClearMark)}>
            <X aria-hidden="true" />
            Clear pane status
          </button>
        ) : null}
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
    </>
  )
}

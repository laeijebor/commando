import { useEffect, useId, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { NATIVE_TERMINAL_SHORTCUT_EVENT } from './nativeTerminalBridge'
import { emptyHistory, goTo, parseHistory, recordVisit, serialiseHistory, SESSION_HISTORY_LIMIT, stepTarget, type SessionHistory } from './sessionHistory'
import './session-history.css'

type Session = { id: string; name: string }
export const sessionHistoryKey = (host: string) => `commando.session-history:${host}`

function readHistory(key: string): SessionHistory {
  try { return parseHistory(window.sessionStorage.getItem(key)) } catch { return emptyHistory() }
}

export function useSessionHistory(host: string, sessions: readonly Session[] | undefined, selectedSessionId: string | null, selectSession: (id: string) => void) {
  const key = sessionHistoryKey(host)
  const [history, setHistory] = useState(() => readHistory(key))
  const historyRef = useRef(history)
  const mouseUp = useRef<{ button: number; at: number } | null>(null)
  const initialized = useRef(false)
  const navigatingTo = useRef<string | null>(null)
  const isLive = (id: string) => sessions?.some((session) => session.id === id) ?? false
  const update = (next: SessionHistory) => {
    historyRef.current = next
    setHistory(next)
  }
  const navigate = (index: number) => {
    const entry = historyRef.current.entries[index]
    if (!entry || !isLive(entry.sessionId)) return
    navigatingTo.current = entry.sessionId
    update(goTo(historyRef.current, index))
    selectSession(entry.sessionId)
  }
  const step = (direction: -1 | 1) => {
    const target = stepTarget(historyRef.current, direction, isLive)
    if (target !== null) navigate(target)
  }

  useEffect(() => {
    if (!sessions) return
    if (!initialized.current) {
      initialized.current = true
      const current = historyRef.current.entries[historyRef.current.index]
      if (current && isLive(current.sessionId)) {
        navigate(historyRef.current.index)
        return
      }
    }
    const current = historyRef.current
    const entries = current.entries.map((entry) => {
      const name = sessions.find((session) => session.id === entry.sessionId)?.name
      return name !== undefined && name !== entry.name ? { ...entry, name } : entry
    })
    let next = entries.some((entry, index) => entry !== current.entries[index]) ? { ...current, entries } : current
    const selected = sessions.find((session) => session.id === selectedSessionId)
    if (selected) {
      if (navigatingTo.current !== selected.id) next = recordVisit(next, { sessionId: selected.id, name: selected.name, at: Date.now() })
      navigatingTo.current = null
    }
    if (next !== current) update(next)
  }, [sessions, selectedSessionId])

  useEffect(() => {
    try { window.sessionStorage.setItem(key, serialiseHistory(history)) } catch { /* History still works in memory. */ }
  }, [key, history])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || (event.key !== '[' && event.key !== ']')) return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) step(event.key === '[' ? -1 : 1)
    }
    const onNativeShortcut = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key
      if (key === '[' || key === ']') step(key === '[' ? -1 : 1)
    }
    const onMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      event.stopPropagation()
      // Browsers may send both events for one side-button press.
      if (event.type === 'auxclick' && mouseUp.current?.button === event.button && event.timeStamp - mouseUp.current.at < 1000) {
        mouseUp.current = null
        return
      }
      if (event.type === 'mouseup') mouseUp.current = { button: event.button, at: event.timeStamp }
      step(event.button === 3 ? -1 : 1)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, onNativeShortcut)
    window.addEventListener('mouseup', onMouse, true)
    window.addEventListener('auxclick', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener(NATIVE_TERMINAL_SHORTCUT_EVENT, onNativeShortcut)
      window.removeEventListener('mouseup', onMouse, true)
      window.removeEventListener('auxclick', onMouse, true)
    }
  })

  return { history, isLive, navigate, step }
}

type Props = ReturnType<typeof useSessionHistory>
const relativeTime = (at: number, accessible = false) => {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000))
  if (accessible) {
    if (minutes < 1) return 'just now'
    const count = minutes < 60 ? minutes : Math.floor(minutes / 60)
    const unit = minutes < 60 ? 'minute' : 'hour'
    return `${count} ${unit}${count === 1 ? '' : 's'} ago`
  }
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

export function SessionHistoryNav({ history, isLive, navigate, step }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const suppressClick = useRef(false)
  const [menu, setMenu] = useState<-1 | 1 | null>(null)
  const [tooltip, setTooltip] = useState<-1 | 1 | null>(null)
  const [holding, setHolding] = useState<-1 | 1 | null>(null)
  const [activeIndex, setActiveIndex] = useState(history.index)
  const id = useId()
  const back = stepTarget(history, -1, isLive)
  const forward = stepTarget(history, 1, isLive)
  const clearTooltip = () => { clearTimeout(tooltipTimer.current); setTooltip(null) }
  const clearHold = () => { clearTimeout(holdTimer.current); setHolding(null) }
  const openMenu = (direction: -1 | 1) => {
    clearTooltip()
    setActiveIndex(history.index)
    setMenu(direction)
  }
  const closeMenu = (restoreFocus = false) => {
    if (restoreFocus && menu) buttons.current[menu === -1 ? 0 : 1]?.focus()
    setMenu(null)
  }
  const openEntry = (index: number) => {
    if (!isLive(history.entries[index]?.sessionId)) return
    closeMenu(true)
    navigate(index)
  }

  useEffect(() => () => { clearTimeout(holdTimer.current); clearTimeout(tooltipTimer.current) }, [])
  useEffect(() => {
    if (!menu) return
    menuRef.current?.focus()
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setMenu(null)
    }
    const onBlur = () => setMenu(null)
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('click', outside, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('click', outside, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [menu])
  useEffect(() => {
    if (menu) root.current?.querySelector(`[data-history-index="${activeIndex}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [menu, activeIndex])

  return <div className="session-history-nav" ref={root}>
    {([-1, 1] as const).map((direction, index) => {
      const target = direction === -1 ? back : forward
      const action = direction === -1 ? 'Back' : 'Forward'
      const label = target === null ? action : `${action} to ${history.entries[target].name}`
      const Icon = direction === -1 ? ChevronLeft : ChevronRight
      return <button key={direction} ref={(node) => { buttons.current[index] = node }} type="button"
        className={`icon-button${holding === direction ? ' holding' : ''}`} disabled={target === null}
        aria-label={label} aria-haspopup="menu" aria-expanded={menu === direction}
        aria-controls={menu === direction ? `${id}-menu` : undefined}
        aria-describedby={tooltip === direction && !menu ? `${id}-tooltip` : undefined}
        onClick={() => {
          clearTooltip()
          if (suppressClick.current) { suppressClick.current = false; return }
          closeMenu()
          step(direction)
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          clearTooltip()
          clearHold()
          suppressClick.current = false
          setHolding(direction)
          event.currentTarget.setPointerCapture?.(event.pointerId)
          holdTimer.current = setTimeout(() => {
            suppressClick.current = true
            setHolding(null)
            openMenu(direction)
          }, 450)
        }}
        onPointerUp={clearHold} onPointerCancel={clearHold} onLostPointerCapture={clearHold}
        onContextMenu={(event) => { event.preventDefault(); clearHold(); openMenu(direction) }}
        onMouseEnter={() => {
          clearTooltip()
          if (!menu && target !== null) tooltipTimer.current = setTimeout(() => setTooltip(direction), 500)
        }}
        onMouseLeave={clearTooltip} onBlur={clearTooltip}>
        <Icon aria-hidden="true" />
      </button>
    })}
    {tooltip && !menu && (tooltip === -1 ? back : forward) !== null && <div
      id={`${id}-tooltip`} className={`session-history-tooltip${tooltip === 1 ? ' forward' : ''}`} role="tooltip" data-native-terminal-occluder="">
      <span>{tooltip === -1 ? 'Back' : 'Forward'} to <b>{history.entries[(tooltip === -1 ? back : forward)!].name}</b></span>
      <kbd>{tooltip === -1 ? '⌘[' : '⌘]'}</kbd><small>hold for list</small>
    </div>}
    {menu && <div id={`${id}-menu`} className={`session-history-menu${menu === 1 ? ' forward' : ''}`}
      data-native-terminal-occluder="" ref={menuRef} role="menu" aria-label="Recently viewed" tabIndex={-1}
      aria-activedescendant={`${id}-${activeIndex}`}
      onKeyDown={(event) => {
        if (!['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') { closeMenu(true); return }
        if (event.key === 'Enter') { openEntry(activeIndex); return }
        const live = history.entries.map((_, index) => index).reverse().filter((index) => isLive(history.entries[index].sessionId))
        if (!live.length) return
        const position = live.indexOf(activeIndex)
        setActiveIndex(live[(position + (event.key === 'ArrowDown' ? 1 : -1) + live.length) % live.length])
      }}>
      <div className="session-history-head"><span>RECENTLY VIEWED</span><span>{history.entries.length} of {SESSION_HISTORY_LIMIT}</span></div>
      <div className="session-history-items">
        {history.entries.map((entry, index) => ({ entry, index })).reverse().map(({ entry, index }) => {
          const current = index === history.index
          const live = isLive(entry.sessionId)
          return <button key={index} id={`${id}-${index}`} data-history-index={index} type="button" role="menuitemradio"
            aria-label={`${entry.name}, ${!live ? 'closed' : current ? 'current' : relativeTime(entry.at, true)}`}
            aria-checked={current} disabled={!live} tabIndex={-1}
            className={`session-history-item${current ? ' current' : ''}${!live ? ' gone' : ''}${activeIndex === index ? ' kb' : ''}`}
            onMouseEnter={() => { if (live) setActiveIndex(index) }} onClick={() => openEntry(index)}>
            <span className="session-history-dot" aria-hidden="true" />
            <span className="session-history-name"><b>{entry.name}</b></span>
            <time>{current ? 'current' : relativeTime(entry.at)}</time>
          </button>
        })}
      </div>
      <div className="session-history-separator" />
      <div className="session-history-foot"><span>↑↓ to move · ↵ to open</span><span><kbd>⌘[</kbd> <kbd>⌘]</kbd></span></div>
    </div>}
  </div>
}

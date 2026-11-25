import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import './chat-block.css'

/** A button on a block: in the floating toolbar, or a ghost button in the caption bar. */
export type ChatBlockAction = {
  key: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  /** Shown beside the icon (caption bar only); the label is the tooltip and accessible name otherwise. */
  text?: string
  /** A toggle's state, such as Source. */
  pressed?: boolean
  disabled?: boolean
}

export type ChatBlockProps = {
  title: ReactNode
  /** After the title, such as the file name or diagram type. */
  detail?: ReactNode
  icon?: LucideIcon
  /** Floating tools in the top-right, shown on hover or keyboard focus. */
  toolbar?: readonly ChatBlockAction[]
  /** Ghost buttons at the right of the caption bar. */
  actions?: readonly ChatBlockAction[]
  /** A short message in the caption bar, such as "Copied". */
  status?: string
  children: ReactNode
  /** Fills the window; Esc asks to restore through `onMaximisedChange`. */
  maximised?: boolean
  onMaximisedChange?: (maximised: boolean) => void
  /** Spans instead of block elements, for a block inside a paragraph (a Markdown image). */
  inline?: boolean
  className?: string
  /** The block's accessible name; the title when it is text. */
  label?: string
}

function ActionButton({ action, ghost }: { action: ChatBlockAction; ghost?: boolean }) {
  const Icon = action.icon
  return (
    <button
      type="button"
      className={ghost ? 'chat-block-button chat-block-ghost' : 'chat-block-button'}
      title={action.label}
      aria-label={action.label}
      aria-pressed={action.pressed}
      disabled={action.disabled}
      onClick={(event) => { event.stopPropagation(); action.onSelect() }}
    >
      <Icon aria-hidden="true" />
      {ghost && action.text ? <span>{action.text}</span> : null}
    </button>
  )
}

/**
 * The frame rich chat content sits in: diagrams now, inline HTML later. A
 * bordered body, a slim caption bar (icon, title, detail and ghost buttons)
 * and a floating toolbar that appears on hover or keyboard focus.
 */
export function ChatBlock({ title, detail, icon: Icon, toolbar = [], actions = [], status, children, maximised = false, onMaximisedChange, inline = false, className, label }: ChatBlockProps) {
  const Frame: ElementType = inline ? 'span' : 'figure'
  const Part: ElementType = inline ? 'span' : 'div'
  const Caption: ElementType = inline ? 'span' : 'figcaption'
  useEffect(() => {
    if (!maximised || !onMaximisedChange) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onMaximisedChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximised, onMaximisedChange])
  return (
    <Frame
      className={['chat-block', className].filter(Boolean).join(' ')}
      data-maximised={maximised ? '' : undefined}
      aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      role={inline ? 'figure' : undefined}
    >
      <Part className="chat-block-body">{children}</Part>
      {toolbar.length ? (
        <Part className="chat-block-toolbar" role="toolbar" aria-label="Block tools">
          {toolbar.map((action) => <ActionButton key={action.key} action={action} />)}
        </Part>
      ) : null}
      <Caption className="chat-block-bar">
        {Icon ? <Icon className="chat-block-icon" aria-hidden="true" /> : null}
        <span className="chat-block-title"><b>{title}</b>{detail ? <> · {detail}</> : null}</span>
        {status ? <span className="chat-block-status" role="status">{status}</span> : null}
        {actions.map((action) => <ActionButton key={action.key} action={action} ghost />)}
      </Caption>
    </Frame>
  )
}

/** A message that clears itself after a few seconds, such as "Copied". */
export function useTransientStatus(durationMs = 2500): [string, (message: string) => void] {
  const [status, setStatus] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return [status, (message: string) => {
    clearTimeout(timer.current)
    setStatus(message)
    timer.current = setTimeout(() => setStatus(''), durationMs)
  }]
}

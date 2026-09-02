import { X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef } from 'react'
import { TmuxCreateControls, type SessionCreateRequest, type TmuxCreateControlsProps } from './TmuxCreateControls'
import './session-create-dialog.css'

type Props = Pick<TmuxCreateControlsProps, 'disabled' | 'onCreateSession' | 'onCreated' | 'probeRepo'> & {
  request: SessionCreateRequest
  onClose: () => void
}

/** The new-session form in a modal, opened from a group's "+" in the session tree. */
export function SessionCreateDialog({ request, onClose, ...form }: Props) {
  const dialogRef = useRef<HTMLElement>(null)
  const eyebrow = request.repo ? `Repository · ${request.repo.name}` : `Session group · ${request.groupName}`

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || dialog.contains(document.activeElement)) return
    dialog.querySelector<HTMLInputElement>('input[name="sessionName"]')?.focus()
  }, [request.id])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  return (
    <div
      className="session-create-backdrop"
      data-native-terminal-occluder=""
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        ref={dialogRef}
        className="session-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-create-title"
        onKeyDown={onKeyDown}
      >
        <header>
          <div className="session-create-heading">
            <span>{eyebrow}</span>
            <strong id="session-create-title">New session</strong>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"><X /></button>
        </header>
        <TmuxCreateControls variant="dialog" sessionCreateRequest={request} {...form} />
      </section>
    </div>
  )
}

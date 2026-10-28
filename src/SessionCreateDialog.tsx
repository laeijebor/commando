import { X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { TmuxCreateControls, type SessionCreateRequest, type TmuxCreateControlsProps } from './TmuxCreateControls'
import './session-create-dialog.css'

type Props = Pick<TmuxCreateControlsProps, 'token' | 'disabled' | 'onCreateSession' | 'onCreated' | 'probeRepo' | 'loadClaudeProfiles' | 'loadModelCatalogs'> & {
  request: SessionCreateRequest
  onClose: () => void
}

/** The new-session form in a modal, opened from a group's "+" in the session tree. */
export function SessionCreateDialog({ request, onClose, ...form }: Props) {
  const dialogRef = useRef<HTMLElement>(null)
  const [pending, setPending] = useState(false)
  const eyebrow = request.repo ? `Repository · ${request.repo.name}` : `Session group · ${request.groupName}`

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || dialog.contains(document.activeElement)) return
    // The prompt comes first: paste a screenshot straight away. Without one, the name.
    dialog.querySelector<HTMLElement>('textarea[name="openingPrompt"], input[name="sessionName"]')?.focus()
  }, [request.id])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A picker's menu renders outside the dialog and closes itself on Escape.
    if (event.key !== 'Escape' || !dialogRef.current?.contains(event.target as Node)) return
    event.preventDefault()
    event.stopPropagation()
    if (!pending) onClose()
  }

  return (
    <div
      className="session-create-backdrop"
      data-native-terminal-occluder=""
      onMouseDown={(event) => { if (!pending && event.target === event.currentTarget) onClose() }}
    >
      <section
        ref={dialogRef}
        className="session-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-create-title"
        aria-busy={pending}
        onKeyDown={onKeyDown}
      >
        <header>
          <div className="session-create-heading">
            <span>{eyebrow}</span>
            <strong id="session-create-title">New session</strong>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" disabled={pending}><X /></button>
        </header>
        <TmuxCreateControls variant="dialog" sessionCreateRequest={request} onPendingChange={setPending} {...form} />
      </section>
    </div>
  )
}

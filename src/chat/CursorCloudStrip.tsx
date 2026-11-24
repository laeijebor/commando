import { useEffect, useRef, useState } from 'react'
import { Cloud } from 'lucide-react'
import type { ChatSessionInfo } from '../../shared/agent-chat'
import type { CreateTmuxSessionRequest, SessionCreation, TmuxCreatedTarget } from '../../shared/tmux-create'
import type { PrQuickLookTab } from '../PrQuickLook'

/** Supplied only by views that can create and open local sessions. */
export type CursorCloudCheckout = {
  startSession: (input: CreateTmuxSessionRequest) => Promise<SessionCreation>
  creations: readonly SessionCreation[]
  onCreated: (created: TmuxCreatedTarget) => void
  dismissCreation: (id: string) => Promise<void>
}

export function CursorCloudStrip({ cloud, cwd, checkout, disabled, onOpenPr }: {
  cloud: NonNullable<ChatSessionInfo['cloud']>
  cwd: string
  checkout?: CursorCloudCheckout
  disabled?: boolean
  onOpenPr?: (repo: string, number: number, tab: PrQuickLookTab) => void
}) {
  const [pending, setPending] = useState(false)
  const [creation, setCreation] = useState<SessionCreation | null>(null)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const starting = useRef(false)
  const handled = useRef<string | null>(null)
  useEffect(() => {
    if (!creation || !checkout || handled.current === creation.id) return
    // A websocket update can arrive before startSession's response.
    const current = checkout.creations.find((candidate) => candidate.id === creation.id) ?? creation
    if (current.stage !== 'done' && current.stage !== 'failed') return
    handled.current = current.id
    setCreation(null)
    setPending(false)
    starting.current = false
    if (current.stage === 'failed') setError(current.error ?? 'Unable to check out locally')
    else if (current.result) {
      setWarning(current.result.worktree?.warning ?? '')
      checkout.onCreated(current.result.created)
    }
    void checkout.dismissCreation(current.id).catch(() => undefined)
  }, [creation, checkout])

  const checkOut = async () => {
    if (!checkout || !cloud.branch || starting.current) return
    starting.current = true
    setPending(true)
    setError('')
    setWarning('')
    try {
      setCreation(await checkout.startSession({
        name: cloud.branch.split('/').at(-1)!, autoName: true, cwd,
        worktree: { branch: cloud.branch, fromRemote: true, repoUrl: cloud.repoUrl },
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to check out locally')
      setPending(false)
      starting.current = false
    }
  }
  const repo = cloud.repoUrl.replace('https://github.com/', '')
  const pr = cloud.prUrl ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/.exec(cloud.prUrl) : null
  return (
    <section className="chat-cloud-strip" aria-label="Cursor cloud">
      <div>
        <span className="chat-cloud-strip__label"><Cloud size={13} aria-hidden="true" />Cursor cloud</span>
        <span className="chat-cloud-strip__repo" title={repo}>{repo}</span>
        {cloud.branch ? <a href={`${cloud.repoUrl}/tree/${cloud.branch}`} target="_blank" rel="noreferrer">{cloud.branch}</a> : null}
        {cloud.prUrl ? <a href={cloud.prUrl} target="_blank" rel="noreferrer" onClick={(event) => {
          if (!pr || !onOpenPr || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
          event.preventDefault()
          onOpenPr(pr[1]!, Number(pr[2]), 'Description')
        }}>{pr ? `PR #${pr[2]}` : 'Pull request'}</a> : null}
        {cloud.webUrl ? <a href={cloud.webUrl} target="_blank" rel="noreferrer">Open on cursor.com</a> : null}
        {cloud.branch && checkout ? <button type="button" disabled={disabled || pending} aria-busy={pending} onClick={() => { void checkOut() }}>
          {pending ? 'Checking out…' : 'Check out locally'}
        </button> : null}
        {error ? <span className="chat-cloud-strip__message text-xs text-destructive" role="alert">{error}</span> : null}
        {warning ? <span className="chat-cloud-strip__message" role="status">{warning}</span> : null}
      </div>
    </section>
  )
}

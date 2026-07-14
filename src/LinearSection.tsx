import { ArrowUpRight, Check, ChevronDown, ChevronsUp, CircleAlert, CirclePlus, Copy, Equal, LoaderCircle, MessageSquareReply, Minus, Plug, Trash2, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { createLinearApi, type LinearAccount, type LinearBoard, type LinearComment, type LinearIssueDetail, type LinearProject } from './linearApi'
import './linear-section.css'

const LINEAR_POLL_INTERVAL_MS = 30_000

function PriorityBadge({ priority, label }: { priority: number; label: string }) {
  const Icon = priority === 1
    ? CircleAlert
    : priority === 2
      ? ChevronsUp
      : priority === 3
        ? Equal
        : priority === 4
          ? ChevronDown
          : Minus
  return (
    <span className={`linear-priority priority-${priority}`} title={`Priority: ${label}`}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

function CommentThread({ comment, onReply }: { comment: LinearComment; onReply: (comment: LinearComment) => void }) {
  return (
    <div className="linear-comment">
      <div><strong>{comment.author?.name ?? 'Linear user'}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></div>
      <p>{comment.body}</p>
      <button type="button" onClick={() => onReply(comment)}><MessageSquareReply /> Reply</button>
      {comment.children.length ? <div className="linear-comment-children">{comment.children.map((child) => <CommentThread comment={child} onReply={onReply} key={child.id} />)}</div> : null}
    </div>
  )
}

export function LinearSection({ token }: { token: string }) {
  const api = useRef(createLinearApi(token)).current
  const [accounts, setAccounts] = useState<LinearAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [projects, setProjects] = useState<LinearProject[]>([])
  const [projectId, setProjectId] = useState('')
  const [board, setBoard] = useState<LinearBoard | null>(null)
  const [issue, setIssue] = useState<LinearIssueDetail | null>(null)
  const [replyTo, setReplyTo] = useState<LinearComment | null>(null)
  const [comment, setComment] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [polling, setPolling] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState(0)
  const [draggedIssueId, setDraggedIssueId] = useState<string | null>(null)
  const [dropStateId, setDropStateId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadAccounts = async () => {
    try {
      const next = await api.accounts()
      setAccounts(next)
      setAccountId((current) => next.some((account) => account.id === current) ? current : (next[0]?.id ?? ''))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load Linear accounts')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadAccounts() }, [])
  useEffect(() => {
    if (!accountId) { setProjects([]); setBoard(null); return }
    setLoading(true)
    api.projects(accountId).then(({ projects: next }) => {
      setProjects(next)
      setProjectId((current) => next.some((project) => project.id === current) ? current : (next[0]?.id ?? ''))
      setError('')
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load projects')).finally(() => setLoading(false))
  }, [accountId, api])
  useEffect(() => {
    if (!accountId || !projectId) { setBoard(null); return }
    let active = true
    let inFlight = false

    const loadBoard = async (background: boolean) => {
      if (inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      if (background) setPolling(true)
      else setLoading(true)
      try {
        const next = await api.board(accountId, projectId)
        if (!active) return
        setBoard(next)
        setLastSyncedAt(Date.now())
        setError('')
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load board')
      } finally {
        inFlight = false
        if (active) {
          setLoading(false)
          setPolling(false)
        }
      }
    }

    setBoard(null)
    void loadBoard(false)
    const timer = window.setInterval(() => { void loadBoard(true) }, LINEAR_POLL_INTERVAL_MS)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void loadBoard(true)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [accountId, api, projectId])

  useEffect(() => {
    if (!accountId || !issue?.id) return
    let active = true
    let inFlight = false
    const issueId = issue.id
    const refreshIssue = async () => {
      if (inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      try {
        const next = await api.issue(accountId, issueId)
        if (active) setIssue((current) => current?.id === issueId ? next : current)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to refresh issue')
      } finally {
        inFlight = false
      }
    }
    const timer = window.setInterval(() => { void refreshIssue() }, LINEAR_POLL_INTERVAL_MS)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refreshIssue()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [accountId, api, issue?.id])

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setConnecting(true)
    try {
      await api.connect(String(form.get('label') ?? ''), String(form.get('apiKey') ?? ''))
      formElement.reset()
      await loadAccounts()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to connect Linear')
    } finally { setConnecting(false) }
  }

  const openIssue = async (issueId: string) => {
    if (!accountId) return
    setLoading(true)
    try { setIssue(await api.issue(accountId, issueId)); setReplyTo(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load issue') }
    finally { setLoading(false) }
  }

  const moveIssueToState = async (issueId: string, stateId: string) => {
    if (!accountId || !board) return
    const currentIssue = board.issues.find((candidate) => candidate.id === issueId)
    const targetState = board.states.find((candidate) => candidate.id === stateId)
    if (!currentIssue || !targetState || currentIssue.state.id === targetState.id) return
    if (currentIssue.teamId !== targetState.teamId) {
      setError(`“${targetState.name}” belongs to a different Linear team`)
      return
    }
    setBoard((current) => current ? {
      ...current,
      issues: current.issues.map((item) => item.id === issueId ? { ...item, state: targetState } : item),
    } : current)
    setIssue((current) => current?.id === issueId ? { ...current, state: targetState } : current)
    try {
      const updated = await api.updateState(accountId, issueId, stateId)
      setIssue((current) => current?.id === issueId ? { ...current, state: updated.state } : current)
      setBoard((current) => current ? { ...current, issues: current.issues.map((item) => item.id === updated.id ? updated : item) } : current)
      setError('')
    } catch (cause) {
      setBoard((current) => current ? {
        ...current,
        issues: current.issues.map((item) => item.id === issueId ? currentIssue : item),
      } : current)
      setIssue((current) => current?.id === issueId ? { ...current, state: currentIssue.state } : current)
      setError(cause instanceof Error ? cause.message : 'Unable to update issue')
    }
  }

  const copyProjectLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      clearTimeout(copyResetTimer.current)
      copyResetTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch { setError('Unable to copy project link') }
  }

  const sendComment = async (event: FormEvent) => {
    event.preventDefault()
    if (!accountId || !issue || !comment.trim()) return
    try {
      await api.comment(accountId, issue.id, comment, replyTo?.id)
      setComment('')
      setReplyTo(null)
      setIssue(await api.issue(accountId, issue.id))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to add comment') }
  }

  const selectedProject = projects.find((project) => project.id === projectId)

  return (
    <section className="linear-section">
      <header className="linear-toolbar">
        <div><span>Connected workspaces</span><h1>Linear projects</h1></div>
        <div className="linear-selectors">
          {accountId && projectId ? (
            <span className="linear-live-status" title={lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleTimeString()}` : 'Waiting for first sync'}>
              <i /> {polling ? 'Syncing' : 'Live / 30s'}
            </span>
          ) : null}
          <select value={accountId} onChange={(event) => { setAccountId(event.target.value); setIssue(null) }} aria-label="Linear account">
            <option value="">Select account</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.label} / {account.workspaceName}</option>)}
          </select>
          <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setIssue(null) }} aria-label="Linear project" disabled={!accountId}>
            <option value="">Select project</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
          </select>
          {selectedProject ? <button type="button" className="linear-copy-link" onClick={() => void copyProjectLink(selectedProject.url)} title="Copy project link">{copied ? <Check /> : <Copy />}</button> : null}
          {accountId ? <button type="button" className="linear-remove" onClick={() => { if (window.confirm('Disconnect this Linear account?')) void api.remove(accountId).then(loadAccounts) }} title="Disconnect account"><Trash2 /></button> : null}
        </div>
      </header>
      {error ? <div className="linear-error" role="alert">{error}<button type="button" onClick={() => setError('')}><X /></button></div> : null}
      {loading ? <div className="linear-loading"><LoaderCircle className="spin" /> Syncing Linear</div> : null}
      {!accounts.length && !loading ? (
        <div className="linear-connect">
          <Plug /><h2>Connect a Linear account</h2><p>Add as many workspaces as you need. Keys remain in a private daemon-side file.</p>
          <form onSubmit={connect}><input name="label" placeholder="Account label" maxLength={80} required /><input name="apiKey" type="password" placeholder="Linear API key" required autoComplete="off" /><button type="submit" disabled={connecting}>{connecting ? 'Connecting...' : 'Connect account'}</button></form>
        </div>
      ) : (
        <>
          <details className="linear-add-account"><summary><CirclePlus /> Add another account</summary><form onSubmit={connect}><input name="label" placeholder="Account label" maxLength={80} required /><input name="apiKey" type="password" placeholder="Linear API key" required autoComplete="off" /><button type="submit">Connect</button></form></details>
          <div className="linear-board">
            {board?.states.map((state) => {
              const issues = board.issues.filter((item) => item.state.id === state.id)
              const draggedIssue = board.issues.find((item) => item.id === draggedIssueId)
              const acceptsDrop = Boolean(draggedIssue && draggedIssue.teamId === state.teamId)
              return <section
                className={`linear-column${dropStateId === state.id ? ' is-drop-target' : ''}`}
                key={state.id}
                onDragOver={(event) => {
                  if (!acceptsDrop) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropStateId(state.id)
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropStateId((current) => current === state.id ? null : current)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const issueId = draggedIssueId ?? event.dataTransfer.getData('text/linear-issue')
                  setDraggedIssueId(null)
                  setDropStateId(null)
                  if (issueId && acceptsDrop) void moveIssueToState(issueId, state.id)
                }}
              ><header><span style={{ backgroundColor: state.color }} /><strong>{state.name}</strong><small>{issues.length}</small></header><div>{issues.map((item) => <button
                type="button"
                draggable
                aria-grabbed={draggedIssueId === item.id}
                className={`linear-card${draggedIssueId === item.id ? ' is-dragging' : ''}`}
                onClick={() => void openIssue(item.id)}
                onDragStart={(event) => {
                  setDraggedIssueId(item.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/linear-issue', item.id)
                }}
                onDragEnd={() => { setDraggedIssueId(null); setDropStateId(null) }}
                key={item.id}
              ><span>{item.identifier}</span><strong>{item.title}</strong><footer><PriorityBadge priority={item.priority} label={item.priorityLabel} /><small>{item.assignee?.name ?? 'Unassigned'}</small></footer></button>)}</div></section>
            })}
            {board && !board.states.length ? <div className="linear-empty">No workflow states found for this project.</div> : null}
            {!board && accountId && !loading ? <div className="linear-empty">Choose a project to open its board.</div> : null}
          </div>
        </>
      )}
      {issue ? <aside className="linear-issue-drawer"><header><div><span>{issue.identifier}</span><h2>{issue.title}</h2></div><button type="button" onClick={() => setIssue(null)} aria-label="Close issue"><X /></button></header><div className="linear-issue-meta"><select value={issue.state.id} onChange={(event) => void moveIssueToState(issue.id, event.target.value)}>{issue.availableStates.map((state) => <option value={state.id} key={state.id}>{state.name}</option>)}</select><PriorityBadge priority={issue.priority} label={issue.priorityLabel} /><span>{issue.assignee?.name ?? 'Unassigned'}</span><a href={issue.url} target="_blank" rel="noreferrer">Open in Linear <ArrowUpRight /></a></div><article>{issue.description || 'No description.'}</article><section className="linear-comments"><h3>Comments</h3>{issue.comments.map((entry) => <CommentThread comment={entry} onReply={setReplyTo} key={entry.id} />)}<form onSubmit={sendComment}>{replyTo ? <span>Replying to {replyTo.author?.name ?? 'comment'} <button type="button" onClick={() => setReplyTo(null)}>Cancel</button></span> : null}<textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder={replyTo ? 'Write a reply...' : 'Add a comment...'} /><button type="submit">Post {replyTo ? 'reply' : 'comment'}</button></form></section></aside> : null}
    </section>
  )
}

import { ArrowUpRight, CirclePlus, LoaderCircle, MessageSquareReply, Plug, Trash2, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { createLinearApi, type LinearAccount, type LinearBoard, type LinearComment, type LinearIssueDetail, type LinearProject } from './linearApi'
import './linear-section.css'

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
  const [error, setError] = useState('')

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
    setLoading(true)
    api.board(accountId, projectId).then(setBoard).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load board')).finally(() => setLoading(false))
  }, [accountId, api, projectId])

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

  const changeState = async (stateId: string) => {
    if (!accountId || !issue) return
    try {
      const updated = await api.updateState(accountId, issue.id, stateId)
      setIssue((current) => current ? { ...current, state: updated.state } : current)
      setBoard((current) => current ? { ...current, issues: current.issues.map((item) => item.id === updated.id ? updated : item) } : current)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update issue') }
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

  return (
    <section className="linear-section">
      <header className="linear-toolbar">
        <div><span>Connected workspaces</span><h1>Linear projects</h1></div>
        <div className="linear-selectors">
          <select value={accountId} onChange={(event) => { setAccountId(event.target.value); setIssue(null) }} aria-label="Linear account">
            <option value="">Select account</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.label} / {account.workspaceName}</option>)}
          </select>
          <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setIssue(null) }} aria-label="Linear project" disabled={!accountId}>
            <option value="">Select project</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
          </select>
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
              return <section className="linear-column" key={state.id}><header><span style={{ backgroundColor: state.color }} /><strong>{state.name}</strong><small>{issues.length}</small></header><div>{issues.map((item) => <button type="button" className="linear-card" onClick={() => void openIssue(item.id)} key={item.id}><span>{item.identifier}</span><strong>{item.title}</strong><footer><small>{item.priorityLabel}</small><small>{item.assignee?.name ?? 'Unassigned'}</small></footer></button>)}</div></section>
            })}
            {board && !board.states.length ? <div className="linear-empty">No workflow states found for this project.</div> : null}
            {!board && accountId && !loading ? <div className="linear-empty">Choose a project to open its board.</div> : null}
          </div>
        </>
      )}
      {issue ? <aside className="linear-issue-drawer"><header><div><span>{issue.identifier}</span><h2>{issue.title}</h2></div><button type="button" onClick={() => setIssue(null)} aria-label="Close issue"><X /></button></header><div className="linear-issue-meta"><select value={issue.state.id} onChange={(event) => void changeState(event.target.value)}>{issue.availableStates.map((state) => <option value={state.id} key={state.id}>{state.name}</option>)}</select><span>{issue.assignee?.name ?? 'Unassigned'}</span><a href={issue.url} target="_blank" rel="noreferrer">Open in Linear <ArrowUpRight /></a></div><article>{issue.description || 'No description.'}</article><section className="linear-comments"><h3>Comments</h3>{issue.comments.map((entry) => <CommentThread comment={entry} onReply={setReplyTo} key={entry.id} />)}<form onSubmit={sendComment}>{replyTo ? <span>Replying to {replyTo.author?.name ?? 'comment'} <button type="button" onClick={() => setReplyTo(null)}>Cancel</button></span> : null}<textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder={replyTo ? 'Write a reply...' : 'Add a comment...'} /><button type="submit">Post {replyTo ? 'reply' : 'comment'}</button></form></section></aside> : null}
    </section>
  )
}

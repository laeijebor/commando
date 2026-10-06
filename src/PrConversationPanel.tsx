import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PrConversationEntry, PrDetails, PrReviewThread } from '../shared/pr-quick-look'
import type { PrsApiClient } from './prsApi'
import { groupPrConversation } from './prConversation'

type ThreadAction = 'reply' | 'resolve' | 'reopen'
type ThreadState = {
  draft?: string
  composing?: boolean
  busy?: ThreadAction | 'refresh'
  error?: string
  notice?: string
  refreshFailed?: boolean
}

export function PrConversationPanel({ details, unresolvedThreads, repo, number, api, renderComment, onChanged }: {
  details: PrDetails | null
  unresolvedThreads: number
  repo: string
  number: number
  api: PrsApiClient
  renderComment(entry: PrConversationEntry, options?: { reply?: boolean; detached?: boolean; showPath?: boolean }): ReactNode
  onChanged(): Promise<void>
}) {
  // Keep drafts outside individual rows so polling/reloading never destroys a reply in progress.
  const [states, setStates] = useState<Record<string, ThreadState>>({})
  const inFlight = useRef(new Set<string>())
  const context = useRef({ api, repo, number })
  const mounted = useRef(true)
  if (context.current.api !== api || context.current.repo !== repo || context.current.number !== number) {
    context.current = { api, repo, number }
  }
  useEffect(() => {
    mounted.current = true
    setStates({})
    inFlight.current.clear()
    return () => { mounted.current = false }
  }, [api, repo, number])
  const update = (id: string, patch: ThreadState) => setStates((current) => ({ ...current, [id]: { ...current[id], ...patch } }))
  const act = async (thread: PrReviewThread, action: ThreadAction) => {
    if (inFlight.current.has(thread.id)) return
    const draft = states[thread.id]?.draft ?? ''
    if (action === 'reply' && !draft.trim()) return
    const started = context.current
    const active = () => mounted.current && context.current === started
    inFlight.current.add(thread.id)
    update(thread.id, { busy: action, error: '', notice: '', refreshFailed: false })
    try {
      await api.threadAction(repo, number, thread.id, action, action === 'reply' ? draft : undefined)
    } catch (cause) {
      if (active()) update(thread.id, { busy: undefined, error: cause instanceof Error ? cause.message : 'Unable to update review thread' })
      if (active()) inFlight.current.delete(thread.id)
      return
    }
    if (!active()) return
    const notice = action === 'reply' ? 'Reply sent.' : action === 'resolve' ? 'Thread resolved.' : 'Thread reopened.'
    update(thread.id, { notice, ...(action === 'reply' ? { draft: '', composing: false } : {}) })
    try {
      await onChanged()
    } catch (cause) {
      if (active()) update(thread.id, { refreshFailed: true, error: `Saved on GitHub, but refresh failed: ${cause instanceof Error ? cause.message : 'Unable to refresh'}` })
    } finally {
      if (active()) update(thread.id, { busy: undefined })
      if (active()) inFlight.current.delete(thread.id)
    }
  }
  const refresh = async (id: string) => {
    if (inFlight.current.has(id)) return
    const started = context.current
    inFlight.current.add(id)
    update(id, { busy: 'refresh', error: '' })
    try {
      await onChanged()
      if (mounted.current && context.current === started) update(id, { refreshFailed: false })
    } catch (cause) {
      if (mounted.current && context.current === started) update(id, { error: `Refresh failed: ${cause instanceof Error ? cause.message : 'Unable to refresh'}` })
    } finally {
      if (mounted.current && context.current === started) update(id, { busy: undefined })
      if (mounted.current && context.current === started) inFlight.current.delete(id)
    }
  }
  const conversation = useMemo(() => groupPrConversation(details?.conversation ?? []), [details])
  const replies = conversation.reduce((count, thread) => count + thread.replies.length, 0)
  const unresolved = details?.unresolvedThreads ?? unresolvedThreads
  return (
    <>
      {!details ? <p role="status">Loading conversation…</p> : <>
      <h3>
        Conversation <small>
          {conversation.length + replies} entries
          {replies ? ` · ${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''} ·{' '}
          {unresolved} unresolved {unresolved === 1 ? 'thread' : 'threads'}
        </small>
      </h3>
      {conversation.length ? conversation.map(({ entry, replies: threadReplies, detachedReply }) => {
        const thread = entry.thread
        const state = thread ? states[thread.id] ?? {} : {}
        return <article className="pr-quick-comment" key={entry.id} data-comment-id={entry.id}>
          {renderComment(entry, { detached: detachedReply })}
          {threadReplies.length ? (
            <div className="pr-quick-thread-replies" aria-label="Replies to this comment">
              {threadReplies.map((reply) => (
                <article className="pr-quick-reply" key={reply.id} data-comment-id={reply.id} aria-label={`Reply by ${reply.author}`}>
                  {renderComment(reply, { reply: true, showPath: reply.path !== entry.path })}
                </article>
              ))}
            </div>
          ) : null}
          {thread ? <>
            <div className="pr-quick-thread-actions">
              <span className={`pr-quick-thread-status ${thread.isResolved ? 'pass' : 'pending'}`}>
                {thread.isResolved ? '✓ Resolved' : 'Open thread'}
              </span>
              {thread.viewerCanReply && !state.composing ? (
                <button type="button" className="pr-pop-btn" disabled={Boolean(state.busy) || state.refreshFailed}
                  onClick={() => update(thread.id, { composing: true, error: '', notice: '' })}>
                  Reply
                </button>
              ) : null}
              {(thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) ? (
                <button type="button" className="pr-pop-btn" disabled={Boolean(state.busy) || state.refreshFailed}
                  onClick={() => { void act(thread, thread.isResolved ? 'reopen' : 'resolve') }}>
                  {state.busy === 'resolve' ? 'Resolving…' : state.busy === 'reopen' ? 'Reopening…' : thread.isResolved ? 'Reopen' : 'Resolve'}
                </button>
              ) : null}
            </div>
            {state.composing ? (
              <form className="pr-quick-reply-form" onSubmit={(event) => { event.preventDefault(); void act(thread, 'reply') }}>
                <label>
                  Reply to {entry.author}
                  <textarea
                    aria-label={`Reply to ${entry.author} on ${entry.path ?? 'review thread'}`}
                    autoFocus maxLength={60_000}
                    value={state.draft ?? ''}
                    disabled={Boolean(state.busy)}
                    placeholder="Write a reply… Markdown supported"
                    onChange={(event) => update(thread.id, { draft: event.target.value })}
                  />
                </label>
                <div>
                  <small>Markdown supported</small>
                  <button type="button" className="pr-pop-btn" disabled={Boolean(state.busy)}
                    onClick={() => update(thread.id, { composing: false, error: '' })}>
                    Cancel
                  </button>
                  <button type="submit" className="pr-pop-btn primary"
                    disabled={Boolean(state.busy) || !state.draft?.trim() || !thread.viewerCanReply || state.refreshFailed}>
                    {state.busy === 'reply' ? 'Sending…' : 'Send reply'}
                  </button>
                </div>
              </form>
            ) : null}
            {state.notice ? <p className="pr-quick-thread-notice" role="status">{state.notice}</p> : null}
            {state.error ? (
              <p className="pr-quick-thread-error" role="alert">
                {state.error}
                {state.refreshFailed ? <>{' '}
                  <button type="button" className="pr-pop-btn" disabled={Boolean(state.busy)} onClick={() => { void refresh(thread.id) }}>
                    {state.busy === 'refresh' ? 'Refreshing…' : 'Refresh conversation'}
                  </button>
                </> : null}
              </p>
            ) : null}
          </> : null}
        </article>
      }) : <p>No conversation yet.</p>}
      </>}
    </>
  )
}

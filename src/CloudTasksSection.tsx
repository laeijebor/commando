import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  CLOUD_PROMPT_LIMIT, cloudConnectionKey, cloudProviderHome, cloudTaskLabel, isSafeCloudUrl,
  type CloudOperation, type CloudTaskDetail, type CloudTaskSummary,
} from '../shared/cloud-tasks'
import type { CloudTasksApi } from './cloudTasksApi'
import { useCloudTask, useCloudTasks } from './cloudTaskStore'
import { CloudTaskCard, cloudTaskConnectionLabel } from './CloudTaskCard'
import { CloudTaskCreateDialog, useCloudAccountConfirmation } from './CloudTaskCreateDialog'
import { CloudTaskDiff } from './CloudTaskDiff'
import './cloud-tasks.css'

export function cloudOperationLabel(operation: CloudOperation): string {
  if (operation.state === 'accepted') return operation.kind === 'message' ? 'Message sent'
    : operation.receipt?.evidence === 'user_link' ? 'Identity linked · user-supplied' : 'Provider receipt saved'
  return ({ prepared: 'Recorded locally', dispatching: 'Sending', rejected: 'Not submitted', delivery_unknown: 'Delivery unknown' })[operation.state]
}
const date = (value: string | number | null) => value ? new Date(value).toLocaleString() : 'Not observed'

export function CloudTasksSection({ api, selectedTaskId, onSelectTask }: {
  api: CloudTasksApi
  selectedTaskId?: string | null
  onSelectTask?: (id: string) => void
}) {
  const state = useCloudTasks(api)
  const [localId, setLocalId] = useState<string | null>(null)
  const id = selectedTaskId === undefined ? localId : selectedTaskId
  const detail = useCloudTask(api, id)
  const [showArchived, setShowArchived] = useState(false)
  const [detailOpen, setDetailOpen] = useState(!!id)
  const [dialog, setDialog] = useState<'create' | 'link' | null>(null)
  const [reentryKey, setReentryKey] = useState<string | undefined>()
  const [error, setError] = useState('')
  const [retrying, setRetrying] = useState<string | null>(null)
  const list = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const restoreListFocus = useRef(false)
  const selected = state.tasks.find((task) => task.id === id)

  useEffect(() => { if (id) setDetailOpen(true) }, [id])
  useEffect(() => {
    if (!id || !state.connected) return
    let active = true
    setError('')
    void state.store.loadDetail(id).catch(() => { if (active) setError('Unable to load task detail. Refresh to retry; saved tasks remain available.') })
    return () => { active = false }
  }, [id, state.store, state.connected])
  useEffect(() => { if (id && detailOpen && detail) title.current?.focus({ preventScroll: true }) }, [id, detailOpen, !!detail])
  useLayoutEffect(() => {
    if (detailOpen || !restoreListFocus.current) return
    restoreListFocus.current = false
    const row = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-cloud-task-id]') ?? []).find((node) => node.dataset.cloudTaskId === id)
    ;(row ?? list.current?.querySelector<HTMLElement>('input'))?.focus()
  }, [detailOpen, id])

  const select = (taskId: string) => {
    setLocalId(taskId); setDetailOpen(true); onSelectTask?.(taskId)
  }
  return <section className="cloud-tasks cloud-section" aria-label="Cloud tasks">
    <header className="cloud-toolbar"><h1>Cloud tasks</h1>
      <button type="button" disabled={!state.connected} onClick={() => setDialog('link')}>Link existing</button>
      <button type="button" className="cloud-primary" disabled={!state.connected} onClick={() => setDialog('create')}>+ New task</button>
      <button type="button" disabled={state.loading} onClick={() => void state.store.refresh()}>Refresh tasks</button>
    </header>
    {(!state.connected || state.error) && <p className="cloud-notice" role="status">{state.error || (state.loading ? 'Loading cloud tasks…' : 'Connecting to daemon…')}
      {state.lastLoadedAt && <> Last loaded {date(state.lastLoadedAt)}. Provider links remain available.</>}</p>}
    {error && <p role="alert" className="cloud-notice">{error}</p>}
    {!!state.pending.length && <section className="cloud-recovery" aria-label="Pending intent recovery">
      <h2>Pending intent recovery</h2>
      {state.pending.map((intent) => <div key={intent.key} className="cloud-notice">
        <strong>{intent.status === 'checking' ? 'Checking recorded intent…' : intent.operation
          ? `${intent.operation.kind === 'message' ? 'Follow-up' : 'Task intent'} · ${cloudOperationLabel(intent.operation)}`
          : 'Unknown draft — no operation found or recovery unavailable'}</strong>
        <p>Key: <code>{intent.key}</code></p>
        {intent.operation ? <>
          <p>{intent.operation.kind === 'message' ? 'Session acceptance or linking does not prove this message arrived.'
            : 'This is a local delivery record, not proof of hosted execution.'} No automatic replay.</p>
          <button onClick={() => select(intent.operation!.taskId)}>View recorded task</button>
        </> : <p>The request may have reached the daemon or provider. Check the provider before retrying. After reload the prompt is not restored and nothing is automatically replayed.</p>}
        {intent.retryable && <button disabled={!state.connected || !!retrying} onClick={() => {
          setRetrying(intent.key); setError('')
          void state.store.retry(intent.key).then((action) => { if (action) select(action.task.id) })
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Recovery unavailable.'))
            .finally(() => setRetrying(null))
        }}>Recover / retry same intent</button>}
        {!intent.operation && <button disabled={!state.connected} onClick={() => { setReentryKey(intent.key); setDialog('create') }}>Re-enter original intent…</button>}
      </div>)}
    </section>}
    <div className={`cloud-content${detailOpen && id ? ' cloud-content--detail-open' : ''}`}>
      <section className="cloud-list" ref={list} aria-label="Saved cloud tasks">
        <div className="cloud-list-tools"><strong>Saved tasks</strong><label className="cloud-check"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Archived</label></div>
        {state.tasks.filter((task) => showArchived || !task.archivedAt).map((task) => <CloudTaskCard key={task.id} task={task} connectionLabel={cloudTaskConnectionLabel(task, state.providers?.providers)} selected={task.id === id} onSelect={select} />)}
        {!state.tasks.some((task) => showArchived || !task.archivedAt) && <p>{state.loading ? 'Loading…' : 'No saved cloud tasks. Create or link a task to get started; no local session is required.'}</p>}
        <p className="cloud-hint">Only tasks submitted or explicitly linked through Commando.</p>
      </section>
      <article className="cloud-detail" aria-label="Selected cloud task">
        <button className="cloud-back" onClick={() => {
          restoreListFocus.current = true
          setDetailOpen(false)
        }}>← Back to tasks</button>
        <h2 tabIndex={-1} ref={title}>{detail?.task.title ?? selected?.title ?? (id ? 'Loading task…' : 'Select a cloud task')}</h2>
        {(detail?.task ?? selected) && <p className="cloud-hint">{cloudTaskConnectionLabel((detail?.task ?? selected)!, state.providers?.providers)}</p>}
        {detail ? <TaskDetail key={detail.task.id} api={api} detail={detail} /> : selected ? <>
          <p>{cloudTaskLabel(selected)}</p><ProviderLink task={selected} />
        </> : <p>Provider-hosted tasks stay available independently of local terminal sessions.</p>}
      </article>
    </div>
    {dialog && <CloudTaskCreateDialog api={api} mode={dialog} reentryKey={reentryKey} onClose={() => { setDialog(null); setReentryKey(undefined) }} onCreated={select} />}
  </section>
}

function ProviderLink({ task }: { task: CloudTaskSummary }) {
  const url = isSafeCloudUrl(task.provider, task.providerUrl) ? task.providerUrl : cloudProviderHome(task.provider)
  return <a href={url} target="_blank" rel="noopener noreferrer">Open in {task.provider === 'claude' ? 'Claude' : 'Codex'} ↗</a>
}

function TaskDetail({ api, detail }: { api: CloudTasksApi; detail: CloudTaskDetail }) {
  const { task, operations } = detail
  const { providers, connected, pending, store } = useCloudTasks(api)
  const provider = providers?.providers.find((item) => cloudConnectionKey(item.id, item.credentialContextId) === cloudConnectionKey(task.provider, task.credentialContextId))
  const canInspect = provider?.readiness === 'ready' && provider.capabilities.inspect
  const [title, setTitle] = useState(task.title)
  const [message, setMessage] = useState('')
  const { confirmed, credentialContextId, contextChanged, setConfirmed } = useCloudAccountConfirmation(provider)
  const [riskConfirmed, setRiskConfirmed] = useState(false)
  const [linking, setLinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const unresolvedMessage = operations.some((op) => op.kind === 'message' && op.state === 'delivery_unknown')
    || pending.some((intent) => intent.status === 'unknown')
  const run = async (action: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cloud action unavailable.') }
    finally { lock.current = false; setBusy(false) }
  }
  return <>
    <div className="cloud-notice"><strong>{cloudTaskLabel(task)}</strong>
      {!provider && <p>Connection {cloudTaskConnectionLabel(task)} is unavailable. Restore this connection to use provider actions; another profile will not be substituted.</p>}
      {['prepared', 'dispatching'].includes(task.deliveryState) && <p>A local acknowledgement is not cloud acceptance. Do not close the laptop expecting hosted execution before a provider receipt.</p>}
      {task.deliveryState === 'delivery_unknown' && <p>Delivery unknown — check provider before retrying. A timeout or list miss cannot prove this request did not arrive. No automatic replay.</p>}
      {task.identityEvidence === 'user_link' && <p>Identity supplied by you. Linking does not prove acceptance of an earlier request or any follow-up message.</p>}
      {task.provider === 'claude' && <p>Live status is only available in Claude. Saved receipts are not live progress.</p>}
      {task.remoteState === 'result_ready' && <p>Ready for review, not proof of success or passed tests.</p>}
      {task.observationState !== 'fresh' && <p>Observation: {task.observationState}. Showing last-known information.</p>}
      {task.issue && <p>{task.issue.message}</p>}
    </div>
    <div className="cloud-actions"><ProviderLink task={task} />
      <button disabled={!connected || busy} onClick={() => void run(() => store.loadDetail(task.id, canInspect))}>
        {canInspect ? 'Refresh status' : 'Refresh saved record'}</button>
      <button disabled={!connected || busy} onClick={() => void run(() => store.patch(task.id, { archivedAt: task.archivedAt ? null : new Date().toISOString() }))}>{task.archivedAt ? 'Unarchive' : 'Archive'}</button>
      {provider?.capabilities.link && task.deliveryState === 'delivery_unknown' && <button disabled={!connected || busy} onClick={() => setLinking(true)}>Link known task identity</button>}
    </div>
    <p className="cloud-hint">Archive only changes local presentation; remote work is unaffected.</p>
    <dl className="cloud-data">
      <dt>Provider</dt><dd>{cloudTaskConnectionLabel(task, providers?.providers)} · {provider?.readiness ?? 'unavailable'}{provider?.reason ? ` — ${provider.reason}` : ''}</dd>
      <dt>Repository</dt><dd>{task.source.repository ?? 'Not recorded'}</dd>
      <dt>Environment</dt><dd>{task.source.environmentId ?? 'Not recorded'}</dd>
      <dt>Checkout</dt><dd>{task.source.checkoutPath ?? 'Not required for saved identity'}</dd>
      <dt>Requested ref</dt><dd>{task.source.branch ?? 'Not recorded'}</dd>
      <dt>Commit</dt><dd>{task.source.commit ?? 'Moving branch; remote commit not verified'}</dd>
      <dt>Remote ID</dt><dd>{task.providerTaskId ?? 'Not known'}</dd>
      <dt>Last checked</dt><dd>{date(task.lastObservedAt)}</dd>
      <dt>Raw status</dt><dd>{task.rawState ?? 'Not available'}</dd>
      <dt>Account</dt><dd>{task.verifiedAccountRef ?? 'Official account identity unverified'} · {task.credentialContextId}</dd>
    </dl>
    <form className="cloud-form" onSubmit={(event) => { event.preventDefault(); void run(() => store.patch(task.id, { title: title.trim() })) }}>
      <label>Local title<input value={title} required maxLength={240} disabled={!connected || busy} onChange={(event) => setTitle(event.target.value)} /></label>
      <button disabled={!connected || busy || !title.trim() || title === task.title}>Save title</button>
    </form>
    {error && <p className="cloud-notice" role="alert">{error}</p>}
    <section className="cloud-detail-block"><h3>Original prompt</h3><p className="cloud-prompt">{task.prompt || 'No prompt recorded for this linked task.'}</p></section>
    <section className="cloud-detail-block"><h3>Commando activity</h3><p>Local delivery history, not a provider transcript.</p>
      <ol className="cloud-activity">{operations.map((op) => <li key={op.id}>
        <time dateTime={op.updatedAt}>{date(op.updatedAt)}</time> · {op.kind === 'message' ? 'Follow-up' : op.kind === 'link' ? 'Link' : 'Create'} · <strong>{cloudOperationLabel(op)}</strong>
        {op.kind === 'message' && 'message' in op.payload && <p className="cloud-prompt">{op.payload.message}</p>}
        {op.kind === 'message' && op.state === 'delivery_unknown' && <p className="cloud-notice">This message remains delivery unknown. Session acceptance or linking cannot prove it arrived; message-specific receipt evidence is required.</p>}
        {op.issue && <p>{op.issue.message}</p>}
        {op.receipt && <div className="cloud-notice">
          <strong>Operation receipt identity</strong>
          <p>Remote ID: <code>{op.receipt.providerTaskId}</code> · {op.receipt.evidence}</p>
          {op.receipt.providerTaskId !== task.providerTaskId && <p>This receipt differs from the tracked task identity ({task.providerTaskId ?? 'not linked'}). Both identities are retained; neither overwrites the other.</p>}
          {isSafeCloudUrl(task.provider, op.receipt.providerUrl) && <a href={op.receipt.providerUrl} target="_blank" rel="noopener noreferrer">Open operation receipt in {task.provider === 'claude' ? 'Claude' : 'Codex'} ↗</a>}
        </div>}
        {op.state === 'prepared' && <PreparedOperation api={api} operation={op} task={task} />}
      </li>)}</ol>
    </section>
    {provider?.readiness === 'ready' && provider.capabilities.sendMessage && task.providerTaskId ? <form className="cloud-form" onSubmit={(event) => {
      event.preventDefault()
      if (!confirmed || !message.trim() || (unresolvedMessage && !riskConfirmed)) return
      void run(async () => {
        const input = { credentialContextId, message, accountConfirmed: confirmed }
        // Each new intent needs a fresh account/duplicate-risk confirmation, including after a lost response.
        setConfirmed(false); setRiskConfirmed(false)
        await store.message(task.id, input)
        setMessage('')
      })
    }}>
      <h3>Follow-up</h3><label>Message<textarea required rows={3} value={message} maxLength={CLOUD_PROMPT_LIMIT} disabled={!connected || busy} onChange={(event) => setMessage(event.target.value)} /></label>
      <p>Confirmation context: <code>{provider.credentialContextId}</code> · {provider.verifiedAccountRef ?? 'Account identity unverified'}</p>
      {contextChanged && <p role="alert">Provider account/context changed. Review and confirm again before sending.</p>}
      <label className="cloud-check"><input type="checkbox" required checked={confirmed} disabled={!connected || busy} onChange={(event) => setConfirmed(event.target.checked)} />I confirm the current CLI account/context owns this session.</label>
      {unresolvedMessage && <label className="cloud-check cloud-notice"><input type="checkbox" required checked={riskConfirmed} disabled={!connected || busy} onChange={(event) => setRiskConfirmed(event.target.checked)} />An earlier message or intent is unresolved. I checked the provider and intend a new message; duplicates are possible.</label>}
      <button disabled={!connected || busy || !confirmed || !message.trim() || (unresolvedMessage && !riskConfirmed)}>Send new message</button>
      <p>Message sent means delivery acknowledged, not task completion.</p>
    </form> : <p className="cloud-hint">Follow-up is unavailable through this CLI capability. Continue in the provider UI.</p>}
    <CloudTaskDiff api={api} task={task} enabled={provider?.readiness === 'ready' && provider.capabilities.diff && !!task.providerTaskId} connected={connected} />
    {linking && <CloudTaskCreateDialog api={api} mode="link" recoveryTask={task} onClose={() => setLinking(false)} />}
  </>
}

function PreparedOperation({ api, operation, task }: { api: CloudTasksApi; operation: CloudOperation; task: CloudTaskSummary }) {
  const { providers, connected, store } = useCloudTasks(api)
  const provider = providers?.providers.find((item) => cloudConnectionKey(item.id, item.credentialContextId) === cloudConnectionKey(task.provider, task.credentialContextId))
  const { confirmed, credentialContextId, contextChanged, setConfirmed } = useCloudAccountConfirmation(provider)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const enabled = !!provider && (operation.kind === 'link' ? provider.capabilities.link
    : provider.readiness === 'ready' && (operation.kind === 'message' ? provider.capabilities.sendMessage : provider.capabilities.create))
  const contextMatches = provider?.credentialContextId === operation.payload.credentialContextId
  return <form className="cloud-form cloud-notice" aria-label={`Resume prepared ${operation.kind}`} onSubmit={(event) => {
    event.preventDefault()
    if (lock.current || !confirmed || !contextMatches || !connected || !enabled) return
    lock.current = true; setBusy(true); setError('')
    const input = { credentialContextId, accountConfirmed: true }
    setConfirmed(false)
    void store.resumeOperation(operation.id, input).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Resume response unavailable. Refresh the operation before continuing.')
    }).finally(() => { lock.current = false; setBusy(false) })
  }}>
    <h3>Resume prepared operation</h3>
    <p>Only this recorded, not-yet-dispatched request can resume. Unknown or accepted operations cannot be replayed.</p>
    <p>Connection: {cloudTaskConnectionLabel(task, providers?.providers)}. Original context: <code>{operation.payload.credentialContextId}</code>. Current context: <code>{provider?.credentialContextId ?? 'Unavailable'}</code> · {provider?.verifiedAccountRef ?? 'Account identity unverified'}.</p>
    <p>Original target: {task.id} · {task.providerTaskId ?? 'New provider task'}.</p>
    <p className="cloud-prompt">Original source: {JSON.stringify('source' in operation.payload ? operation.payload.source ?? task.source : task.source, null, 2)}</p>
    {'prompt' in operation.payload && <p className="cloud-prompt">Recorded request: {operation.payload.prompt}</p>}
    {!contextMatches && <p>Restore the original credential context before resuming this operation.</p>}
    {contextChanged && <p role="alert">Provider account/context changed. Confirm again after reviewing the original source.</p>}
    <label className="cloud-check"><input type="checkbox" checked={confirmed} disabled={busy || !connected || !enabled || !contextMatches}
      onChange={(event) => setConfirmed(event.target.checked)} />I reconfirm this original request, source/target, and current account/context before resuming.</label>
    <button disabled={busy || !connected || !enabled || !contextMatches || !confirmed}>Resume prepared operation</button>
    {error && <p role="alert">{error}</p>}
  </form>
}

/** Independent HUD group; never mixes cloud tasks into pane-based counts or filters. */
export function CloudTasksHud({ api, onSelectTask }: { api: CloudTasksApi; onSelectTask: (id: string) => void }) {
  const { tasks, providers, connected, loading, pending } = useCloudTasks(api)
  const active = tasks.filter((task) => !task.archivedAt)
  return <section className="cloud-tasks cloud-hud" aria-label="Cloud tasks HUD">
    <h2>Cloud tasks <span>{active.length}</span></h2>
    {!connected && <p role="status">{loading ? 'Loading cloud tasks…' : 'Offline · last-known tasks'}</p>}
    {!!pending.length && <p role="status">{pending.length} unresolved intent{pending.length === 1 ? '' : 's'} · review in Cloud tasks</p>}
    {active.map((task) => <CloudTaskCard key={task.id} task={task} connectionLabel={cloudTaskConnectionLabel(task, providers?.providers)} compact onSelect={onSelectTask} />)}
    {!active.length && !loading && <p>No active cloud tasks.</p>}
  </section>
}

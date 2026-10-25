import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CLOUD_PROMPT_LIMIT, cloudConnectionKey, cloudProviderHome, validCloudRemoteId, type CloudProviderId, type CloudProviderInfo, type CloudTaskSummary } from '../shared/cloud-tasks'
import type { CloudTasksApi } from './cloudTasksApi'
import { CloudIntentMismatchError, useCloudTasks, type CloudIntent } from './cloudTaskStore'
import { cloudTaskConnectionLabel } from './CloudTaskCard'
import './cloud-tasks.css'

export const CLAUDE_CREATE_DISABLED_REASON = 'Claude creation is unverified: receipt/detach and an enforceable pushed-source/no-bundle path have not been confirmed. Create in Claude, then link the session here.'

type ConnectionChoice = Pick<CloudProviderInfo, 'id' | 'credentialContextId' | 'label'>
function initialConnection(providers: CloudProviderInfo[]): ConnectionChoice | null {
  const codex = providers.filter((info) => info.id === 'codex')
  const info = codex.length === 1 ? codex[0] : providers[0]
  return info ? { id: info.id, credentialContextId: info.credentialContextId, label: info.label } : null
}

/** Keep the context the user actually saw, and invalidate confirmation on provider/account drift. */
export function useCloudAccountConfirmation(info: CloudProviderInfo | undefined) {
  const [context, setContext] = useState<{ provider: CloudProviderId; id: string; account: string | null } | null>(null)
  const confirmed = !!context && context.provider === info?.id && context.id === info.credentialContextId && context.account === info.verifiedAccountRef
  return {
    confirmed, credentialContextId: context?.id ?? '', contextChanged: !!context && !confirmed,
    setConfirmed: (value: boolean) => setContext(value && info ? { provider: info.id, id: info.credentialContextId, account: info.verifiedAccountRef } : null),
  }
}

export function CloudTaskCreateDialog({ api, mode = 'create', recoveryTask, reentryKey, onClose, onCreated }: {
  api: CloudTasksApi
  mode?: 'create' | 'link'
  recoveryTask?: CloudTaskSummary
  reentryKey?: string
  onClose: () => void
  onCreated?: (id: string) => void
}) {
  const { providers, tasks, connected, pending, store } = useCloudTasks(api)
  const [kind, setKind] = useState<CloudIntent['kind']>(mode)
  const [reentryTarget, setReentryTarget] = useState('')
  const boundTask = recoveryTask ?? (reentryKey && kind !== 'create' ? tasks.find((task) => task.id === reentryTarget) : undefined)
  const hasBinding = !!recoveryTask || (!!reentryKey && kind !== 'create' && !!reentryTarget)
  const [connectionChoice, setConnectionChoice] = useState<ConnectionChoice | null>(() => initialConnection(providers?.providers ?? []))
  // Default only once providers arrive. Neither reordering nor removal may rebind this draft.
  useEffect(() => {
    if (!connectionChoice && providers?.providers.length) setConnectionChoice(initialConnection(providers.providers))
  }, [connectionChoice, providers])
  const connection = boundTask ? { id: boundTask.provider, credentialContextId: boundTask.credentialContextId }
    : hasBinding ? null : connectionChoice
  const selectedConnectionKey = connection ? cloudConnectionKey(connection.id, connection.credentialContextId) : ''
  const provider = connection?.id ?? 'codex'
  const [target, setTarget] = useState('')
  const [branch, setBranch] = useState('')
  const [prompt, setPrompt] = useState('')
  const [title, setTitle] = useState('')
  const [remoteId, setRemoteId] = useState('')
  const [riskConfirmed, setRiskConfirmed] = useState(false)
  const [mismatch, setMismatch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const dialog = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const headingId = useId()
  const helpId = useId()
  const info = providers?.providers.find((item) => cloudConnectionKey(item.id, item.credentialContextId) === selectedConnectionKey)
  const connectionLabel = info?.label ?? (connection ? `${provider === 'claude' ? 'Claude' : 'Codex'} · ${connection.credentialContextId} (unavailable)` : 'Connection unavailable')
  const { confirmed, credentialContextId, contextChanged, setConfirmed } = useCloudAccountConfirmation(info)
  const linking = kind === 'link'
  const messaging = kind === 'message'
  const capability = linking ? info?.capabilities.link : info?.readiness === 'ready' && (messaging ? info.capabilities.sendMessage : info.capabilities.create)
  const uncertainIntents = pending.some((item) => item.status !== 'recorded' || item.operation?.state === 'delivery_unknown')
  const reason = !info ? 'Selected connection is unavailable. Restore it or explicitly select a configured connection; another profile is never substituted.'
    : capability ? info.reason : kind === 'create' && provider === 'claude'
    ? [info?.reason, CLAUDE_CREATE_DISABLED_REASON].filter(Boolean).join(' ') : info?.reason ?? 'Provider capability has not been verified.'

  useEffect(() => {
    const root = dialog.current!
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'))
      .filter((node) => !node.closest('[hidden], [inert]'))
      .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
    const focusFirst = () => (focusables()[0] ?? root).focus()
    const containFocus = (event: FocusEvent) => { if (!root.contains(event.target as Node)) focusFirst() }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const items = focusables()
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (!items.length || (event.shiftKey ? index <= 0 : index < 0 || index === items.length - 1)) {
        event.preventDefault()
        ;(event.shiftKey ? items.at(-1) ?? root : items[0] ?? root).focus()
      }
    }
    const siblings = Array.from(document.body.children).filter((node) => node !== root.parentElement && node instanceof HTMLElement) as HTMLElement[]
    const prior = siblings.map((node) => node.inert)
    siblings.forEach((node) => { node.inert = true })
    focusFirst()
    document.addEventListener('focusin', containFocus)
    document.addEventListener('keydown', keydown, true)
    return () => {
      document.removeEventListener('focusin', containFocus)
      document.removeEventListener('keydown', keydown, true)
      siblings.forEach((node, index) => { node.inert = prior[index] })
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  const submit = async () => {
    if (submitting.current || uncertain || !connected || !capability || !confirmed
      || (!reentryKey && !linking && uncertainIntents && !riskConfirmed) || (messaging && !boundTask)) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const intent: CloudIntent = messaging ? { kind: 'message', taskId: boundTask!.id, input: { credentialContextId, message: prompt, accountConfirmed: confirmed } }
        : linking ? { kind: 'link', taskId: boundTask?.id, input: { provider, credentialContextId, providerTaskId: remoteId.trim(), title: title.trim() || undefined,
          source: boundTask?.source, accountConfirmed: confirmed } }
        : { kind: 'create', input: { provider, credentialContextId, title: title.trim() || undefined, prompt,
          source: provider === 'codex' ? { environmentId: target.trim(), branch: branch.trim() }
            : { checkoutPath: target.trim(), branch: branch.trim() }, accountConfirmed: confirmed } }
      const action = reentryKey ? await store.reenter(reentryKey, intent, mismatch && riskConfirmed)
        : intent.kind === 'create' ? await store.create(intent.input)
          : intent.kind === 'link' ? await store.link(intent.input, intent.taskId) : await store.message(intent.taskId, intent.input)
      if (action) onCreated?.(action.task.id)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to record request.')
      if (cause instanceof CloudIntentMismatchError) { setMismatch(true); setRiskConfirmed(false) }
      else setUncertain(true)
    } finally { submitting.current = false; setBusy(false) }
  }

  return createPortal(<div className="cloud-dialog-backdrop" data-native-terminal-occluder=""
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialog} className="cloud-dialog cloud-tasks" role="dialog" aria-modal="true"
      aria-labelledby={headingId} aria-describedby={helpId} aria-busy={busy} tabIndex={-1} data-native-terminal-occluder="">
      <header><h2 id={headingId}>{reentryKey ? 'Re-enter original cloud intent' : linking ? 'Link existing cloud task' : 'New cloud task'}</h2>
        <button type="button" aria-label="Close cloud task dialog" onClick={onClose}>×</button></header>
      <form className="cloud-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <fieldset disabled={busy || uncertain} onChange={(event) => {
          if (!(event.target instanceof HTMLInputElement && event.target.type === 'checkbox')) { setConfirmed(false); setRiskConfirmed(false) }
        }}>
          {reentryKey && <>
            <p className="cloud-notice">Recover key <code>{reentryKey}</code>. Re-enter the original kind, target, and request. A matching digest reuses this key only after your confirmation; nothing is sent automatically.</p>
            <label>Original operation<select value={kind} onChange={(event) => { setKind(event.target.value as CloudIntent['kind']); setReentryTarget(''); setMismatch(false) }}>
              <option value="create">Create task</option><option value="link">Link identity</option><option value="message">Send message</option>
            </select></label>
            {kind !== 'create' && <label>Original local task target<select required={messaging} value={reentryTarget} onChange={(event) => setReentryTarget(event.target.value)}>
              <option value="">{messaging ? 'Choose the original task' : 'New tracked identity (no existing local task)'}</option>
              {tasks.map((task) => <option key={task.id} value={task.id}>{cloudTaskConnectionLabel(task, providers?.providers)} · {task.title} · {task.id}</option>)}
            </select></label>}
          </>}
          <label>Connection<select value={selectedConnectionKey} disabled={hasBinding} onChange={(event) => {
            const selected = providers?.providers.find((item) => cloudConnectionKey(item.id, item.credentialContextId) === event.target.value)
            if (!selected) return
            setConnectionChoice({ id: selected.id, credentialContextId: selected.credentialContextId, label: selected.label }); setTarget(''); setConfirmed(false)
          }}>
            {!info && <option value={selectedConnectionKey} disabled>{connectionLabel}</option>}
            {providers?.providers.map((item) => <option key={cloudConnectionKey(item.id, item.credentialContextId)} value={cloudConnectionKey(item.id, item.credentialContextId)}>{item.label}</option>)}
          </select></label>
          <p id={helpId} className="cloud-notice">{info?.readiness ?? 'unverified'}{info?.version ? ` · ${info.version}` : ''} — {reason}</p>
          <p>Connection: {connectionLabel}. Confirmation context: <code>{connection?.credentialContextId ?? 'Unavailable'}</code> · {info?.verifiedAccountRef ?? 'Account identity unverified'}</p>
          {contextChanged && <p role="alert">Provider account/context changed. Review the displayed context and confirm again; the previous confirmation cannot authorize it.</p>}
          <a href={cloudProviderHome(provider)} target="_blank" rel="noopener noreferrer">Open {provider === 'claude' ? 'Claude' : 'Codex'} ↗</a>
          {!messaging && <label>Title (optional)<input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} /></label>}
          {linking ? <>
            <label>Provider task or session ID<input required value={remoteId} maxLength={160}
              placeholder={provider === 'claude' ? 'session_…' : 'task_…'} onChange={(event) => setRemoteId(event.target.value)} /></label>
            <p>Linking records an existing identity; it does not launch work or prove any uncertain message arrived. Identity may be labeled user-supplied.</p>
          </> : messaging ? <>
            <label>Message<textarea required rows={4} value={prompt} maxLength={CLOUD_PROMPT_LIMIT} onChange={(event) => setPrompt(event.target.value)} /></label>
            <p>Original target: {boundTask?.id ?? 'Choose a task'} · {boundTask?.providerTaskId ?? 'No remote ID'}. Linking or session acceptance does not prove this message arrived.</p>
          </> : <>
            <label>{provider === 'codex' ? 'Existing environment ID' : 'Existing checkout path'}<input required value={target} maxLength={provider === 'codex' ? 160 : 1_024} onChange={(event) => setTarget(event.target.value)} /></label>
            <label>Requested branch<input required value={branch} maxLength={240} onChange={(event) => setBranch(event.target.value)} /></label>
            <label>Task prompt<textarea required rows={4} value={prompt} maxLength={CLOUD_PROMPT_LIMIT} onChange={(event) => setPrompt(event.target.value)} /></label>
            <p className="cloud-destination"><strong>Destination: {connectionLabel}</strong><br />{target || 'Choose a source'} · {branch || 'Choose a branch'}</p>
            <p>{provider === 'codex' ? 'Uses your existing provider environment. A moving branch does not verify a remote commit.'
              : 'Requires verified clean, pushed source and an enforceable no-bundle policy; source is revalidated before dispatch.'} No automatic push, apply, or merge.</p>
          </>}
          <label className="cloud-check"><input type="checkbox" required checked={confirmed} disabled={!info} onChange={(event) => setConfirmed(event.target.checked)} />
            I confirm the current CLI account/context and this destination{linking ? ' belong to this task' : ''}.
          </label>
          {!info?.verifiedAccountRef && <p>Official account identity is unverified. This confirmation is a user check, not provider evidence.</p>}
          {((!reentryKey && !linking && uncertainIntents) || mismatch) && <label className="cloud-check cloud-notice"><input type="checkbox" required={!reentryKey} checked={riskConfirmed} onChange={(event) => setRiskConfirmed(event.target.checked)} />
            {mismatch ? 'This changed draft needs a new key. I explicitly authorize a new intent after checking the provider; duplicate remote work or messages are possible.' : 'An earlier intent is unresolved. I checked the provider and want an explicit new intent; duplicate remote work is possible.'}
          </label>}
        </fieldset>
        {error && <p role="alert">{error} {uncertain && 'Close this dialog to recover the saved intent.'}</p>}
        <button className="cloud-primary" type="submit" disabled={!connected || !capability || !confirmed || busy || uncertain
          || (linking ? !validCloudRemoteId(provider, remoteId.trim()) : messaging ? !boundTask || !prompt.trim() : !target.trim() || !branch.trim() || !prompt.trim())
          || (!reentryKey && !linking && uncertainIntents && !riskConfirmed)}>
          {busy ? 'Recording…' : reentryKey ? mismatch && riskConfirmed ? 'Explicitly record new intent' : 'Reconfirm and recover original intent' : linking ? 'Link identity only' : 'Record cloud task'}
        </button>
        <p>Recorded locally is not cloud acceptance. Wait for a provider receipt before closing the laptop expecting hosted execution.</p>
      </form>
    </section>
  </div>, document.body)
}

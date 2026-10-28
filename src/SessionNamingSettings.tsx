import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  MAX_NAMING_TIMEOUT_SECONDS,
  MIN_NAMING_TIMEOUT_SECONDS,
  type NamingModel,
  type NamingModelStatus,
  type SessionNamingResponse,
} from '../shared/session-naming'
import { claudeProfileLabel, type ClaudeProfile, type ModelCatalogs } from '../shared/tmux-create'
import { relativeAge } from './newSessionAgents'
import type { SessionNamingApi } from './sessionNamingApi'

type Option = { key: string; label: string; model: NamingModel }

const optionKey = (model: NamingModel) => `${model.provider}|${model.configDir ?? ''}|${model.model}`

/** Codex models, then each Claude profile's, as their latest chats listed them. */
export function namingModelOptions(catalogs: ModelCatalogs, profiles: readonly ClaudeProfile[], current: NamingModel): Option[] {
  const options: Option[] = (catalogs.codex?.models ?? []).map((model) => ({
    key: optionKey({ provider: 'codex', model: model.value }),
    label: `${model.displayName} · Codex`,
    model: { provider: 'codex', model: model.value },
  }))
  for (const [key, entry] of Object.entries(catalogs)) {
    if (!key.startsWith('claude:')) continue
    const configDir = key.slice('claude:'.length)
    const profile = profiles.find((candidate) => candidate.configDir === configDir)
    const name = profile ? claudeProfileLabel(profile) : configDir.split('/').at(-1)?.replace(/^\./u, '') ?? configDir
    for (const model of entry.models) {
      if (model.value === 'default') continue
      options.push({ key: optionKey({ provider: 'claude', model: model.value, configDir }), label: `${model.displayName} · Claude (${name})`, model: { provider: 'claude', model: model.value, configDir } })
    }
  }
  // The chosen model stays listed even before any chat has shown its provider's list.
  if (!options.some((option) => option.key === optionKey(current))) {
    options.unshift({ key: optionKey(current), label: `${current.model} · ${current.provider === 'codex' ? 'Codex' : 'Claude'}`, model: current })
  }
  return options
}

function statusText(status: NamingModelStatus, now = Date.now()): string {
  switch (status.state) {
    case 'available': return status.lastNamedAt ? `Available · last named a session ${relativeAge(status.lastNamedAt, now)}` : 'Available'
    case 'unavailable': return `Unavailable on this machine since ${new Date(status.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${status.reason}. Using the chat's model until it works again.`
    case 'resting': return `${status.reason}; tried again after ${new Date(status.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Using the chat's model meanwhile.`
  }
}

/** Settings → Session naming: which model names new sessions, and how long the modal waits. */
export function SessionNamingSection({ api, loadModels, profiles }: {
  api: SessionNamingApi
  loadModels: () => Promise<ModelCatalogs>
  profiles: readonly ClaudeProfile[]
}) {
  const [info, setInfo] = useState<SessionNamingResponse>()
  const [catalogs, setCatalogs] = useState<ModelCatalogs>({})
  const [timeout, setTimeoutText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.describe().then((value) => {
      if (cancelled) return
      setInfo(value)
      setTimeoutText(String(value.settings.timeoutSeconds))
    }, (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unable to load session naming') })
    void loadModels().then((value) => { if (!cancelled) setCatalogs(value) }, () => undefined)
    return () => { cancelled = true }
  }, [api, loadModels])

  const run = async (action: () => Promise<SessionNamingResponse>) => {
    setBusy(true)
    setError('')
    try {
      const value = await action()
      setInfo(value)
      setTimeoutText(String(value.settings.timeoutSeconds))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  if (!info) return error ? <section className="settings-section"><p className="settings-error" role="alert">{error}</p></section> : null
  const { settings, status } = info
  const options = namingModelOptions(catalogs, profiles, settings.namingModel)
  const commitTimeout = () => {
    const seconds = Number(timeout)
    if (Number.isInteger(seconds) && seconds >= MIN_NAMING_TIMEOUT_SECONDS && seconds <= MAX_NAMING_TIMEOUT_SECONDS) {
      if (seconds !== settings.timeoutSeconds) void run(() => api.update({ timeoutSeconds: seconds }))
    } else {
      setTimeoutText(String(settings.timeoutSeconds))
    }
  }

  return <section className="settings-section" aria-labelledby="settings-naming">
    <h3 id="settings-naming">Session naming</h3>
    <p className="settings-hint">When you start a chat without a session name, Commando asks a model to name it from your prompt. The name also becomes the branch and worktree folder.</p>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    <ul className="settings-profiles">
      <li className="settings-profile" data-state={status.state === 'available' ? 'logged-in' : 'logged-out'}>
        <div className="settings-profile-main">
          <label className="settings-recent">
            <input type="radio" name="session-naming-mode" checked={settings.mode === 'naming-model'} disabled={busy} onChange={() => void run(() => api.update({ mode: 'naming-model' }))} />
            Use a naming model
          </label>
          <select
            className="settings-naming-model"
            aria-label="Naming model"
            value={optionKey(settings.namingModel)}
            disabled={busy}
            onChange={(event) => {
              const option = options.find((candidate) => candidate.key === event.target.value)
              if (option) void run(() => api.update({ mode: 'naming-model', namingModel: option.model }))
            }}
          >
            {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
          {settings.mode === 'naming-model' ? <span className="settings-profile-status" role="status">{statusText(status)}</span> : null}
        </div>
        {settings.mode === 'naming-model' && status.state !== 'available' ? (
          <div className="settings-profile-controls">
            <button type="button" className="settings-button" disabled={busy} onClick={() => void run(() => api.retry())}><RefreshCw aria-hidden="true" />Try again</button>
          </div>
        ) : null}
      </li>
      <li className="settings-profile">
        <div className="settings-profile-main">
          <label className="settings-recent">
            <input type="radio" name="session-naming-mode" checked={settings.mode === 'chat-model'} disabled={busy} onChange={() => void run(() => api.update({ mode: 'chat-model' }))} />
            Use the model selected for the chat
          </label>
          <span className="settings-profile-status settings-naming-note">Slower and dearer on big models, but needs no extra login.</span>
        </div>
      </li>
    </ul>
    <label className="settings-naming-wait">
      Wait for a name up to
      <input
        type="number"
        aria-label="Seconds to wait for a name"
        min={MIN_NAMING_TIMEOUT_SECONDS}
        max={MAX_NAMING_TIMEOUT_SECONDS}
        value={timeout}
        disabled={busy}
        onChange={(event) => setTimeoutText(event.target.value)}
        onBlur={commitTimeout}
        onKeyDown={(event) => { if (event.key === 'Enter') commitTimeout() }}
      />
      seconds, then use a generated name
    </label>
  </section>
}

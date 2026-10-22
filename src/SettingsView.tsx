import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Bot, LogIn, Plus, RefreshCw } from 'lucide-react'
import { CLAUDE_PROFILE_NAME, type AgentProfilesResponse, type ClaudeLoginStatus, type ClaudeProfileSettings } from '../shared/agent-profiles'
import type { AgentProfilesApi } from './agentProfilesApi'
import './settings-view.css'

/** Home-relative, as profiles live in the home folder. */
function displayPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/u, '~')
}

function statusText(status: ClaudeLoginStatus): string {
  if (status.state === 'logged-out') return 'Not logged in'
  if (status.state === 'unknown') return `Couldn't check${status.error ? `: ${status.error}` : ''}`
  return ['Logged in', status.email ? `as ${status.email}` : '', status.orgName ? `· ${status.orgName}` : '', status.subscriptionType ? `· ${status.subscriptionType}` : ''].filter(Boolean).join(' ')
}

function ClaudeProfileRow({ profile, busy, onChange, onLogin }: {
  profile: ClaudeProfileSettings
  busy: boolean
  onChange: (change: { label?: string | null; hidden?: boolean; isDefault?: boolean }) => void
  onLogin: () => void
}) {
  const [label, setLabel] = useState(profile.label ?? '')
  useEffect(() => setLabel(profile.label ?? ''), [profile.label])
  const save = () => {
    const next = label.trim()
    if (next !== (profile.label ?? '')) onChange({ label: next || null })
  }
  const name = profile.label ?? profile.name
  return <li className="settings-profile" data-state={profile.status.state}>
    <div className="settings-profile-main">
      <input className="settings-profile-label" aria-label={`Label for ${displayPath(profile.configDir)}`} placeholder={profile.name} value={label} disabled={busy} maxLength={64}
        onChange={(event) => setLabel(event.target.value)} onBlur={save}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <code>{displayPath(profile.configDir)}</code>
      <span className="settings-profile-status" role="status">{statusText(profile.status)}</span>
    </div>
    <div className="settings-profile-controls">
      <label><input type="radio" name="claude-default-profile" checked={Boolean(profile.isDefault)} disabled={busy || profile.hidden}
        onChange={() => onChange({ isDefault: true })} /> Default</label>
      <label><input type="checkbox" checked={!profile.hidden} disabled={busy || Boolean(profile.isDefault)}
        onChange={(event) => onChange({ hidden: !event.target.checked })} /> Show in pickers</label>
      <button type="button" className="settings-button" disabled={busy} onClick={onLogin} aria-label={`Log in to ${name}`}>
        <LogIn aria-hidden="true" />{profile.status.state === 'logged-in' ? 'Log in again' : 'Log in'}
      </button>
    </div>
  </li>
}

export type CommanderProfileSetting = {
  /** The profile Commander runs on; undefined is the default login. */
  configDir?: string
  /** Whether a Commander session is open, which switching closes. */
  open: boolean
  onSwitch: (configDir: string | null) => Promise<void>
}

/** Settings > Commander: which Claude profile Commander runs on. */
function CommanderSection({ commander, profiles, busy, run }: {
  commander: CommanderProfileSetting
  profiles: ClaudeProfileSettings[]
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<void>
}) {
  const [choice, setChoice] = useState(commander.configDir ?? '')
  useEffect(() => setChoice(commander.configDir ?? ''), [commander.configDir])
  const chosen = profiles.find((profile) => profile.configDir === choice)
  const name = chosen ? chosen.label ?? chosen.name : 'the default login'
  const current = profiles.find((profile) => profile.configDir === commander.configDir)
  const switchTo = () => {
    const message = commander.open
      ? `Switch Commander to ${name}?\n\nThis closes the current Commander session, and any other panes in it, then starts a new Commander on ${name}. The old conversation stays with its profile.`
      : `Start Commander on ${name}?`
    if (!window.confirm(message)) return
    void run(() => commander.onSwitch(choice || null))
  }
  return <section className="settings-section" aria-labelledby="settings-commander">
    <h3 id="settings-commander">Commander</h3>
    <p className="settings-hint">Commander runs as a Claude chat on this profile. {commander.configDir
      ? <>It is on <strong>{current ? current.label ?? current.name : displayPath(commander.configDir)}</strong>.</>
      : <>It is on the default login (no profile).</>}</p>
    <div className="settings-commander">
      <label>Profile <select aria-label="Commander profile" value={choice} disabled={busy} onChange={(event) => setChoice(event.target.value)}>
        <option value="">Default login (no profile)</option>
        {/* A profile folder that has gone still has to show, or Default could not be chosen. */}
        {commander.configDir && !current ? <option value={commander.configDir} disabled>{displayPath(commander.configDir)} (missing)</option> : null}
        {profiles.map((profile) => <option key={profile.configDir} value={profile.configDir}>
          {profile.label ?? profile.name}{profile.hidden ? ' (hidden)' : ''}{profile.status.state === 'logged-out' ? ' · not logged in' : ''}
        </option>)}
      </select></label>
      <button type="button" className="settings-button" disabled={busy || choice === (commander.configDir ?? '')} onClick={switchTo}>
        <Bot aria-hidden="true" />{commander.open ? 'Switch Commander' : 'Start Commander'}
      </button>
    </div>
    {chosen?.status.state === 'logged-out' ? <p className="settings-hint settings-warning" role="status">{name} isn't logged in, so Commander would fail to reply. Log it in above first.</p> : null}
  </section>
}

/** Settings: Claude profiles to label, default, hide, log in and add; other agents read-only; Commander's profile. */
export function SettingsView({ api, onOpenPane, commander }: {
  api: AgentProfilesApi
  onOpenPane: (paneId: string) => void
  commander?: CommanderProfileSetting
}) {
  const [data, setData] = useState<AgentProfilesResponse>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [newLabel, setNewLabel] = useState('')

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    try { setData(await api.list(refresh)); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load profiles') }
    finally { setLoading(false) }
  }, [api])
  // Settings mounts each time it opens, so a login made meanwhile shows up.
  useEffect(() => { void load() }, [load])

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Something went wrong') }
    finally { setBusy(false) }
  }
  const change = (configDir: string, change: { label?: string | null; hidden?: boolean; isDefault?: boolean }) => {
    // Shown at once; the reload afterwards restores the daemon's view if it refused.
    setData((current) => current && { ...current, claude: current.claude.map((profile) => {
      const next = { ...profile }
      if (profile.configDir === configDir) {
        if (change.label === null) delete next.label
        else if (change.label !== undefined) next.label = change.label
        if (change.hidden !== undefined) next.hidden = change.hidden
        if (change.isDefault !== undefined) next.isDefault = change.isDefault
      } else if (change.isDefault) delete next.isDefault
      return next
    }) })
    return act(async () => {
      try { await api.updateClaude({ configDir, ...change }) } finally { await load() }
    })
  }
  const login = (configDir: string) => act(async () => { onOpenPane((await api.loginClaude(configDir)).created.paneId) })
  const nameValid = CLAUDE_PROFILE_NAME.test(newName)
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!nameValid) return
    void act(async () => {
      await api.addClaude(newName, newLabel.trim() || undefined)
      setNewName('')
      setNewLabel('')
      await load()
    })
  }
  const anyDefault = data?.claude.some((profile) => profile.isDefault)
  const recentDefault = () => {
    const current = data?.claude.find((profile) => profile.isDefault)
    if (current) void change(current.configDir, { isDefault: false })
  }

  return <section className="settings-view" aria-label="Settings">
    <header className="settings-bar">
      <h2>Settings</h2>
      <button type="button" className="settings-button" disabled={loading} onClick={() => void load(true)}><RefreshCw aria-hidden="true" />{loading ? 'Checking…' : 'Check logins'}</button>
    </header>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}

    <section className="settings-section" aria-labelledby="settings-profiles">
      <h3 id="settings-profiles">Claude profiles</h3>
      <p className="settings-hint">Each <code>~/.claude…</code> folder is a separate login. Labels show in every profile picker; the default is offered for new chats until you pick another one for a repository.</p>
      {data ? <>
        <label className="settings-recent"><input type="radio" name="claude-default-profile" checked={!anyDefault} disabled={busy} onChange={recentDefault} /> Default to the most recently used profile</label>
        <ul className="settings-profiles">
          {data.claude.map((profile) => <ClaudeProfileRow key={profile.configDir} profile={profile} busy={busy}
            onChange={(next) => void change(profile.configDir, next)} onLogin={() => void login(profile.configDir)} />)}
        </ul>
      </> : <p className="settings-hint" role="status">{loading ? 'Loading profiles…' : null}</p>}
      <form className="settings-add" onSubmit={add} aria-label="Add a Claude profile">
        <label>Folder <span className="settings-folder"><code>~/.claude</code><input aria-label="Profile folder name" value={newName} placeholder="name" maxLength={32}
          onChange={(event) => setNewName(event.target.value)} aria-invalid={newName !== '' && !nameValid} /></span></label>
        <label>Label <input aria-label="New profile label" value={newLabel} placeholder="Optional" maxLength={64} onChange={(event) => setNewLabel(event.target.value)} /></label>
        <button type="submit" className="settings-button" disabled={busy || !nameValid}><Plus aria-hidden="true" />Add profile</button>
        {newName !== '' && !nameValid ? <span className="settings-hint">Use letters, digits, - or _.</span> : null}
      </form>
    </section>

    {commander && data ? <CommanderSection commander={commander} profiles={data.claude} busy={busy} run={act} /> : null}

    <section className="settings-section" aria-labelledby="settings-other-agents">
      <h3 id="settings-other-agents">Other agents</h3>
      <p className="settings-hint">These agents use a single login each.</p>
      <ul className="settings-profiles">
        {data?.others.map((agent) => <li key={agent.provider} className="settings-profile" data-state={agent.state}>
          <div className="settings-profile-main">
            <strong>{agent.label}</strong>
            <code>{displayPath(agent.configDir)}</code>
            <span className="settings-profile-status" role="status">{agent.detail || (agent.state === 'logged-in' ? 'Logged in' : agent.state === 'logged-out' ? 'Not logged in' : '')}</span>
          </div>
        </li>)}
      </ul>
    </section>
  </section>
}

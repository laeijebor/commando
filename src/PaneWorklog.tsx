import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleDot,
  CloudUpload,
  Copy,
  FileDiff,
  Lightbulb,
  Images,
  GitPullRequest,
  Flag,
  Link,
  Package,
  RotateCcw,
  Tag,
  Ticket,
  MessageSquareText,
  Minus,
  Smartphone,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { AgentProvider, AgentResume, AgentTaskStatus, EarlierAgentSession, SessionBrief, SessionBriefUpdateKind, SessionReference } from '../shared/protocol'
import { SESSION_AGENT_CHOICES } from '../shared/tmux-create'
import { PanePullRequests, usePanePullRequests } from './PanePullRequests'
import type { PrsApiClient } from './prsApi'
import { PaneScreenshots, type OpenPaneScreenshot } from './PaneScreenshots'
import type { PaneManagementApiClient } from './paneManagementApi'
import type { PaneScreenshotsApiClient } from './paneScreenshotsApi'
import type { SimsApiClient } from './simsApi'

const PREFERENCE_PREFIX = 'commando.pane-worklog.'

type WorklogPreferences = {
  minimized: boolean
  tasksCollapsed: boolean
  visibilitySet: boolean
  note: string
  screenshotsCollapsed: boolean
  screenshotsSeenAt: number
}

const MAX_NOTE_LENGTH = 4_000

const markdownComponents: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noreferrer" />
  },
  img() {
    return null
  },
}

function preferenceKey(brief: SessionBrief): string {
  return `${PREFERENCE_PREFIX}${brief.targetId ?? `${brief.sessionId}:${brief.paneId}`}`
}

function storedPreferences(brief: SessionBrief): WorklogPreferences {
  try {
    const value = JSON.parse(window.localStorage.getItem(preferenceKey(brief))
      ?? window.localStorage.getItem(`${PREFERENCE_PREFIX}${brief.sessionId}:${brief.paneId}`) ?? '{}') as Partial<WorklogPreferences>
    const visibilitySet = value.visibilitySet === true
    return {
      minimized: visibilitySet ? value.minimized !== false : true,
      tasksCollapsed: value.tasksCollapsed === true,
      visibilitySet,
      note: typeof value.note === 'string' ? value.note.slice(0, MAX_NOTE_LENGTH) : '',
      screenshotsCollapsed: value.screenshotsCollapsed === true,
      screenshotsSeenAt: typeof value.screenshotsSeenAt === 'number' && Number.isFinite(value.screenshotsSeenAt)
        ? value.screenshotsSeenAt
        : 0,
    }
  } catch {
    return { minimized: true, tasksCollapsed: false, visibilitySet: false, note: '', screenshotsCollapsed: false, screenshotsSeenAt: 0 }
  }
}

function storePreferences(brief: SessionBrief, preferences: WorklogPreferences): void {
  try {
    window.localStorage.setItem(preferenceKey(brief), JSON.stringify(preferences))
    if (brief.targetId) window.localStorage.removeItem(`${PREFERENCE_PREFIX}${brief.sessionId}:${brief.paneId}`)
  } catch {
    // Worklog controls still function in memory when storage is unavailable.
  }
}

function relativeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function updateIcon(kind: SessionBriefUpdateKind): ReactNode {
  switch (kind) {
    case 'changed': return <FileDiff aria-hidden="true" />
    case 'decision': return <Lightbulb aria-hidden="true" />
    case 'check': return <Check aria-hidden="true" />
    case 'blocker': return <CircleAlert aria-hidden="true" />
    case 'note': return <MessageSquareText aria-hidden="true" />
    case 'screenshots': return <Images aria-hidden="true" />
  }
}

function taskIcon(status: AgentTaskStatus): ReactNode {
  switch (status) {
    case 'completed': return <Check aria-hidden="true" />
    case 'in_progress': return <CircleDot aria-hidden="true" />
    case 'cancelled': return <X aria-hidden="true" />
    case 'pending': return <Circle aria-hidden="true" />
  }
}

function referenceIcon(kind: SessionReference['kind']): ReactNode {
  switch (kind) {
    case 'feature_flag': return <Flag aria-hidden="true" />
    case 'url': return <Link aria-hidden="true" />
    case 'issue': return <Ticket aria-hidden="true" />
    case 'deployment': return <CloudUpload aria-hidden="true" />
    case 'build': return <Package aria-hidden="true" />
    case 'release': return <Tag aria-hidden="true" />
    case 'session': return <RotateCcw aria-hidden="true" />
  }
}

function referenceCaption(reference: SessionReference): string {
  switch (reference.kind) {
    case 'feature_flag': return 'Feature flag'
    case 'url': return reference.value
    case 'issue': return `Issue / ticket · ${reference.value}`
    case 'deployment': return `Deployment preview · ${reference.value}`
    case 'build': return reference.url ? `Build · ${reference.url}` : 'Build'
    case 'release': return reference.url ? `Release · ${reference.url}` : 'Release'
    case 'session': return 'Resume session · click to type into the pane'
  }
}

function SessionReferenceRow({
  command,
  connected,
  onTypeCommand,
}: {
  command: string
  connected: boolean
  onTypeCommand?: (command: string) => void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1_500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="pane-worklog-reference pane-worklog-reference-session">
      <button
        type="button"
        className="pane-worklog-reference-main"
        disabled={!connected || !onTypeCommand}
        title="Type this command into the pane (Enter is not pressed)"
        onClick={() => onTypeCommand?.(command)}
      >
        <span className="pane-worklog-reference-icon">{referenceIcon('session')}</span>
        <span><strong>Resume session</strong><small>{command}</small></span>
      </button>
      <button type="button" className="pane-worklog-reference-copy" aria-label="Copy resume command" title="Copy to clipboard" onClick={() => void copy()}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
    </div>
  )
}

function agentLabel(provider: AgentProvider): string {
  return SESSION_AGENT_CHOICES.find((choice) => choice.value === provider)?.label ?? 'agent'
}

function resumeMessage(resume: AgentResume): string {
  const agent = agentLabel(resume.provider)
  switch (resume.state) {
    case 'queued': return `Resuming the ${agent} conversation shortly. tmux restored this pane after a restart.`
    case 'resuming': return `Resuming the ${agent} conversation…`
    case 'resumed': return `Resumed the ${agent} conversation automatically after tmux restarted.`
    case 'failed': return `Couldn't resume the ${agent} conversation. ${resume.error ?? ''}`.trim()
  }
}

/** A conversation that ran earlier in the pane, folded so the current one stays in front. */
function EarlierSession({ session, connected, onTypeCommand }: {
  session: EarlierAgentSession
  connected: boolean
  onTypeCommand?: (command: string) => void
}) {
  const tasks = (session.tasks ?? []).filter((task) => task.status !== 'cancelled')
  const completed = tasks.filter((task) => task.status === 'completed').length
  const resume = session.references?.find((reference) => reference.kind === 'session')
  const terms = session.references?.filter((reference) => reference.kind !== 'session') ?? []
  return (
    <details className="pane-worklog-earlier-session">
      <summary>
        <ChevronRight aria-hidden="true" />
        <span>
          <strong>{session.headline}</strong>
          <small>
            {agentLabel(session.agentSession.provider)} · ended {relativeAge(session.endedAt)}
            {tasks.length ? ` · ${completed}/${tasks.length} tasks` : ''}
          </small>
        </span>
      </summary>
      <div className="pane-worklog-earlier-body">
        {resume ? <SessionReferenceRow command={resume.value} connected={connected} onTypeCommand={onTypeCommand} /> : null}
        {session.recapMarkdown ? (
          <div className="pane-worklog-recap">
            <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>{session.recapMarkdown}</ReactMarkdown>
          </div>
        ) : null}
        {terms.length ? (
          <ul className="pane-worklog-earlier-list">
            {terms.map((reference) => <li key={`${reference.kind}:${reference.value}`}>{reference.label ?? reference.value}<small> · {referenceCaption(reference)}</small></li>)}
          </ul>
        ) : null}
        {tasks.length ? (
          <ul className="pane-worklog-earlier-list">
            {tasks.map((task) => <li key={task.id} className={`is-${task.status}`}>{taskIcon(task.status)}{task.content}</li>)}
          </ul>
        ) : null}
        {session.updates.length ? (
          <ul className="pane-worklog-earlier-list">
            {session.updates.map((update) => <li key={update.id}>{update.text}<small> · {relativeAge(update.createdAt)}</small></li>)}
          </ul>
        ) : null}
        {session.next ? <p className="pane-worklog-earlier-next"><small>Next</small> {session.next}</p> : null}
      </div>
    </details>
  )
}

/** Commando bringing the pane's agent back after a tmux restart, with a retry when it failed. */
function AgentResumeNotice({ resume, connected, onRetry }: { resume: AgentResume; connected: boolean; onRetry?: () => void }) {
  return (
    <div className={`pane-worklog-resume is-${resume.state}`} role="status">
      <span>{resumeMessage(resume)}</span>
      {resume.state === 'failed' && onRetry ? (
        <button type="button" onClick={onRetry} disabled={!connected} title={resume.command}>
          <RotateCcw aria-hidden="true" />
          Retry
        </button>
      ) : null}
    </div>
  )
}

export function PaneWorklog({
  brief,
  paneLabel,
  prsApi,
  screenshotsApi = { list: async () => { throw new Error('Screenshot API unavailable') } },
  paneManagementApi = { revealPaneScreenshot: async () => { throw new Error('Pane management API unavailable') } },
  revealInFinder = true,
  onOpenScreenshot = () => undefined,
  simsApi,
  onShowSimulator,
  onTypeCommand,
  connected = true,
  empty = false,
  hookConnected = true,
  resume,
  onRetryResume,
}: {
  brief: SessionBrief
  paneLabel: string
  prsApi?: Pick<PrsApiClient, 'pane'>
  screenshotsApi?: PaneScreenshotsApiClient
  paneManagementApi?: Pick<PaneManagementApiClient, 'revealPaneScreenshot'>
  revealInFinder?: boolean
  onOpenScreenshot?: OpenPaneScreenshot
  simsApi?: Pick<SimsApiClient, 'open'>
  onShowSimulator?: (udid: string) => void
  /** Types text into the pane's terminal without pressing Enter. */
  onTypeCommand?: (command: string) => void
  connected?: boolean
  empty?: boolean
  hookConnected?: boolean
  resume?: AgentResume
  /** Asks the daemon to resume the agent again after a failed attempt. */
  onRetryResume?: () => void
}) {
  const [preferences, setPreferences] = useState(() => storedPreferences(brief))
  const displayState = !hookConnected && !empty ? 'stale' : brief.state
  const [simPending, setSimPending] = useState(false)
  const [simError, setSimError] = useState('')
  const [compact, setCompact] = useState(false)
  const [following, setFollowing] = useState(true)
  const [unread, setUnread] = useState(0)
  const activityRef = useRef<HTMLDivElement>(null)
  const previousUpdateCount = useRef(brief.updates.length)
  const fetchedPrList = usePanePullRequests(
    brief.paneId,
    prsApi ?? { pane: async () => { throw new Error('PR API unavailable') } },
    Boolean(prsApi && connected),
    preferences.minimized || compact,
  )
  const prList = !brief.targetId || fetchedPrList?.targetId === brief.targetId ? fetchedPrList : null
  const hasOpenPr = Boolean(prList?.pullRequests.some((pullRequest) => pullRequest.state === 'open'))
  const screenshotFolders = brief.screenshots ?? []
  const unseenScreenshots = screenshotFolders.reduce((count, folder) => (
    count + (() => {
      const previewCount = folder.preview.filter((file) => file.modifiedAt > preferences.screenshotsSeenAt).length
      return previewCount === folder.preview.length && folder.imageCount > folder.preview.length
        ? folder.imageCount
        : previewCount
    })()
  ), 0)
  const simulator = brief.simulator
  const tasks = brief.tasks ?? []
  const activeTasks = tasks.filter((task) => task.status !== 'cancelled')
  const completedTasks = activeTasks.filter((task) => task.status === 'completed').length
  const progress = activeTasks.length ? Math.round((completedTasks / activeTasks.length) * 100) : 0
  const scrollToStart = (behavior?: ScrollBehavior) => {
    const node = activityRef.current
    if (!node) return
    if (typeof node.scrollTo === 'function') node.scrollTo({ top: 0, behavior })
    else node.scrollTop = 0
  }

  // A different conversation brings a different update list, so its length says nothing about new updates.
  useEffect(() => {
    setPreferences(storedPreferences(brief))
    setFollowing(true)
    setUnread(0)
    previousUpdateCount.current = brief.updates.length
  }, [brief.targetId ?? `${brief.sessionId}:${brief.paneId}`, brief.agentSession?.provider, brief.agentSession?.id])

  useEffect(() => {
    const node = activityRef.current?.closest('.terminal-pane-body')
    if (!node || typeof ResizeObserver === 'undefined') return
    const update = () => setCompact(node.getBoundingClientRect().width < 420)
    const observer = new ResizeObserver(update)
    observer.observe(node)
    update()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    storePreferences(brief, preferences)
  }, [brief, preferences])

  useEffect(() => {
    const added = Math.max(0, brief.updates.length - previousUpdateCount.current)
    previousUpdateCount.current = brief.updates.length
    if (!added) return
    if (following && !preferences.minimized && !compact) {
      window.requestAnimationFrame(() => scrollToStart())
    } else {
      setUnread((current) => current + added)
    }
  }, [brief.updates.length, compact, following, preferences.minimized])

  useEffect(() => {
    if (preferences.minimized || compact) return
    window.requestAnimationFrame(() => scrollToStart())
  }, [compact, preferences.minimized])

  const setMinimized = (minimized: boolean) => {
    setPreferences((current) => ({ ...current, minimized, visibilitySet: true }))
    if (!minimized) {
      setFollowing(true)
      setUnread(0)
    }
  }
  const markScreenshotsSeen = useCallback((timestamp: number) => {
    setPreferences((current) => current.screenshotsSeenAt >= timestamp ? current : { ...current, screenshotsSeenAt: timestamp })
  }, [])

  if (preferences.minimized || compact) {
    return (
      <aside className={`pane-worklog is-minimized state-${displayState}`} aria-label={`Minimized worklog for ${paneLabel}`}>
        <button
          type="button"
          className="pane-worklog-restore"
          onClick={() => { if (!compact) setMinimized(false) }}
          disabled={compact}
          aria-label={compact ? `Worklog for ${paneLabel} is compact while the pane is narrow` : `Expand worklog for ${paneLabel}`}
          title={`${brief.headline}${compact ? ' · Expand the pane to open the worklog' : ''}${unread ? ` · ${unread} new` : ''}`}
        >
          <ChevronLeft aria-hidden="true" />
          <span className={`pane-worklog-state ${displayState}`} aria-hidden="true" />
          {resume && resume.state !== 'resumed' ? (
            <span className={`pane-worklog-resume-indicator is-${resume.state}`} title={resumeMessage(resume)} aria-label={resumeMessage(resume)}>
              <RotateCcw aria-hidden="true" />
            </span>
          ) : null}
          {preferences.note.trim() ? (
            <span className="pane-worklog-note-indicator" title="Personal note saved" aria-label="Personal note saved">
              <MessageSquareText aria-hidden="true" />
            </span>
          ) : null}
          {hasOpenPr ? (
            <span className="pane-worklog-pr-indicator" title="Open pull request" aria-label="Open pull request">
              <GitPullRequest aria-hidden="true" />
            </span>
          ) : null}
          {screenshotFolders.length ? (
            <span className="pane-worklog-screenshot-indicator" title={`${unseenScreenshots} unseen screenshots`} aria-label={`${unseenScreenshots} unseen screenshots`}>
              <Images aria-hidden="true" />
              {unseenScreenshots ? <i>{unseenScreenshots}</i> : null}
            </span>
          ) : null}
          <strong>{completedTasks}/{activeTasks.length}</strong>
          {unread ? <small>{unread}</small> : null}
        </button>
      </aside>
    )
  }

  return (
    <aside className={`pane-worklog state-${displayState}`} aria-label={`Worklog for ${paneLabel}`}>
      <header className="pane-worklog-header">
        <span className={`pane-worklog-state ${displayState}`} aria-hidden="true" />
        <span className="pane-worklog-heading">
          <strong>{brief.headline}</strong>
          <small>{empty ? 'Notes, important terms, pull requests and tasks' : `Worklog · ${relativeAge(brief.updatedAt)}`}</small>
        </span>
        <button type="button" onClick={() => setMinimized(true)} aria-label={`Minimize worklog for ${paneLabel}`} title="Minimize worklog">
          <ChevronRight aria-hidden="true" />
        </button>
      </header>

      <div className="pane-worklog-scroll" ref={activityRef} onScroll={(event) => {
        const node = event.currentTarget
        const atStart = node.scrollTop < 12
        setFollowing(atStart)
        if (atStart) setUnread(0)
      }}>
        {resume ? <AgentResumeNotice resume={resume} connected={connected} onRetry={onRetryResume} /> : null}
        {(!hookConnected || empty) && !(resume && resume.state !== 'failed') ? (
          <div className="pane-worklog-recap" role="status">
            {!connected ? 'Disconnected from Commando. Saved notes and history remain available.'
              : !hookConnected && !empty ? 'Saved worklog restored. No agent is connected yet; resume the agent to continue receiving tasks and activity.'
                : !hookConnected ? <>No agent hook data received for this pane. Notes and linked PRs still work. For automatic tasks and activity, run <code>npm run hooks:install</code> in Commando, then restart the agent when convenient.</>
                : 'Agent connected. Tasks and activity will appear when work begins.'}
            {empty ? <p>Publish screenshot folders with <code>commando-session-update.mjs --screenshots /absolute/path</code>.</p> : null}
          </div>
        ) : null}
        {brief.recapMarkdown ? (
          <div className="pane-worklog-recap">
            <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
              {brief.recapMarkdown}
            </ReactMarkdown>
          </div>
        ) : null}

        <section className="pane-worklog-note" aria-label={`Personal notes for ${paneLabel}`}>
          <header><strong>My notes</strong><small>Saved locally</small></header>
          <textarea
            value={preferences.note}
            maxLength={MAX_NOTE_LENGTH}
            placeholder="Add a note for this pane..."
            aria-label={`Note for ${paneLabel}`}
            onChange={(event) => setPreferences((current) => ({ ...current, note: event.target.value }))}
          />
        </section>

        {(brief.references?.length || simulator) ? (
          <section className="pane-worklog-references" aria-label={`Important terms for ${paneLabel}`}>
            <header><strong>Important terms</strong><small>{(brief.references?.length ?? 0) + (simulator ? 1 : 0)}</small></header>
            <div className="pane-worklog-reference-list">
              {simulator ? (
                <div className="pane-worklog-reference pane-worklog-simulator">
                  <span className="pane-worklog-reference-icon"><Smartphone aria-hidden="true" /></span>
                  <div>
                    <strong title={simulator.task || simulator.sessionName}>{simulator.task || simulator.sessionName}</strong>
                    <small title={simulator.originalName}>{simulator.originalName}</small>
                    <div className="pane-worklog-simulator-chips">
                      {simulator.branch !== undefined ? <small>{simulator.branch}</small> : null}
                      {simulator.ports.map((port) => <small key={port.name}>{port.name} :{port.port}</small>)}
                      {simulator.idle ? <small>idle</small> : null}
                    </div>
                    <div className="pane-worklog-simulator-actions">
                      <button type="button" disabled={!connected || !simsApi || simPending} onClick={async () => {
                        setSimPending(true)
                        setSimError('')
                        try {
                          const result = await simsApi?.open(simulator.udid)
                          if (result?.raised === false) setSimError(result.reason || 'Simulator activated, but could not raise the device window.')
                        }
                        catch (error) { setSimError(error instanceof Error ? error.message : 'Unable to open Simulator') }
                        finally { setSimPending(false) }
                      }}>Open Simulator</button>
                      <button type="button" disabled={!connected || !onShowSimulator} onClick={() => onShowSimulator?.(simulator.udid)}>Show beside pane</button>
                    </div>
                    {simError ? <small role="alert">{simError}</small> : null}
                  </div>
                </div>
              ) : null}
              {brief.references?.map((reference) => {
                if (reference.kind === 'session') {
                  return <SessionReferenceRow key={`${reference.kind}:${reference.value}`} command={reference.value} connected={connected} onTypeCommand={onTypeCommand} />
                }
                const href = reference.kind === 'url' || reference.kind === 'issue' || reference.kind === 'deployment'
                  ? reference.value : reference.url
                const content = <>
                  <span className="pane-worklog-reference-icon">{referenceIcon(reference.kind)}</span>
                  <span><strong>{reference.label ?? reference.value}</strong><small>{referenceCaption(reference)}</small></span>
                </>
                return href ? (
                  <a className="pane-worklog-reference" href={href} target="_blank" rel="noreferrer" key={`${reference.kind}:${reference.value}`} title={href}>{content}</a>
                ) : (
                  <div className="pane-worklog-reference" key={`${reference.kind}:${reference.value}`}>{content}</div>
                )
              })}
            </div>
          </section>
        ) : null}

        {tasks.length ? (
          <section className="pane-worklog-plan" aria-label={`Plan for ${paneLabel}`}>
            <button
              type="button"
              className="pane-worklog-section-toggle"
              onClick={() => setPreferences((current) => ({ ...current, tasksCollapsed: !current.tasksCollapsed }))}
              aria-expanded={!preferences.tasksCollapsed}
              aria-label={`${preferences.tasksCollapsed ? 'Expand' : 'Collapse'} plan for ${paneLabel}`}
            >
              <span><strong>Plan</strong><small>{completedTasks}/{activeTasks.length}</small></span>
              {preferences.tasksCollapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </button>
            <div className="pane-worklog-progress" aria-label={`${completedTasks} of ${activeTasks.length} tasks completed`}>
              <i style={{ width: `${progress}%` }} />
            </div>
            {!preferences.tasksCollapsed ? (
              <div className="pane-worklog-tasks">
                {tasks.map((task) => (
                  <div className={`pane-worklog-task is-${task.status} priority-${task.priority}`} key={task.id}>
                    <span>{taskIcon(task.status)}</span>
                    <strong>{task.content}</strong>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {prsApi ? <PanePullRequests paneId={brief.paneId} api={prsApi} connected={connected} list={prList} /> : null}

        {screenshotFolders.length ? (
          <PaneScreenshots
            paneId={brief.paneId}
            folders={screenshotFolders}
            collapsed={preferences.screenshotsCollapsed}
            seenAt={preferences.screenshotsSeenAt}
            screenshotsApi={screenshotsApi}
            paneManagementApi={paneManagementApi}
            revealInFinder={revealInFinder}
            onCollapsedChange={(screenshotsCollapsed) => setPreferences((current) => ({ ...current, screenshotsCollapsed }))}
            onSeen={markScreenshotsSeen}
            onOpen={onOpenScreenshot}
          />
        ) : null}

        {brief.updates.length ? (
          <section className="pane-worklog-activity" aria-label={`Activity for ${paneLabel}`}>
            <header><strong>Activity</strong><small>{brief.updates.length}</small></header>
            <div className="pane-worklog-timeline">
              {brief.updates.map((update) => {
                const folder = update.screenshotFolderId
                  ? screenshotFolders.find((candidate) => candidate.id === update.screenshotFolderId)
                  : undefined
                return (
                  <article
                    className={`pane-worklog-event kind-${update.kind}${update.author === 'user' ? ' is-user' : ''}`}
                    role={folder ? 'button' : undefined}
                    tabIndex={folder ? 0 : undefined}
                    onClick={folder ? (event) => onOpenScreenshot(folder, undefined, event.currentTarget) : undefined}
                    onKeyDown={folder ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.currentTarget.click()
                      }
                    } : undefined}
                    key={update.id}
                  >
                    <span className="pane-worklog-event-icon">{updateIcon(update.kind)}</span>
                    <div>
                      <strong>{update.text}</strong>
                      {update.detail ? <p>{update.detail}</p> : null}
                      <small>{update.author === 'user' ? 'You' : update.source === 'agent' ? 'Agent update' : 'Lifecycle'} · {relativeAge(update.createdAt)}</small>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ) : null}

        {brief.next ? (
          <div className="pane-worklog-next">
            <ArrowMarker />
            <span><small>Next</small><strong>{brief.next}</strong></span>
          </div>
        ) : null}

        {brief.earlierSessions?.length ? (
          <section className="pane-worklog-earlier" aria-label={`Earlier sessions for ${paneLabel}`}>
            <header><strong>Earlier sessions</strong><small>{brief.earlierSessions.length}</small></header>
            {brief.earlierSessions.map((session) => (
              <EarlierSession
                key={`${session.agentSession.provider}:${session.agentSession.id}`}
                session={session}
                connected={connected}
                onTypeCommand={onTypeCommand}
              />
            ))}
          </section>
        ) : null}
      </div>

      {!following || unread ? (
        <button type="button" className="pane-worklog-follow" onClick={() => {
          scrollToStart('smooth')
          setFollowing(true)
          setUnread(0)
        }}>
          <ChevronUp aria-hidden="true" />{unread ? `${unread} new` : 'Follow live'}
        </button>
      ) : null}
    </aside>
  )
}

function ArrowMarker() {
  return <Minus aria-hidden="true" />
}

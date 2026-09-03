import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleDot,
  FileDiff,
  Lightbulb,
  Images,
  GitPullRequest,
  MessageSquareText,
  Minus,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { AgentTaskStatus, SessionBrief, SessionBriefUpdateKind } from '../shared/protocol'
import { PanePullRequests, usePanePullRequests } from './PanePullRequests'
import type { PrsApiClient } from './prsApi'
import { PaneScreenshots, type OpenPaneScreenshot } from './PaneScreenshots'
import type { PaneManagementApiClient } from './paneManagementApi'
import type { PaneScreenshotsApiClient } from './paneScreenshotsApi'

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
  return `${PREFERENCE_PREFIX}${brief.sessionId}:${brief.paneId}`
}

function storedPreferences(brief: SessionBrief): WorklogPreferences {
  try {
    const value = JSON.parse(window.localStorage.getItem(preferenceKey(brief)) ?? '{}') as Partial<WorklogPreferences>
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

export function PaneWorklog({
  brief,
  paneLabel,
  prsApi,
  screenshotsApi = { list: async () => { throw new Error('Screenshot API unavailable') } },
  paneManagementApi = { revealPaneScreenshot: async () => { throw new Error('Pane management API unavailable') } },
  onOpenScreenshot = () => undefined,
  connected = true,
}: {
  brief: SessionBrief
  paneLabel: string
  prsApi?: Pick<PrsApiClient, 'pane'>
  screenshotsApi?: PaneScreenshotsApiClient
  paneManagementApi?: Pick<PaneManagementApiClient, 'revealPaneScreenshot'>
  onOpenScreenshot?: OpenPaneScreenshot
  connected?: boolean
}) {
  const [preferences, setPreferences] = useState(() => storedPreferences(brief))
  const [compact, setCompact] = useState(false)
  const [following, setFollowing] = useState(true)
  const [unread, setUnread] = useState(0)
  const activityRef = useRef<HTMLDivElement>(null)
  const previousUpdateCount = useRef(brief.updates.length)
  const prList = usePanePullRequests(brief.paneId, prsApi ?? { pane: async () => { throw new Error('PR API unavailable') } }, Boolean(prsApi && connected))
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

  useEffect(() => {
    setPreferences(storedPreferences(brief))
    setFollowing(true)
    setUnread(0)
    previousUpdateCount.current = brief.updates.length
  }, [brief.paneId, brief.sessionId])

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
      <aside className={`pane-worklog is-minimized state-${brief.state}`} aria-label={`Minimized worklog for ${paneLabel}`}>
        <button
          type="button"
          className="pane-worklog-restore"
          onClick={() => { if (!compact) setMinimized(false) }}
          disabled={compact}
          aria-label={compact ? `Worklog for ${paneLabel} is compact while the pane is narrow` : `Expand worklog for ${paneLabel}`}
          title={`${brief.headline}${compact ? ' · Expand the pane to open the worklog' : ''}${unread ? ` · ${unread} new` : ''}`}
        >
          <ChevronLeft aria-hidden="true" />
          <span className={`pane-worklog-state ${brief.state}`} aria-hidden="true" />
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
    <aside className={`pane-worklog state-${brief.state}`} aria-label={`Worklog for ${paneLabel}`}>
      <header className="pane-worklog-header">
        <span className={`pane-worklog-state ${brief.state}`} aria-hidden="true" />
        <span className="pane-worklog-heading">
          <strong>{brief.headline}</strong>
          <small>Worklog · {relativeAge(brief.updatedAt)}</small>
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
            onCollapsedChange={(screenshotsCollapsed) => setPreferences((current) => ({ ...current, screenshotsCollapsed }))}
            onSeen={markScreenshotsSeen}
            onOpen={onOpenScreenshot}
          />
        ) : null}

        {brief.updates.length ? (
          <section className="pane-worklog-activity" aria-label={`Activity for ${paneLabel}`}>
            <header><strong>Activity</strong><small>{brief.updates.length}</small></header>
            <div className="pane-worklog-timeline">
              {brief.updates.map((update) => (
                <article
                  className={`pane-worklog-event kind-${update.kind}${update.author === 'user' ? ' is-user' : ''}`}
                  role={update.kind === 'screenshots' ? 'button' : undefined}
                  tabIndex={update.kind === 'screenshots' ? 0 : undefined}
                  onClick={(event) => {
                    if (update.kind !== 'screenshots') return
                    const folder = screenshotFolders.find((candidate) => (
                      candidate.dir === update.detail ||
                      (update.detail?.startsWith('~/') && candidate.dir.endsWith(update.detail.slice(1))) ||
                      update.text.startsWith(`Published ${candidate.topic} ·`)
                    ))
                    if (folder) onOpenScreenshot(folder, undefined, event.currentTarget)
                  }}
                  onKeyDown={(event) => {
                    if (update.kind === 'screenshots' && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault()
                      event.currentTarget.click()
                    }
                  }}
                  key={update.id}
                >
                  <span className="pane-worklog-event-icon">{updateIcon(update.kind)}</span>
                  <div>
                    <strong>{update.text}</strong>
                    {update.detail ? <p>{update.detail}</p> : null}
                    <small>{update.author === 'user' ? 'You' : update.source === 'agent' ? 'Agent update' : 'Lifecycle'} · {relativeAge(update.createdAt)}</small>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {brief.next ? (
          <div className="pane-worklog-next">
            <ArrowMarker />
            <span><small>Next</small><strong>{brief.next}</strong></span>
          </div>
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

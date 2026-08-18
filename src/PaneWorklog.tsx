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
  MessageSquareText,
  Minus,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { AgentTaskStatus, SessionBrief, SessionBriefUpdateKind } from '../shared/protocol'

const PREFERENCE_PREFIX = 'commando.pane-worklog.'

type WorklogPreferences = {
  minimized: boolean
  tasksCollapsed: boolean
  visibilitySet: boolean
}

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
    }
  } catch {
    return { minimized: true, tasksCollapsed: false, visibilitySet: false }
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

export function PaneWorklog({ brief, paneLabel }: { brief: SessionBrief; paneLabel: string }) {
  const [preferences, setPreferences] = useState(() => storedPreferences(brief))
  const [compact, setCompact] = useState(false)
  const [following, setFollowing] = useState(true)
  const [unread, setUnread] = useState(0)
  const activityRef = useRef<HTMLDivElement>(null)
  const previousUpdateCount = useRef(brief.updates.length)
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

        {brief.updates.length ? (
          <section className="pane-worklog-activity" aria-label={`Activity for ${paneLabel}`}>
            <header><strong>Activity</strong><small>{brief.updates.length}</small></header>
            <div className="pane-worklog-timeline">
              {brief.updates.map((update) => (
                <article className={`pane-worklog-event kind-${update.kind}${update.author === 'user' ? ' is-user' : ''}`} key={update.id}>
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

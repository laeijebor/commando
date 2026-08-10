import {
  ArrowRight,
  Check,
  ChevronUp,
  CircleAlert,
  FileDiff,
  Lightbulb,
  MessageSquareText,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { SessionBrief, SessionBriefUpdateKind } from '../shared/protocol'

const markdownComponents: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noreferrer" />
  },
  img() {
    return null
  },
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

function relativeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function SessionUpdateCapsule({
  brief,
  paneLabel,
  onSelectPane,
}: {
  brief: SessionBrief
  paneLabel: string
  onSelectPane: (paneId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => setExpanded(false), [brief.paneId])

  useEffect(() => {
    if (!expanded) return
    const closeOnPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setExpanded(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('mousedown', closeOnPointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnPointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [expanded])

  return (
    <div className="session-update" ref={rootRef}>
      <button
        type="button"
        className="session-update-trigger"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={`pane-brief-${brief.paneId.slice(1)}`}
        aria-label={`${expanded ? 'Close' : 'Open'} updates for ${paneLabel}`}
        title={`${paneLabel}: ${brief.headline}`}
      >
        <span className={`session-update-state ${brief.state}`} aria-hidden="true" />
        <strong>{paneLabel}</strong>
        <span className="session-update-headline">{brief.headline}</span>
        <span className="session-update-count">{brief.updates.length}</span>
        <ChevronUp aria-hidden="true" />
      </button>
      {expanded ? (
        <section
          className="session-update-sheet"
          id={`pane-brief-${brief.paneId.slice(1)}`}
          aria-label={`Updates for ${paneLabel}`}
          data-native-terminal-occluder=""
        >
          <header>
            <div>
              <span>Pane brief</span>
              <strong>{paneLabel}</strong>
            </div>
            <span className="session-update-age">{relativeAge(brief.updatedAt)}</span>
            <button type="button" onClick={() => setExpanded(false)} aria-label="Close pane updates">
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="session-update-summary">
            <span className={`session-update-state ${brief.state}`} aria-hidden="true" />
            <strong>{brief.headline}</strong>
          </div>
          {brief.recapMarkdown ? (
            <div className="session-update-markdown">
              <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
                {brief.recapMarkdown}
              </ReactMarkdown>
            </div>
          ) : null}
          {brief.updates.length ? (
            <div className="session-update-list" aria-label="Recent pane milestones">
              {brief.updates.map((update) => (
                <button
                  type="button"
                  className={`session-update-row kind-${update.kind}`}
                  onClick={() => {
                    setExpanded(false)
                    onSelectPane(update.paneId)
                  }}
                  title={`Go to pane ${update.paneId}`}
                  key={update.id}
                >
                  <span className="session-update-icon">{updateIcon(update.kind)}</span>
                  <span className="session-update-copy">
                    <strong>{update.text}</strong>
                    {update.detail ? <small>{update.detail}</small> : null}
                  </span>
                  <code>{update.paneId}</code>
                </button>
              ))}
            </div>
          ) : null}
          {brief.next ? (
            <div className="session-update-next">
              <ArrowRight aria-hidden="true" />
              <span><small>Next</small><strong>{brief.next}</strong></span>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

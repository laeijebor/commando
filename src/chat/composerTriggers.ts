import { useCallback, useRef, useState } from 'react'
import type { ComposerTrigger } from '../../shared/chat-composer'

// The `#` menu and the trigger state, after t3code's useComposerTriggerState.ts (MIT).
// Trigger detection lives in shared/chat-composer.ts, which the phone uses too.

export interface PullRequestOption {
  number: number
  title: string
  url: string
  isDraft?: boolean
  author?: string | null
}

/** A `#` pick: the PR as a Markdown link, so both the number and the title reach Claude. */
export function pullRequestText(pr: PullRequestOption): string {
  const title = pr.title.replace(/[[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
  return `[#${pr.number} ${title}](${pr.url}) `
}

export function filterPullRequests(prs: readonly PullRequestOption[], rawQuery: string, limit = 30): PullRequestOption[] {
  const query = rawQuery.toLowerCase()
  if (!query) return prs.slice(0, limit)
  return prs
    .filter((pr) => String(pr.number).startsWith(query) || pr.title.toLowerCase().includes(query))
    .sort((a, b) => Number(!String(a.number).startsWith(query)) - Number(!String(b.number).startsWith(query)) || b.number - a.number)
    .slice(0, limit)
}

/** Keeps a dismissed menu closed until the caret leaves its token (t3code's useComposerTriggerState). */
export function useTriggerState() {
  const [trigger, setActive] = useState<ComposerTrigger | null>(null)
  const dismissed = useRef<ComposerTrigger | null>(null)

  const update = useCallback((candidate: ComposerTrigger | null) => {
    const blocked = candidate && dismissed.current
      && candidate.kind === dismissed.current.kind && candidate.rangeStart === dismissed.current.rangeStart
    if (!blocked) dismissed.current = null
    setActive(blocked ? null : candidate)
  }, [])

  const dismiss = useCallback((candidate: ComposerTrigger | null) => {
    dismissed.current = candidate
    setActive(null)
  }, [])

  return { trigger, update, dismiss }
}

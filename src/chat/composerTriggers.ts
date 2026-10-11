import { useCallback, useRef, useState } from 'react'
import type { ChatCommand, ChatFileEntry } from '../../shared/agent-chat'

// Composer triggers, after t3code's composer-logic.ts (detectComposerTrigger,
// replaceTextRange) and useComposerTriggerState.ts (MIT).

export type ComposerTriggerKind = 'slash' | 'mention' | 'pr'

export interface ComposerTrigger {
  kind: ComposerTriggerKind
  /** What follows the `/`, `@` or `#`. */
  query: string
  rangeStart: number
  rangeEnd: number
  /** Only whitespace comes before it: a command here runs, mid-message it doesn't. */
  atStart: boolean
}

const SLASH_TOKEN = /^\/([\w:.@-]*)$/
const PR_TOKEN = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r'
}

function tokenStart(text: string, cursor: number): number {
  let index = cursor - 1
  while (index >= 0 && !isWhitespace(text[index])) index -= 1
  return index + 1
}

/**
 * The trigger the caret sits in, if any. Unlike t3code's start-of-line `/`,
 * a `/` opens the menu after any whitespace, as in the Claude Code TUI.
 */
export function detectTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = Math.max(0, Math.min(text.length, Math.floor(cursorInput)))
  const start = tokenStart(text, cursor)
  const token = text.slice(start, cursor)
  const atStart = text.slice(0, start).trim() === ''
  const at = (kind: ComposerTriggerKind, query: string): ComposerTrigger => ({ kind, query, rangeStart: start, rangeEnd: cursor, atStart })
  const slash = SLASH_TOKEN.exec(token)
  if (slash) return at('slash', slash[1] ?? '')
  const pr = PR_TOKEN.exec(token)
  if (pr) return at('pr', pr[1] ?? '')
  if (token.startsWith('@') && !token.startsWith('@"')) return at('mention', token.slice(1))
  return null
}

/** Replaces `[rangeStart, rangeEnd)`, swallowing a space the replacement already ends with. */
export function replaceRange(text: string, rangeStart: number, rangeEnd: number, replacement: string): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(text.length, rangeStart))
  let end = Math.max(start, Math.min(text.length, rangeEnd))
  if (replacement.endsWith(' ') && text[end] === ' ') end += 1
  return { text: `${text.slice(0, start)}${replacement}${text.slice(end)}`, cursor: start + replacement.length }
}

/**
 * Moves a start-only command picked mid-message to the front, the rest of
 * the message becoming its arguments: `keep the API notes /comp` becomes
 * `/compact keep the API notes`.
 */
export function moveCommandToStart(text: string, trigger: ComposerTrigger, name: string): { text: string; cursor: number } {
  const rest = `${text.slice(0, trigger.rangeStart)}${text.slice(trigger.rangeEnd)}`.replace(/\s+/g, ' ').trim()
  const head = `/${name} `
  return { text: `${head}${rest}`, cursor: head.length + rest.length }
}

/** Ranks `/` entries: name prefix, then alias prefix, then (from three letters) name, then description. */
export function filterCommands(commands: readonly ChatCommand[], rawQuery: string, limit = 60): ChatCommand[] {
  const query = rawQuery.toLowerCase()
  if (!query) return commands.slice(0, limit)
  const scored = commands.flatMap((command) => {
    const name = command.name.toLowerCase()
    // Plugin entries (`codex:review`) also match on the part after the colon.
    const short = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
    const score = name.startsWith(query) ? 0
      : short.startsWith(query) ? 1
        : command.aliases?.some((alias) => alias.toLowerCase().startsWith(query)) ? 2
          // Two letters match too much of a long list mid-word; wait for a third.
          : query.length >= 3 && name.includes(query) ? 3
            : query.length >= 3 && command.description.toLowerCase().includes(query) ? 4
              : -1
    return score < 0 ? [] : [{ command, score }]
  })
  return scored
    .sort((a, b) => a.score - b.score || a.command.name.length - b.command.name.length || a.command.name.localeCompare(b.command.name))
    .slice(0, limit)
    .map(({ command }) => command)
}

/** `@path`, quoted when the path has spaces so Claude Code reads it whole. */
export function mentionText(entry: ChatFileEntry): string {
  return /\s/.test(entry.path) ? `@"${entry.path}" ` : `@${entry.path} `
}

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

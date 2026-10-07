import { useMemo, type ReactNode } from 'react'
import { parseAnsi, type AnsiSegment } from './ansi'
import './ansi.css'

type TextMatch = { start: number; end: number }

export function findTextMatches(text: string, query: string): TextMatch[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const haystack = text.toLowerCase()
  const matches: TextMatch[] = []
  let cursor = 0
  while (cursor <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, cursor)
    if (start < 0) break
    matches.push({ start, end: start + needle.length })
    cursor = start + needle.length
  }
  return matches
}

function segmentClassName(segment: AnsiSegment): string | undefined {
  const classes: string[] = []
  if (typeof segment.foreground === 'number') classes.push(`ansi-fg-${segment.foreground}`)
  if (typeof segment.background === 'number') classes.push(`ansi-bg-${segment.background}`)
  if (segment.bold) classes.push('ansi-bold')
  if (segment.dim) classes.push('ansi-dim')
  if (segment.italic) classes.push('ansi-italic')
  if (segment.underline) classes.push('ansi-underline')
  return classes.length ? classes.join(' ') : undefined
}

export function AnsiText({ text, query = '', activeMatch = 0 }: {
  text: string
  query?: string
  activeMatch?: number
}) {
  const segments = useMemo(() => parseAnsi(text), [text])
  const matches = useMemo(
    () => findTextMatches(segments.map((segment) => segment.text).join(''), query),
    [segments, query],
  )
  let offset = 0
  let firstMatch = 0
  return (
    <>
      {segments.map((segment, index) => {
        const start = offset
        const end = start + segment.text.length
        offset = end
        while (matches[firstMatch]?.end <= start) firstMatch += 1
        const overlapping: Array<{ match: TextMatch; matchIndex: number }> = []
        for (let matchIndex = firstMatch; matchIndex < matches.length; matchIndex += 1) {
          const match = matches[matchIndex]
          if (match.start >= end) break
          overlapping.push({ match, matchIndex })
        }
        let cursor = start
        const content: ReactNode[] = []
        for (const { match, matchIndex } of overlapping) {
          const overlapStart = Math.max(start, match.start)
          const overlapEnd = Math.min(end, match.end)
          if (overlapStart > cursor) {
            content.push(segment.text.slice(cursor - start, overlapStart - start))
          }
          content.push(
            <mark
              className={`git-diff-search-match${matchIndex === activeMatch ? ' active' : ''}`}
              data-diff-search-match={match.start >= start && match.start < end ? matchIndex : undefined}
              key={`${index}-${matchIndex}`}
            >
              {segment.text.slice(overlapStart - start, overlapEnd - start)}
            </mark>,
          )
          cursor = overlapEnd
        }
        if (cursor < end) content.push(segment.text.slice(cursor - start))
        return (
          <span key={index} className={segmentClassName(segment)} style={{
            ...(typeof segment.foreground === 'string' ? { color: segment.foreground } : {}),
            ...(typeof segment.background === 'string' ? { backgroundColor: segment.background } : {}),
          }}>
            {content.length ? content : segment.text}
          </span>
        )
      })}
    </>
  )
}

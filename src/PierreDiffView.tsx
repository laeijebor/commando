import { MultiFileDiff, WorkerPoolContextProvider, type DiffTokenEventBaseProps, type FileContents, type FileDiffOptions } from '@pierre/diffs/react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { blameCommitAt, contentSignature, relativeTime, type FileBlame } from './gitBlame'
import type { DiffDisplay, GitBlameCommit, GitFileContents, GitFileSide } from './gitApi'
import {
  findRowMatches,
  paintMatches,
  revealMatch,
  searchHighlightCSS,
  searchHighlightNames,
  type DiffSearchMatch,
} from './pierreSearch'
import { PIERRE_THEME, pierreHighlighterOptions, pierrePoolOptions } from './pierreWorker'

/** A token the user clicked, for go-to-definition and similar lookups. */
export type PierreTokenClick = {
  side: 'deletions' | 'additions'
  lineNumber: number
  text: string
  start: number
  end: number
}

type Props = {
  contents: GitFileContents
  display: DiffDisplay
  /** File-scope search query and the index of the current match. */
  query: string
  activeMatch: number
  onMatchCountChange(count: number): void
  /** null while blame is turned off. */
  blame: FileBlame | null
  onTokenClick?(token: PierreTokenClick): void
}

type BlameHover = {
  commit: GitBlameCommit | undefined
  /** Position relative to the view, which scrolls with the diff. */
  rowTop: number
  rowBottom: number
  /** The hint sits after the text on the row's last visual line (long lines wrap). */
  hintTop: number
  hintHeight: number
  hintLeft: number
  hintMaxWidth: number
  cardLeft: number
  cardAbove: boolean
}

const CARD_DELAY_MS = 450
const CARD_WIDTH = 360

// The app's dark terminal surface and type, applied inside Pierre's shadow root.
const BASE_CSS = `:host {
  --diffs-dark-bg: #0a0a0a;
  --diffs-font-family: "JetBrains Mono", "SFMono-Regular", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --diffs-header-font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --diffs-font-size: 12px;
  --diffs-line-height: 1.45;
}`

/** The worker pool lives as long as any provider is mounted; keep one around the whole diff output. */
export function PierreWorkerPool({ children }: { children: ReactNode }) {
  // Without workers (old runtimes, tests) Pierre highlights on the main thread instead.
  if (typeof Worker === 'undefined') return <>{children}</>
  return (
    <WorkerPoolContextProvider poolOptions={pierrePoolOptions} highlighterOptions={pierreHighlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  )
}

function useFileContents(side: GitFileSide | null): FileContents | null {
  const path = side?.path
  const contents = side?.contents
  const rev = side?.rev
  return useMemo(
    () => (path === undefined || contents === undefined ? null : { name: path, contents, cacheKey: `${rev}:${path}:${rev === 'worktree' ? contentSignature(contents) : ''}` }),
    [path, contents, rev],
  )
}

function shortDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function PierreDiffView({ contents, display, query, activeMatch, onMatchCountChange, blame, onTokenClick }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [renderVersion, setRenderVersion] = useState(0)
  const [hover, setHover] = useState<BlameHover | null>(null)
  const [cardVisible, setCardVisible] = useState(false)
  const cardTimer = useRef<number | undefined>(undefined)
  const blameRef = useRef(blame)
  blameRef.current = blame
  const onTokenClickRef = useRef(onTokenClick)
  onTokenClickRef.current = onTokenClick
  const id = useId()
  const highlightNames = useMemo(() => searchHighlightNames(`pierre${id}`), [id])
  const oldFile = useFileContents(contents.old)
  const newFile = useFileContents(contents.new)

  const clearHover = useCallback(() => {
    window.clearTimeout(cardTimer.current)
    setHover(null)
    setCardVisible(false)
  }, [])

  const onLineEnter = useCallback((props: Parameters<NonNullable<FileDiffOptions<undefined, undefined>['onLineEnter']>>[0]) => {
    const current = blameRef.current
    const wrapper = wrapperRef.current
    if (!current || !wrapper) return
    // Deletions come from the old file; additions and context from the new one, by its own numbering.
    const context = props.lineType === 'context' || props.lineType === 'context-expanded'
    // Changed rows carry no alternate line number, so they only ever read their own side.
    const altLine = props.lineElement.dataset.altLine === undefined ? undefined : Number(props.lineElement.dataset.altLine)
    const newLine = props.annotationSide === 'additions' ? props.lineNumber : context ? altLine : undefined
    const oldLine = props.annotationSide === 'deletions' ? props.lineNumber : context ? altLine : undefined
    const commit = (newLine !== undefined ? blameCommitAt(current.new, newLine) : undefined)
      ?? (oldLine !== undefined ? blameCommitAt(current.old, oldLine) : undefined)
    if (!commit && !current.loading) return
    const base = wrapper.getBoundingClientRect()
    const row = props.lineElement.getBoundingClientRect()
    // Syntax tokens are spans, so the last one ends where the line's text does.
    const tokenRects = props.lineElement.lastElementChild?.getClientRects()
    const lastLine = tokenRects?.length ? tokenRects[tokenRects.length - 1] : null
    const textRight = lastLine ? Math.min(row.right, Math.max(row.left, lastLine.right)) : row.left
    const hintLeft = textRight + 28 - base.left
    const pointerX = props.event?.clientX ?? row.left
    setHover({
      commit,
      rowTop: row.top - base.top,
      rowBottom: row.bottom - base.top,
      hintTop: (lastLine?.top ?? row.top) - base.top,
      hintHeight: lastLine?.height || Math.min(row.height, 18),
      hintLeft,
      hintMaxWidth: row.right - base.left - hintLeft - 8,
      cardLeft: Math.max(8, Math.min(pointerX - base.left - 24, base.width - CARD_WIDTH - 8)),
      cardAbove: row.bottom + 140 > window.innerHeight,
    })
    setCardVisible(false)
    window.clearTimeout(cardTimer.current)
    cardTimer.current = window.setTimeout(() => setCardVisible(true), CARD_DELAY_MS)
  }, [])

  const onPostRender = useCallback(() => setRenderVersion((version) => version + 1), [])
  const tokenClick = useCallback((props: DiffTokenEventBaseProps) => {
    onTokenClickRef.current?.({
      side: props.side,
      lineNumber: props.lineNumber,
      text: props.tokenText,
      start: props.lineCharStart,
      end: props.lineCharEnd,
    })
  }, [])
  const hasTokenClick = onTokenClick !== undefined

  // Options must stay referentially stable: Pierre re-renders the whole diff when they change.
  const options = useMemo<FileDiffOptions<undefined, undefined>>(() => ({
    theme: PIERRE_THEME,
    themeType: 'dark',
    diffStyle: display === 'inline' ? 'unified' : 'split',
    diffIndicators: 'bars',
    lineDiffType: 'word-alt',
    hunkSeparators: 'line-info',
    // The side panel is narrow; wrapping keeps whole lines (and search matches) in view.
    overflow: 'wrap',
    unsafeCSS: `${BASE_CSS}\n${searchHighlightCSS(highlightNames)}`,
    onPostRender,
    onLineEnter,
    onLineLeave: clearHover,
    ...(hasTokenClick ? { onTokenClick: tokenClick } : {}),
  }), [clearHover, display, hasTokenClick, highlightNames, onLineEnter, onPostRender, tokenClick])

  useEffect(() => () => window.clearTimeout(cardTimer.current), [])
  const blameOn = blame !== null
  useEffect(() => { if (!blameOn) clearHover() }, [blameOn, clearHover])

  // Search runs over the rendered rows, so it re-runs whenever Pierre renders (expanded context,
  // highlighting arriving from the worker) as well as when the query or current match changes.
  const matchesRef = useRef<DiffSearchMatch[]>([])
  const revealed = useRef<{ query: string; activeMatch: number; found: boolean } | null>(null)
  const onMatchCountChangeRef = useRef(onMatchCountChange)
  onMatchCountChangeRef.current = onMatchCountChange
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const host = wrapper.querySelector('diffs-container')
    const matches = findRowMatches(host?.shadowRoot ?? wrapper, query)
    matchesRef.current = matches
    onMatchCountChangeRef.current(matches.length)
  }, [query, renderVersion, oldFile, newFile])

  useEffect(() => {
    const matches = matchesRef.current
    if (!matches.length) {
      revealed.current = { query, activeMatch, found: false }
      return
    }
    const current = Math.min(activeMatch, matches.length - 1)
    const last = revealed.current
    if (!last || !last.found || last.query !== query || last.activeMatch !== activeMatch) revealMatch(matches[current])
    revealed.current = { query, activeMatch, found: true }
    return paintMatches(matches, current, highlightNames)
  }, [activeMatch, highlightNames, query, renderVersion, oldFile, newFile])

  const commit = hover?.commit
  const hintText = commit
    ? commit.uncommitted ? 'Uncommitted changes' : `${commit.author}, ${relativeTime(commit.authorTime)} · ${commit.summary}`
    : 'Loading blame…'

  return (
    <div className="pierre-diff" ref={wrapperRef} onPointerLeave={clearHover}>
      {blame?.error ? <div className="pierre-blame-status error" role="alert">Blame unavailable: {blame.error}</div> : null}
      <MultiFileDiff
        {...(oldFile && newFile ? { oldFile, newFile } : oldFile ? { oldFile, newFile: null } : { oldFile: null, newFile: newFile! })}
        options={options}
      />
      {blame && hover ? (
        <>
          {hover.hintMaxWidth >= 80 ? (
            <div
              className="pierre-blame-hint"
              style={{ top: hover.hintTop, left: hover.hintLeft, maxWidth: hover.hintMaxWidth, height: hover.hintHeight, lineHeight: `${hover.hintHeight}px` }}
            >
              {hintText}
            </div>
          ) : null}
          {cardVisible && commit ? (
            <div
              className="pierre-blame-card"
              role="tooltip"
              style={hover.cardAbove
                ? { bottom: `calc(100% - ${hover.rowTop - 4}px)`, left: hover.cardLeft, width: CARD_WIDTH }
                : { top: hover.rowBottom + 4, left: hover.cardLeft, width: CARD_WIDTH }}
            >
              {commit.uncommitted ? (
                <>
                  <div className="pierre-blame-card-meta"><strong>Uncommitted</strong></div>
                  <p>Changed in the working tree and not committed yet.</p>
                </>
              ) : (
                <>
                  <div className="pierre-blame-card-meta">
                    <code>{commit.sha.slice(0, 8)}</code>
                    <strong>{commit.author}</strong>
                    <time dateTime={new Date(commit.authorTime * 1000).toISOString()} title={shortDate(commit.authorTime)}>
                      {relativeTime(commit.authorTime)}
                    </time>
                  </div>
                  <p>{commit.summary}</p>
                </>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

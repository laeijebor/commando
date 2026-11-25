import { MultiFileDiff, WorkerPoolContextProvider, type DiffTokenEventBaseProps, type FileContents, type FileDiffOptions } from '@pierre/diffs/react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { blameCommitAt, contentSignature, relativeTime, type FileBlame } from './gitBlame'
import type { DiffDisplay, GitBlameCommit, GitFileContents, GitFileSide } from './gitApi'
import {
  findRowMatches,
  findSideRow,
  paintMatches,
  revealMatch,
  searchHighlightCSS,
  searchHighlightNames,
  type DiffSearchMatch,
} from './pierreSearch'
import { PIERRE_THEME, pierreHighlighterOptions, pierrePoolOptions } from './pierreWorker'

/** A token the user Cmd/Ctrl-clicked, for go-to-definition and similar lookups. */
export type PierreTokenClick = {
  side: 'deletions' | 'additions'
  lineNumber: number
  text: string
  start: number
  end: number
}

/** A line to scroll into view and flash; a new `id` asks again for the same line. */
export type PierreRevealRequest = {
  id: number
  side: 'deletions' | 'additions'
  line: number
}

/** Tokens worth looking up: whitespace and punctuation alone name nothing. */
export function isNavigableToken(text: string): boolean {
  return /[\p{L}\p{N}_$]/u.test(text)
}

const hasNavigationModifier = (event: MouseEvent | KeyboardEvent | undefined) => Boolean(event?.metaKey || event?.ctrlKey)

/** Marks the token under the pointer while Cmd/Ctrl is held, styled as a link by NAVIGATION_CSS. */
const NAV_TOKEN_ATTRIBUTE = 'data-commando-nav-token'
/** Marks the row "Show in diff" scrolled to, briefly. */
const NAV_TARGET_ATTRIBUTE = 'data-commando-nav-target'
const NAV_TARGET_FLASH_MS = 1600
const NAVIGATION_CSS = `[${NAV_TOKEN_ATTRIBUTE}] { cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
[${NAV_TARGET_ATTRIBUTE}] { background-color: rgb(94 158 255 / 0.22); box-shadow: inset 2px 0 #5e9eff; }`

type Props = {
  contents: GitFileContents
  display: DiffDisplay
  /** File-scope search query and the index of the current match. */
  query: string
  activeMatch: number
  onMatchCountChange(count: number): void
  /** null while blame is turned off. */
  blame: FileBlame | null
  /** Cmd/Ctrl-click on a token; a plain click is left to text selection. */
  onNavigate?(token: PierreTokenClick): void
  /** Scrolls a line into view once it is rendered, then calls onRevealed. */
  reveal?: PierreRevealRequest | null
  onRevealed?(id: number): void
  /** Called after each Pierre render, e.g. to restore scroll once the rows exist. */
  onRendered?(): void
  /** Treat the current search match as already revealed when mounting (restoring a hidden view). */
  skipInitialReveal?: boolean
}

type BlameHover = {
  /** Line numbers on each side; the commit is looked up on render so late-arriving blame shows. */
  newLine: number | undefined
  oldLine: number | undefined
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
export const PIERRE_BASE_CSS = `:host {
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

function hoverCommit(blame: FileBlame, newLine: number | undefined, oldLine: number | undefined): GitBlameCommit | undefined {
  return (newLine !== undefined ? blameCommitAt(blame.new, newLine) : undefined)
    ?? (oldLine !== undefined ? blameCommitAt(blame.old, oldLine) : undefined)
}

function shortDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function PierreDiffView({ contents, display, query, activeMatch, onMatchCountChange, blame, onNavigate, reveal = null, onRevealed, onRendered, skipInitialReveal = false }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [renderVersion, setRenderVersion] = useState(0)
  const [hover, setHover] = useState<BlameHover | null>(null)
  const [cardVisible, setCardVisible] = useState(false)
  const cardTimer = useRef<number | undefined>(undefined)
  const blameRef = useRef(blame)
  blameRef.current = blame
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const onRenderedRef = useRef(onRendered)
  onRenderedRef.current = onRendered
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
    if (!hoverCommit(current, newLine, oldLine) && !current.loading) return
    const base = wrapper.getBoundingClientRect()
    const row = props.lineElement.getBoundingClientRect()
    // Syntax tokens are spans, so the last one ends where the line's text does.
    const tokenRects = props.lineElement.lastElementChild?.getClientRects()
    const lastLine = tokenRects?.length ? tokenRects[tokenRects.length - 1] : null
    const textRight = lastLine ? Math.min(row.right, Math.max(row.left, lastLine.right)) : row.left
    const hintLeft = textRight + 28 - base.left
    const pointerX = props.event?.clientX ?? row.left
    setHover({
      newLine,
      oldLine,
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

  const onPostRender = useCallback(() => {
    setRenderVersion((version) => version + 1)
    onRenderedRef.current?.()
  }, [])
  // Pierre reports token clicks and hovers with the DOM event, so the modifier is read from it;
  // key presses while hovering are tracked too, so the link style follows Cmd/Ctrl as it changes.
  const hoveredToken = useRef<HTMLElement | null>(null)
  const markHoveredToken = useCallback((modifier: boolean) => {
    const token = hoveredToken.current
    if (!token) return
    if (modifier) token.setAttribute(NAV_TOKEN_ATTRIBUTE, '')
    else token.removeAttribute(NAV_TOKEN_ATTRIBUTE)
  }, [])
  const tokenClick = useCallback((props: DiffTokenEventBaseProps, event?: MouseEvent) => {
    if (!hasNavigationModifier(event) || !isNavigableToken(props.tokenText)) return
    event?.preventDefault()
    onNavigateRef.current?.({
      side: props.side,
      lineNumber: props.lineNumber,
      text: props.tokenText,
      start: props.lineCharStart,
      end: props.lineCharEnd,
    })
  }, [])
  const tokenEnter = useCallback((props: DiffTokenEventBaseProps, event?: PointerEvent) => {
    markHoveredToken(false)
    hoveredToken.current = isNavigableToken(props.tokenText) ? props.tokenElement : null
    markHoveredToken(hasNavigationModifier(event))
  }, [markHoveredToken])
  const tokenLeave = useCallback(() => {
    markHoveredToken(false)
    hoveredToken.current = null
  }, [markHoveredToken])
  const hasNavigate = onNavigate !== undefined
  useEffect(() => {
    if (!hasNavigate) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Meta' || event.key === 'Control') markHoveredToken(hasNavigationModifier(event)) }
    const onBlur = () => markHoveredToken(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
      tokenLeave()
    }
  }, [hasNavigate, markHoveredToken, tokenLeave])

  // Options must stay referentially stable: Pierre re-renders the whole diff when they change.
  const options = useMemo<FileDiffOptions<undefined, undefined>>(() => ({
    theme: PIERRE_THEME,
    themeType: 'dark',
    useTokenTransformer: pierreHighlighterOptions.useTokenTransformer,
    diffStyle: display === 'inline' ? 'unified' : 'split',
    diffIndicators: 'bars',
    lineDiffType: 'word-alt',
    hunkSeparators: 'line-info',
    // The side panel is narrow; wrapping keeps whole lines (and search matches) in view.
    overflow: 'wrap',
    unsafeCSS: `${PIERRE_BASE_CSS}\n${searchHighlightCSS(highlightNames)}\n${NAVIGATION_CSS}`,
    onPostRender,
    onLineEnter,
    onLineLeave: clearHover,
    ...(hasNavigate ? { onTokenClick: tokenClick, onTokenEnter: tokenEnter, onTokenLeave: tokenLeave } : {}),
  }), [clearHover, display, hasNavigate, highlightNames, onLineEnter, onPostRender, tokenClick, tokenEnter, tokenLeave])

  useEffect(() => () => window.clearTimeout(cardTimer.current), [])
  const blameOn = blame !== null
  useEffect(() => { if (!blameOn) clearHover() }, [blameOn, clearHover])

  // Search runs over the rendered rows, so it re-runs whenever Pierre renders (expanded context,
  // highlighting arriving from the worker) as well as when the query or current match changes.
  const matchesRef = useRef<DiffSearchMatch[]>([])
  const revealed = useRef<{ query: string; activeMatch: number; found: boolean } | null>(
    skipInitialReveal ? { query, activeMatch, found: true } : null,
  )
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

  // "Show in diff": wait until Pierre has rendered rows for the side, then scroll and flash the line.
  // The flash outlives the request, which the parent clears as soon as the line is revealed.
  const onRevealedRef = useRef(onRevealed)
  onRevealedRef.current = onRevealed
  const flash = useRef<{ row: HTMLElement; timer: number } | null>(null)
  const clearFlash = useCallback(() => {
    if (!flash.current) return
    window.clearTimeout(flash.current.timer)
    flash.current.row.removeAttribute(NAV_TARGET_ATTRIBUTE)
    flash.current = null
  }, [])
  useEffect(() => clearFlash, [clearFlash])
  const revealedId = useRef<number | null>(null)
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!reveal || !wrapper || revealedId.current === reveal.id) return
    const host = wrapper.querySelector('diffs-container')
    const row = findSideRow(host?.shadowRoot ?? wrapper, reveal.side, reveal.line)
    if (!row) return
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center', inline: 'nearest' })
    clearFlash()
    row.setAttribute(NAV_TARGET_ATTRIBUTE, '')
    flash.current = { row, timer: window.setTimeout(clearFlash, NAV_TARGET_FLASH_MS) }
    revealedId.current = reveal.id
    onRevealedRef.current?.(reveal.id)
  }, [clearFlash, reveal, renderVersion])

  const commit = hover && blame ? hoverCommit(blame, hover.newLine, hover.oldLine) : undefined
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

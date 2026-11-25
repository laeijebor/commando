import { File as PierreFile, type FileContents, type FileOptions } from '@pierre/diffs/react'
import { Code2, FileDiff, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CODE_NAV_KINDS, type CodeNavFile, type CodeNavKind, type CodeNavLocation, type CodeNavRequest, type CodeNavResult } from '../shared/code-nav'
import type { GitDiffApiClient } from './gitApi'
import { contentSignature } from './gitBlame'
import { PIERRE_BASE_CSS } from './PierreDiffView'
import { PIERRE_THEME, pierreHighlighterOptions } from './pierreWorker'

/** Where a navigation started: the clicked symbol in one diff side. */
export type CodeNavOrigin = Omit<CodeNavRequest, 'kind'>

type Props = {
  paneId: string
  api: Pick<GitDiffApiClient, 'navigate' | 'fileAt'>
  origin: CodeNavOrigin
  /** Paths changed in the diff; they are marked and listed first. */
  changedFiles: ReadonlySet<string>
  /** The diff side that shows `file` at `rev`, or null when the diff cannot show it. */
  diffSide(file: string, rev: string): 'deletions' | 'additions' | null
  onShowInDiff(file: string, side: 'deletions' | 'additions', line: number): void
  /** Repo-relative path; omitted where there is no session IDE. */
  onOpenInIde?(file: string, line: number, column: number): void
  onClose(): void
}

type TabState =
  | { status: 'loading' }
  | { status: 'done'; result: CodeNavResult }
  | { status: 'error'; message: string }

type FileState = CodeNavFile | { error: string } | 'loading'

type LocationGroup = { file: string; changed: boolean; locations: CodeNavLocation[] }

const TAB_LABEL: Record<CodeNavKind, string> = { definition: 'Definition', references: 'References', callers: 'Callers' }

/** Locations grouped by file in result order, files changed in the diff first. */
export function groupLocations(locations: CodeNavLocation[], changedFiles: ReadonlySet<string>): LocationGroup[] {
  const groups = new Map<string, LocationGroup>()
  for (const location of locations) {
    let group = groups.get(location.file)
    if (!group) groups.set(location.file, group = { file: location.file, changed: changedFiles.has(location.file), locations: [] })
    group.locations.push(location)
  }
  const ordered = [...groups.values()]
  return [...ordered.filter((group) => group.changed), ...ordered.filter((group) => !group.changed)]
}

const fileKey = (file: string, rev: string) => `${rev}\0${file}`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The preview line with the first whole-word occurrence of the symbol marked. */
function PreviewText({ text, symbol }: { text: string; symbol: string }) {
  const match = symbol ? new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(symbol)}(?![\\p{L}\\p{N}_$])`, 'u').exec(text) : null
  if (!match) return <>{text}</>
  return <>{text.slice(0, match.index)}<mark>{match[0]}</mark>{text.slice(match.index + match[0].length)}</>
}

function shortRev(rev: string): string {
  return rev === 'worktree' ? 'working tree' : rev.slice(0, 8)
}

/** One file at a rev, rendered by Pierre with the location's lines selected and scrolled into view. */
function LocationPreview({ path, rev, contents, line, endLine }: { path: string; rev: string; contents: string; line: number; endLine: number }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolledTo = useRef<string | null>(null)
  const target = `${rev}:${path}:${line}`
  const targetRef = useRef({ target, line })
  targetRef.current = { target, line }
  const file = useMemo<FileContents>(
    () => ({ name: path, contents, cacheKey: `nav:${rev}:${path}:${rev === 'worktree' ? contentSignature(contents) : ''}` }),
    [contents, path, rev],
  )
  const centerTarget = useCallback(() => {
    const container = scrollRef.current
    const { target: wanted, line: wantedLine } = targetRef.current
    if (!container || scrolledTo.current === wanted) return
    const host = container.querySelector('diffs-container')
    const row = (host?.shadowRoot ?? container).querySelector<HTMLElement>(`[data-content] [data-line="${wantedLine}"]`)
    if (!row) return
    // Scroll only this pane: scrollIntoView would also move the diff and the page around it.
    const box = container.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    container.scrollTop += rowBox.top - box.top - (box.height - rowBox.height) / 2
    scrolledTo.current = wanted
  }, [])
  useEffect(centerTarget, [centerTarget, target])
  const options = useMemo<FileOptions<undefined, undefined>>(() => ({
    theme: PIERRE_THEME,
    themeType: 'dark',
    // Must match the worker pool's options, or the pool's highlight results aren't used.
    useTokenTransformer: pierreHighlighterOptions.useTokenTransformer,
    overflow: 'scroll',
    disableFileHeader: true,
    unsafeCSS: PIERRE_BASE_CSS,
    onPostRender: centerTarget,
  }), [centerTarget])
  const selectedLines = useMemo(() => ({ start: line, end: Math.max(line, endLine) }), [endLine, line])
  return (
    <div className="code-nav-preview-code" ref={scrollRef}>
      <PierreFile file={file} options={options} selectedLines={selectedLines} />
    </div>
  )
}

/**
 * Definition, references and callers of a symbol clicked in the rich diff, docked under it.
 * Each tab is fetched the first time it is shown; the selected location's file is previewed
 * at the rev the result refers to.
 */
export function CodeNavPeek({ paneId, api, origin, changedFiles, diffSide, onShowInDiff, onOpenInIde, onClose }: Props) {
  const [tab, setTab] = useState<CodeNavKind>('definition')
  const [tabs, setTabs] = useState<Partial<Record<CodeNavKind, TabState>>>({})
  const [selected, setSelected] = useState<Partial<Record<CodeNavKind, number>>>({})
  const [files, setFiles] = useState<Record<string, FileState>>({})
  const rootRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The peek is remounted for every click, so a response that lands after unmount is stale.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const apiRef = useRef(api)
  apiRef.current = api

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }) }, [])

  const current = tabs[tab]
  useEffect(() => {
    if (current) return
    setTabs((states) => ({ ...states, [tab]: { status: 'loading' } }))
    apiRef.current.navigate(paneId, { kind: tab, ...origin })
      .then((result) => { if (alive.current) setTabs((states) => ({ ...states, [tab]: { status: 'done', result } })) })
      .catch((cause: unknown) => {
        if (alive.current) setTabs((states) => ({ ...states, [tab]: { status: 'error', message: cause instanceof Error ? cause.message : 'Navigation failed' } }))
      })
  }, [current, origin, paneId, tab])

  const result = current?.status === 'done' ? current.result : null
  const groups = useMemo(() => (result ? groupLocations(result.locations, changedFiles) : []), [changedFiles, result])
  const flat = useMemo(() => groups.flatMap((group) => group.locations), [groups])
  const selectedIndex = Math.min(selected[tab] ?? 0, Math.max(0, flat.length - 1))
  const location = flat[selectedIndex] ?? null
  const previewKey = location && result ? fileKey(location.file, result.rev) : null
  const preview = previewKey ? files[previewKey] : undefined

  useEffect(() => {
    if (!location || !result || !previewKey || preview !== undefined) return
    setFiles((states) => ({ ...states, [previewKey]: 'loading' }))
    apiRef.current.fileAt(paneId, location.file, result.rev)
      .then((file) => { if (alive.current) setFiles((states) => ({ ...states, [previewKey]: file })) })
      .catch((cause: unknown) => {
        if (alive.current) setFiles((states) => ({ ...states, [previewKey]: { error: cause instanceof Error ? cause.message : 'Unable to load file' } }))
      })
  }, [location, paneId, preview, previewKey, result])

  // Keep the selected row visible while moving through the list from the keyboard.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex, tab])

  const select = (index: number) => setSelected((states) => ({ ...states, [tab]: index }))
  const side = location && result ? diffSide(location.file, result.rev) : null
  const reveal = (item: CodeNavLocation) => {
    const target = result ? diffSide(item.file, result.rev) : null
    if (target) onShowInDiff(item.file, target, item.line)
  }
  const showInDiff = () => { if (location) reveal(location) }
  const openInIde = () => { if (location) onOpenInIde?.(location.file, location.line, location.character + 1) }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    const onButton = event.target instanceof HTMLElement && event.target.closest('button')
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && flat.length) {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      select(Math.min(flat.length - 1, Math.max(0, selectedIndex + step)))
    } else if (event.key === 'Enter' && !onButton && side) {
      event.preventDefault()
      showInDiff()
    }
  }

  // Esc also closes the peek after clicking back into the diff, which leaves focus on the page.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const active = document.activeElement
      // Inside the peek its own handler closes it.
      if (active && rootRef.current?.contains(active)) return
      const inDiff = active && active !== document.body && rootRef.current?.closest('.git-diff-view')?.contains(active)
      if (active && active !== document.body && !inDiff) return
      // Fields in the diff (search, path filter) clear themselves on Esc first.
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
      event.preventDefault()
      onCloseRef.current()
    }
    // Capture, so a side-panel drawer listening for Esc on the window sees it handled.
    window.addEventListener('keydown', onWindowKeyDown, true)
    return () => window.removeEventListener('keydown', onWindowKeyDown, true)
  }, [])

  const count = (kind: CodeNavKind) => {
    const state = tabs[kind]
    return state?.status === 'done' ? `${state.result.locations.length}${state.result.truncated ? '+' : ''}` : null
  }

  let flatIndex = 0
  return (
    <section className="code-nav-peek" aria-label={`Navigation for ${origin.symbol}`} ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="code-nav-header">
        <code className="code-nav-symbol" title={origin.symbol}>{origin.symbol}</code>
        <div className="code-nav-tabs" role="tablist" aria-label="Navigation kind">
          {CODE_NAV_KINDS.map((kind) => {
            const loaded = count(kind)
            return (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={kind === tab}
                className={kind === tab ? 'active' : undefined}
                onClick={() => setTab(kind)}
              >
                {TAB_LABEL[kind]}
                {loaded !== null ? <>{' '}<span className="code-nav-count">{loaded}</span></> : null}
              </button>
            )
          })}
        </div>
        {result ? (
          result.source === 'text'
            ? <span className="code-nav-badge text" title="Whole-word name matches from git grep, not a language server">name matches</span>
            : <span className="code-nav-badge precise" title="Resolved by the language server">precise</span>
        ) : null}
        {result?.note ? <span className="code-nav-note" title={result.note}>{result.note}</span> : null}
        <button type="button" className="code-nav-close" onClick={onClose} aria-label="Close navigation" title="Close (Esc)">
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="code-nav-body">
        <div className="code-nav-list" ref={listRef} role="listbox" aria-label={`${TAB_LABEL[tab]} locations`}>
          {!current || current.status === 'loading'
            ? <div className="git-diff-status"><LoaderCircle className="spin" />Finding {TAB_LABEL[tab].toLowerCase()}</div>
            : null}
          {current?.status === 'error' ? <div className="git-diff-error" role="alert">{current.message}</div> : null}
          {result && !flat.length ? <div className="git-diff-status">No {TAB_LABEL[tab].toLowerCase()} found for {origin.symbol}</div> : null}
          {groups.map((group) => (
            <div className="code-nav-group" key={group.file} role="group" aria-label={group.file}>
              <div className="code-nav-group-file" title={group.file}>
                <span>{group.file}</span>
                {group.changed ? <span className="code-nav-changed" title="Changed in this diff">changed</span> : null}
              </div>
              {group.locations.map((item) => {
                const index = flatIndex++
                return (
                  <div
                    key={`${item.line}:${item.character}:${index}`}
                    role="option"
                    aria-selected={index === selectedIndex}
                    className={`code-nav-location${index === selectedIndex ? ' selected' : ''}`}
                    onClick={() => select(index)}
                    onDoubleClick={() => reveal(item)}
                  >
                    <span className="code-nav-line">{item.line}</span>
                    <span className="code-nav-preview-text"><PreviewText text={item.preview} symbol={origin.symbol} /></span>
                    {item.container ? <span className="code-nav-container">{item.container}</span> : null}
                  </div>
                )
              })}
            </div>
          ))}
          {result?.truncated ? <div className="code-nav-truncated">More matches exist than are shown.</div> : null}
        </div>
        <div className="code-nav-preview">
          {location && result ? (
            <>
              <div className="code-nav-preview-header">
                <span className="code-nav-preview-path" title={`${location.file} at ${shortRev(result.rev)}`}>
                  {location.file}:{location.line}
                  <span className="code-nav-rev">{shortRev(result.rev)}</span>
                </span>
                {side ? (
                  <button type="button" className="git-diff-open-ide" onClick={showInDiff} title="Select this file in the diff and scroll to the line (Enter)">
                    <FileDiff aria-hidden="true" />Show in diff
                  </button>
                ) : null}
                {onOpenInIde ? (
                  <button
                    type="button"
                    className="git-diff-open-ide"
                    onClick={openInIde}
                    title={result.rev === 'worktree' ? 'Open this line in the session IDE' : 'Open in the session IDE (the file on disk may differ from this commit)'}
                  >
                    <Code2 aria-hidden="true" />Open in IDE
                  </button>
                ) : null}
              </div>
              {preview === undefined || preview === 'loading'
                ? <div className="git-diff-status"><LoaderCircle className="spin" />Loading {location.file}</div>
                : 'error' in preview
                  ? <div className="git-diff-error" role="alert">{preview.error}</div>
                  : preview.contents === null
                    ? <div className="git-diff-status">{preview.unavailable === 'binary' ? 'Binary file: no preview' : preview.unavailable === 'too-large' ? 'Too large to preview' : 'File not found at this revision'}</div>
                    : <LocationPreview key={previewKey} path={location.file} rev={result.rev} contents={preview.contents} line={location.line} endLine={location.endLine ?? location.line} />}
            </>
          ) : null}
        </div>
      </div>
    </section>
  )
}

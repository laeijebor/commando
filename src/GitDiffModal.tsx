import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Columns2,
  FileDiff,
  FolderClosed,
  FolderOpen,
  List,
  ListTree,
  LoaderCircle,
  Rows3,
  Search,
  X,
} from 'lucide-react'
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { parseAnsi, type AnsiSegment } from './ansi'
import type {
  DiffDisplay,
  DiffEngine,
  GitChangedFile,
  GitDiffApiClient,
  GitDiffSearchResult,
  GitDiffSummary,
} from './gitApi'

type Props = {
  paneId: string
  panePath: string
  api: GitDiffApiClient
  initialSummary: GitDiffSummary | null
  onClose(): void
}

const APPROXIMATE_CHARACTER_WIDTH = 7.25
const AUTO_TARGET = 'auto'
const ENGINE_STORAGE_KEY = 'commando-diff-engine'
const DISPLAY_STORAGE_KEY = 'commando-diff-display'
const FILE_VIEW_STORAGE_KEY = 'commando-diff-file-view'
const FILE_PANEL_WIDTH_STORAGE_KEY = 'commando-diff-file-panel-width'
const DEFAULT_FILE_PANEL_WIDTH = 300
const MIN_FILE_PANEL_WIDTH = 180
const MAX_FILE_PANEL_WIDTH = 640
const MIN_DIFF_OUTPUT_WIDTH = 320

type FileView = 'tree' | 'list'
type SearchScope = 'file' | 'all'
type TextMatch = { start: number; end: number }

type FileTreeFolder = {
  name: string
  path: string
  folders: Map<string, FileTreeFolder>
  files: GitChangedFile[]
}

type PathTooltip = {
  path: string
  left: number
  top: number
}

function storedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key)
    return allowed.includes(value as T) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

function storeChoice(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Best-effort persistence; the in-memory choice still applies.
  }
}

function storedNumber(key: string, fallback: number, minimum: number, maximum: number): number {
  try {
    const value = Number(window.localStorage.getItem(key))
    return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback
  } catch {
    return fallback
  }
}

function buildFileTree(files: GitChangedFile[]): FileTreeFolder {
  const root: FileTreeFolder = { name: '', path: '', folders: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    parts.pop()
    let folder = root
    for (const part of parts) {
      const path = folder.path ? `${folder.path}/${part}` : part
      let child = folder.folders.get(part)
      if (!child) {
        child = { name: part, path, folders: new Map(), files: [] }
        folder.folders.set(part, child)
      }
      folder = child
    }
    folder.files.push(file)
  }
  return root
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function findTextMatches(text: string, query: string): TextMatch[] {
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
          <span
            key={index}
            className={segmentClassName(segment)}
            style={{
              ...(typeof segment.foreground === 'string' ? { color: segment.foreground } : {}),
              ...(typeof segment.background === 'string' ? { backgroundColor: segment.background } : {}),
            }}
          >
            {content.length ? content : segment.text}
          </span>
        )
      })}
    </>
  )
}

function statusLabel(file: GitChangedFile): { letter: string; className: string; title: string } {
  switch (file.status[0]) {
    case 'A': return { letter: 'A', className: 'added', title: 'Added' }
    case 'D': return { letter: 'D', className: 'deleted', title: 'Deleted' }
    case 'U': return { letter: 'U', className: 'added', title: 'Untracked' }
    case 'T': return { letter: 'T', className: 'modified', title: 'Type changed' }
    default: return { letter: 'M', className: 'modified', title: 'Modified' }
  }
}

export function GitDiffModal({ paneId, panePath, api, initialSummary, onClose }: Props) {
  const [summary, setSummary] = useState<GitDiffSummary | null>(initialSummary)
  const [summaryError, setSummaryError] = useState('')
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [targetDraft, setTargetDraft] = useState('')
  const [appliedTarget, setAppliedTarget] = useState<string | undefined>(undefined)
  const [branchList, setBranchList] = useState<string[]>([])
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [diffError, setDiffError] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [fileFilter, setFileFilter] = useState('')
  const [diffSearch, setDiffSearch] = useState('')
  const [searchScope, setSearchScope] = useState<SearchScope>('file')
  const [activeDiffMatch, setActiveDiffMatch] = useState(0)
  const [allSearchResult, setAllSearchResult] = useState<GitDiffSearchResult | null>(null)
  const [allSearchLoading, setAllSearchLoading] = useState(false)
  const [allSearchError, setAllSearchError] = useState('')
  const [engine, setEngine] = useState<DiffEngine>(
    () => storedChoice(ENGINE_STORAGE_KEY, ['difftastic', 'delta'], 'difftastic'),
  )
  const [display, setDisplay] = useState<DiffDisplay>(
    () => storedChoice(DISPLAY_STORAGE_KEY, ['side-by-side', 'inline'], 'side-by-side'),
  )
  const [fileView, setFileView] = useState<FileView>(
    () => storedChoice(FILE_VIEW_STORAGE_KEY, ['tree', 'list'], 'tree'),
  )
  const [filePanelWidth, setFilePanelWidth] = useState(
    () => storedNumber(
      FILE_PANEL_WIDTH_STORAGE_KEY,
      DEFAULT_FILE_PANEL_WIDTH,
      MIN_FILE_PANEL_WIDTH,
      MAX_FILE_PANEL_WIDTH,
    ),
  )
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const [pathTooltip, setPathTooltip] = useState<PathTooltip | null>(null)
  const [diffViewportVersion, setDiffViewportVersion] = useState(0)
  const apiRef = useRef(api)
  apiRef.current = api
  const bodyRef = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const diffSearchInputRef = useRef<HTMLInputElement>(null)
  const filePanelWidthRef = useRef(filePanelWidth)
  const resizeCleanup = useRef<(() => void) | null>(null)
  const generation = useRef(0)
  const diffGeneration = useRef(0)
  const searchGeneration = useRef(0)

  const maximumFilePanelWidth = () => {
    const bodyWidth = bodyRef.current?.clientWidth
    if (!bodyWidth) return MAX_FILE_PANEL_WIDTH
    return Math.max(
      MIN_FILE_PANEL_WIDTH,
      Math.min(MAX_FILE_PANEL_WIDTH, bodyWidth - MIN_DIFF_OUTPUT_WIDTH),
    )
  }

  const changeFilePanelWidth = (next: number, persist: boolean, refreshDiff: boolean) => {
    const clamped = Math.min(Math.max(next, MIN_FILE_PANEL_WIDTH), maximumFilePanelWidth())
    filePanelWidthRef.current = clamped
    setFilePanelWidth(clamped)
    if (persist) storeChoice(FILE_PANEL_WIDTH_STORAGE_KEY, String(Math.round(clamped)))
    if (refreshDiff) setDiffViewportVersion((current) => current + 1)
  }

  const beginFilePanelResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    resizeCleanup.current?.()
    const startX = event.clientX
    const startWidth = filePanelWidthRef.current
    const move = (pointerEvent: globalThis.PointerEvent) => {
      changeFilePanelWidth(startWidth + pointerEvent.clientX - startX, false, false)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.classList.remove('is-resizing-git-diff-files')
      storeChoice(FILE_PANEL_WIDTH_STORAGE_KEY, String(Math.round(filePanelWidthRef.current)))
      setDiffViewportVersion((current) => current + 1)
      if (resizeCleanup.current === stop) resizeCleanup.current = null
    }
    document.body.classList.add('is-resizing-git-diff-files')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    resizeCleanup.current = stop
  }

  const resizeFilePanelWithKeyboard = (event: ReactKeyboardEvent<HTMLElement>) => {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!direction) return
    event.preventDefault()
    changeFilePanelWidth(
      filePanelWidthRef.current + direction * (event.shiftKey ? 32 : 8),
      true,
      true,
    )
  }

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        diffSearchInputRef.current?.focus()
        diffSearchInputRef.current?.select()
        return
      }
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  useEffect(() => {
    const fitFilePanel = () => changeFilePanelWidth(filePanelWidthRef.current, false, false)
    fitFilePanel()
    window.addEventListener('resize', fitFilePanel)
    return () => {
      window.removeEventListener('resize', fitFilePanel)
      resizeCleanup.current?.()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    apiRef.current
      .branches(paneId)
      .then((next) => { if (!cancelled) setBranchList(next.branches ?? []) })
      .catch(() => { /* type-ahead is best-effort; free typing still works */ })
    return () => { cancelled = true }
  }, [paneId])

  useEffect(() => {
    const request = ++generation.current
    setSummaryLoading(true)
    setSummaryError('')
    apiRef.current
      .summary(paneId, appliedTarget)
      .then((next) => {
        if (request !== generation.current) return
        setSummary(next)
      })
      .catch((cause: unknown) => {
        if (request !== generation.current) return
        setSummaryError(cause instanceof Error ? cause.message : 'Unable to load git summary')
      })
      .finally(() => {
        if (request === generation.current) setSummaryLoading(false)
      })
  }, [paneId, appliedTarget])

  const files = summary?.files ?? []
  const deferredFileFilter = useDeferredValue(fileFilter)
  const normalizedFileFilter = deferredFileFilter.trim().toLowerCase()
  const contentQuery = diffSearch.trim()
  const plainDiff = useMemo(
    () => parseAnsi(diff).map((segment) => segment.text).join(''),
    [diff],
  )
  const diffMatches = useMemo(
    () => findTextMatches(plainDiff, contentQuery),
    [plainDiff, contentQuery],
  )
  const currentDiffMatch = Math.min(activeDiffMatch, Math.max(0, diffMatches.length - 1))
  const allSearchCurrent = allSearchResult?.query.toLowerCase() === contentQuery.toLowerCase()
  const allFileMatchCounts = useMemo(() => {
    if (!allSearchResult || !allSearchCurrent) return new Map<string, number>()
    return new Map(allSearchResult.files.map((file) => [file.file, file.matches]))
  }, [allSearchCurrent, allSearchResult])
  const filterByAllSearch = searchScope === 'all' && contentQuery !== '' && allSearchCurrent && !allSearchLoading
  const visibleFiles = useMemo(
    () => files.filter((file) => (
      (!normalizedFileFilter || file.path.toLowerCase().includes(normalizedFileFilter)) &&
      (!filterByAllSearch || allFileMatchCounts.has(file.path))
    )),
    [allFileMatchCounts, files, filterByAllSearch, normalizedFileFilter],
  )
  const fileTree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles])
  const forceExpandTree = normalizedFileFilter !== '' || filterByAllSearch

  useEffect(() => {
    if (selectedFile && files.some((file) => file.path === selectedFile)) return
    setSelectedFile(files[0]?.path ?? null)
  }, [files, selectedFile])

  useEffect(() => {
    if (!selectedFile) {
      setDiff('')
      setDiffError('')
      return
    }
    const request = ++diffGeneration.current
    setDiffLoading(true)
    setDiffError('')
    const measured = outputRef.current?.clientWidth
    const width = measured
      ? Math.min(400, Math.max(80, Math.floor(measured / APPROXIMATE_CHARACTER_WIDTH)))
      : 180
    apiRef.current
      .fileDiff(paneId, selectedFile, { target: appliedTarget, width, engine, display })
      .then((next) => {
        if (request !== diffGeneration.current) return
        setDiff(next.diff)
      })
      .catch((cause: unknown) => {
        if (request !== diffGeneration.current) return
        setDiff('')
        setDiffError(cause instanceof Error ? cause.message : 'Unable to load diff')
      })
      .finally(() => {
        if (request === diffGeneration.current) setDiffLoading(false)
      })
  }, [paneId, appliedTarget, selectedFile, engine, display, diffViewportVersion])

  useEffect(() => {
    const query = diffSearch.trim()
    const request = ++searchGeneration.current
    if (searchScope !== 'all' || query === '') {
      setAllSearchResult(null)
      setAllSearchLoading(false)
      setAllSearchError('')
      return
    }

    setAllSearchResult(null)
    setAllSearchLoading(true)
    setAllSearchError('')
    const timeout = window.setTimeout(() => {
      apiRef.current
        .search(paneId, query, appliedTarget)
        .then((next) => {
          if (request !== searchGeneration.current) return
          setAllSearchResult(next)
          const matching = new Set(next.files.map((file) => file.file))
          setSelectedFile((current) => (
            current && matching.has(current) ? current : next.files[0]?.file ?? current
          ))
        })
        .catch((cause: unknown) => {
          if (request !== searchGeneration.current) return
          setAllSearchError(cause instanceof Error ? cause.message : 'Unable to search changed files')
        })
        .finally(() => {
          if (request === searchGeneration.current) setAllSearchLoading(false)
        })
    }, 200)

    return () => {
      window.clearTimeout(timeout)
      if (searchGeneration.current === request) searchGeneration.current += 1
    }
  }, [paneId, appliedTarget, diffSearch, searchScope])

  useEffect(() => {
    setActiveDiffMatch(0)
  }, [diff, contentQuery])

  useEffect(() => {
    if (!diffMatches.length) return
    const match = outputRef.current?.querySelector<HTMLElement>(
      `[data-diff-search-match="${currentDiffMatch}"]`,
    )
    if (match && typeof match.scrollIntoView === 'function') {
      match.scrollIntoView({ block: 'center', inline: 'nearest' })
    }
  }, [currentDiffMatch, diffMatches.length])

  const chooseEngine = (next: DiffEngine) => {
    setEngine(next)
    storeChoice(ENGINE_STORAGE_KEY, next)
  }

  const chooseDisplay = (next: DiffDisplay) => {
    setDisplay(next)
    storeChoice(DISPLAY_STORAGE_KEY, next)
  }

  const chooseFileView = (next: FileView) => {
    setFileView(next)
    setPathTooltip(null)
    storeChoice(FILE_VIEW_STORAGE_KEY, next)
  }

  const chooseSearchScope = (next: SearchScope) => {
    setSearchScope(next)
    setActiveDiffMatch(0)
  }

  const moveDiffMatch = (direction: 1 | -1) => {
    if (!diffMatches.length) return
    setActiveDiffMatch((current) => (
      (Math.min(current, diffMatches.length - 1) + direction + diffMatches.length) % diffMatches.length
    ))
  }

  const onDiffSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      moveDiffMatch(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape' && diffSearch !== '') {
      event.preventDefault()
      event.stopPropagation()
      setDiffSearch('')
    }
  }

  const toggleFolder = (path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const showPathTooltip = (path: string, element: HTMLElement) => {
    const bounds = element.getBoundingClientRect()
    const estimatedWidth = Math.min(520, Math.max(240, path.length * 7))
    const left = Math.max(8, Math.min(bounds.left + 12, window.innerWidth - estimatedWidth - 8))
    const top = bounds.bottom + 36 > window.innerHeight
      ? Math.max(8, bounds.top - 30)
      : bounds.bottom + 6
    setPathTooltip({ path, left, top })
  }

  const applyTarget = (value: string) => {
    const next = value.trim()
    setAppliedTarget(next === '' || next === AUTO_TARGET ? undefined : next)
  }

  const chooseBranch = (branch: string) => {
    if (branch === AUTO_TARGET) {
      setTargetDraft('')
      setAppliedTarget(undefined)
    } else {
      setTargetDraft(branch)
      applyTarget(branch)
    }
    setDropdownOpen(false)
  }

  // Filter only while the user is editing; a fresh focus offers every branch.
  const query = filtering ? targetDraft.trim().toLowerCase() : ''
  const suggestions = [
    ...(query === '' || AUTO_TARGET.includes(query) ? [AUTO_TARGET] : []),
    ...branchList
      .filter((branch) => branch !== summary?.branch)
      .filter((branch) => query === '' || branch.toLowerCase().includes(query))
      .slice(0, 30),
  ]
  const activeHighlight = Math.min(highlight, Math.max(0, suggestions.length - 1))

  const onTargetKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!dropdownOpen) {
        setDropdownOpen(true)
        return
      }
      if (!suggestions.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlight((activeHighlight + step + suggestions.length) % suggestions.length)
    } else if (event.key === 'Enter') {
      if (dropdownOpen && suggestions[activeHighlight]) chooseBranch(suggestions[activeHighlight])
      else applyTarget(event.currentTarget.value)
      setDropdownOpen(false)
    } else if (event.key === 'Escape' && dropdownOpen) {
      event.stopPropagation()
      setDropdownOpen(false)
    }
  }

  const renderFile = (file: GitChangedFile, label: string, depth = 0, treeItem = false): ReactNode => {
    const status = statusLabel(file)
    const searchMatches = allFileMatchCounts.get(file.path)
    const button = (
      <button
        type="button"
        className={`git-diff-file${file.path === selectedFile ? ' selected' : ''}`}
        style={depth ? { paddingLeft: 8 + depth * 14 } : undefined}
        onClick={() => setSelectedFile(file.path)}
        onMouseEnter={(event) => showPathTooltip(file.path, event.currentTarget)}
        onMouseLeave={() => setPathTooltip(null)}
        onFocus={(event) => showPathTooltip(file.path, event.currentTarget)}
        onBlur={() => setPathTooltip(null)}
        aria-describedby={pathTooltip?.path === file.path ? 'git-diff-path-tooltip' : undefined}
      >
        <span className={`git-diff-file-status ${status.className}`} title={status.title}>{status.letter}</span>
        <span className="git-diff-file-path">{label}</span>
        {searchMatches ? <span className="git-diff-file-search-count">{searchMatches}</span> : null}
        <span className="git-diff-file-stats">
          {file.binary
            ? 'bin'
            : file.additions === null
              ? 'new'
              : <><em className="added">+{file.additions}</em> <em className="deleted">-{file.deletions}</em></>}
        </span>
      </button>
    )
    return treeItem
      ? <div className="git-diff-tree-item" role="treeitem" key={file.path}>{button}</div>
      : <div className="git-diff-list-item" key={file.path}>{button}</div>
  }

  const renderFolder = (folder: FileTreeFolder, depth: number): ReactNode => {
    const expanded = forceExpandTree || !collapsedFolders.has(folder.path)
    const folders = [...folder.folders.values()].sort((left, right) => left.name.localeCompare(right.name))
    const folderFiles = [...folder.files].sort((left, right) => fileName(left.path).localeCompare(fileName(right.path)))
    return (
      <div className="git-diff-tree-folder" role="treeitem" aria-expanded={expanded} key={folder.path}>
        <button
          type="button"
          className="git-diff-folder"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => { if (!forceExpandTree) toggleFolder(folder.path) }}
          onMouseEnter={(event) => showPathTooltip(folder.path, event.currentTarget)}
          onMouseLeave={() => setPathTooltip(null)}
          onFocus={(event) => showPathTooltip(folder.path, event.currentTarget)}
          onBlur={() => setPathTooltip(null)}
          aria-label={forceExpandTree
            ? `Folder ${folder.path}, expanded by search`
            : `${expanded ? 'Collapse' : 'Expand'} folder ${folder.path}`}
          aria-describedby={pathTooltip?.path === folder.path ? 'git-diff-path-tooltip' : undefined}
        >
          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          {expanded ? <FolderOpen aria-hidden="true" /> : <FolderClosed aria-hidden="true" />}
          <span>{folder.name}</span>
        </button>
        {expanded ? (
          <div role="group">
            {folders.map((child) => renderFolder(child, depth + 1))}
            {folderFiles.map((file) => renderFile(file, fileName(file.path), depth + 1, true))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="git-diff-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="git-diff-modal" role="dialog" aria-modal="true" aria-labelledby="git-diff-title">
        <header className="git-diff-header">
          <div className="git-diff-heading">
            <span><FileDiff aria-hidden="true" /> Structural diff</span>
            <strong id="git-diff-title" title={summary?.root ?? panePath}>{summary?.root ?? panePath}</strong>
          </div>
          <div className="git-diff-target">
            <span className="git-diff-branch" title="Current branch">{summary?.branch || 'HEAD'}</span>
            <span aria-hidden="true">vs</span>
            <div className="git-diff-target-combo">
              <input
                value={targetDraft}
                onChange={(event) => {
                  setTargetDraft(event.target.value)
                  setDropdownOpen(true)
                  setFiltering(true)
                  setHighlight(0)
                }}
                onKeyDown={onTargetKeyDown}
                onFocus={() => {
                  setDropdownOpen(true)
                  setFiltering(false)
                  setHighlight(0)
                }}
                onClick={() => {
                  setDropdownOpen(true)
                  setFiltering(false)
                  setHighlight(0)
                }}
                onBlur={(event) => {
                  setDropdownOpen(false)
                  applyTarget(event.currentTarget.value)
                }}
                placeholder={summary?.targetMode === 'auto' && summary.target
                  ? `auto - ${summary.target}`
                  : 'auto'}
                role="combobox"
                aria-expanded={dropdownOpen && suggestions.length > 0}
                aria-autocomplete="list"
                aria-controls="git-diff-branch-listbox"
                aria-label="Diff target branch"
                spellCheck={false}
              />
              {dropdownOpen && suggestions.length > 0 ? (
                <ul className="git-diff-branch-list" id="git-diff-branch-listbox" role="listbox" aria-label="Branches">
                  {suggestions.map((branch, index) => (
                    <li key={branch} role="option" aria-selected={branch === (appliedTarget ?? summary?.target)}>
                      <button
                        type="button"
                        tabIndex={-1}
                        className={index === activeHighlight ? 'highlighted' : undefined}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          chooseBranch(branch)
                        }}
                        onMouseEnter={() => setHighlight(index)}
                      >
                        {branch === AUTO_TARGET
                          ? <em className="git-diff-auto-option">auto - branch point</em>
                          : branch}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close diff view"><X /></button>
        </header>
        <div className="git-diff-toolbar">
          <div className="git-diff-segment" role="group" aria-label="Diff engine">
            <button
              type="button"
              className={engine === 'difftastic' ? 'active' : undefined}
              aria-pressed={engine === 'difftastic'}
              onClick={() => chooseEngine('difftastic')}
              title="Structural diff (difftastic)"
            >
              difftastic
            </button>
            <button
              type="button"
              className={engine === 'delta' ? 'active' : undefined}
              aria-pressed={engine === 'delta'}
              onClick={() => chooseEngine('delta')}
              title="Line diff with syntax highlighting (delta)"
            >
              delta
            </button>
          </div>
          <div className="git-diff-segment" role="group" aria-label="Diff layout">
            <button
              type="button"
              className={display === 'side-by-side' ? 'active' : undefined}
              aria-pressed={display === 'side-by-side'}
              onClick={() => chooseDisplay('side-by-side')}
              title="Two-column layout"
            >
              <Columns2 aria-hidden="true" /> side-by-side
            </button>
            <button
              type="button"
              className={display === 'inline' ? 'active' : undefined}
              aria-pressed={display === 'inline'}
              onClick={() => chooseDisplay('inline')}
              title="Single-column layout"
            >
              <Rows3 aria-hidden="true" /> inline
            </button>
          </div>
        </div>
        <div className="git-diff-body" ref={bodyRef}>
          <aside className="git-diff-files" aria-label="Changed files" style={{ width: filePanelWidth }}>
            <header className="git-diff-files-header">
              <span>
                {visibleFiles.length !== files.length ? `${visibleFiles.length} / ` : ''}
                {files.length} {files.length === 1 ? 'file' : 'files'}
              </span>
              <div className="git-diff-file-view-toggle" role="group" aria-label="File view">
                <button
                  type="button"
                  className={fileView === 'tree' ? 'active' : undefined}
                  aria-label="Tree view"
                  aria-pressed={fileView === 'tree'}
                  title="Show folders as a tree"
                  onClick={() => chooseFileView('tree')}
                >
                  <ListTree aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={fileView === 'list' ? 'active' : undefined}
                  aria-label="List view"
                  aria-pressed={fileView === 'list'}
                  title="Show changed files as a flat list"
                  onClick={() => chooseFileView('list')}
                >
                  <List aria-hidden="true" />
                </button>
              </div>
            </header>
            <div className="git-diff-file-filter">
              <Search aria-hidden="true" />
              <input
                type="search"
                value={fileFilter}
                onChange={(event) => setFileFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && fileFilter !== '') {
                    event.preventDefault()
                    event.stopPropagation()
                    setFileFilter('')
                  }
                }}
                placeholder="Filter paths"
                aria-label="Filter changed file paths"
                spellCheck={false}
              />
              {fileFilter ? (
                <button type="button" onClick={() => setFileFilter('')} aria-label="Clear file path filter">
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <div className="git-diff-file-scroll">
              {summaryLoading ? <div className="git-diff-status"><LoaderCircle className="spin" />Loading changes</div> : null}
              {!summaryLoading && summaryError ? <div className="git-diff-error" role="alert">{summaryError}</div> : null}
              {!summaryLoading && !summaryError && files.length === 0
                ? <div className="git-diff-status">No changes vs {summary?.target ?? 'target'}</div>
                : null}
              {!summaryLoading && !summaryError && files.length > 0 && visibleFiles.length === 0
                ? <div className="git-diff-status">No changed files match this search</div>
                : null}
              {!summaryLoading && !summaryError && visibleFiles.length > 0 && fileView === 'tree' ? (
                <div className="git-diff-file-tree" role="tree" aria-label="Changed file tree">
                  {[...fileTree.folders.values()]
                    .sort((left, right) => left.name.localeCompare(right.name))
                    .map((folder) => renderFolder(folder, 0))}
                  {[...fileTree.files]
                    .sort((left, right) => fileName(left.path).localeCompare(fileName(right.path)))
                    .map((file) => renderFile(file, fileName(file.path), 0, true))}
                </div>
              ) : null}
              {!summaryLoading && !summaryError && fileView === 'list'
                ? visibleFiles.map((file) => renderFile(file, file.path))
                : null}
            </div>
          </aside>
          <div
            className="git-diff-files-resizer"
            role="separator"
            aria-label="Resize changed files panel"
            aria-orientation="vertical"
            aria-valuemin={MIN_FILE_PANEL_WIDTH}
            aria-valuemax={maximumFilePanelWidth()}
            aria-valuenow={filePanelWidth}
            aria-valuetext={`${Math.round(filePanelWidth)} pixels wide`}
            tabIndex={0}
            title="Drag to resize; use Left and Right arrows from the keyboard. Double-click to reset."
            onPointerDown={beginFilePanelResize}
            onKeyDown={resizeFilePanelWithKeyboard}
            onDoubleClick={() => changeFilePanelWidth(DEFAULT_FILE_PANEL_WIDTH, true, true)}
          />
          <div className="git-diff-content">
            <div className="git-diff-content-search">
              <div className="git-diff-content-search-input">
                <Search aria-hidden="true" />
                <input
                  ref={diffSearchInputRef}
                  type="search"
                  value={diffSearch}
                  onChange={(event) => {
                    setDiffSearch(event.target.value)
                    setActiveDiffMatch(0)
                  }}
                  onKeyDown={onDiffSearchKeyDown}
                  placeholder={searchScope === 'all' ? 'Search all changed files' : 'Search current diff'}
                  aria-label="Search diff contents"
                  spellCheck={false}
                />
                {diffSearch ? (
                  <button type="button" onClick={() => setDiffSearch('')} aria-label="Clear diff search">
                    <X aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <span
                className={`git-diff-search-status${allSearchError ? ' error' : ''}`}
                role={allSearchError ? 'alert' : 'status'}
              >
                {allSearchLoading
                  ? <><LoaderCircle className="spin" />Searching</>
                  : allSearchError
                    ? allSearchError
                    : searchScope === 'all' && contentQuery && allSearchCurrent && allSearchResult
                      ? <>{diffMatches.length ? `${currentDiffMatch + 1}/${diffMatches.length} here · ` : ''}{allSearchResult.totalMatches} across {allSearchResult.matchingFiles} files{allSearchResult.truncated ? '+' : ''}</>
                      : contentQuery
                        ? `${diffMatches.length ? currentDiffMatch + 1 : 0} / ${diffMatches.length}`
                        : 'Cmd F'}
              </span>
              <button
                type="button"
                className="git-diff-search-nav"
                onClick={() => moveDiffMatch(-1)}
                disabled={!diffMatches.length}
                aria-label="Previous diff match"
                title="Previous match (Shift+Enter)"
              >
                <ChevronUp aria-hidden="true" />
              </button>
              <button
                type="button"
                className="git-diff-search-nav"
                onClick={() => moveDiffMatch(1)}
                disabled={!diffMatches.length}
                aria-label="Next diff match"
                title="Next match (Enter)"
              >
                <ChevronDown aria-hidden="true" />
              </button>
              <div className="git-diff-search-scope" role="group" aria-label="Diff search scope">
                <button
                  type="button"
                  className={searchScope === 'file' ? 'active' : undefined}
                  aria-pressed={searchScope === 'file'}
                  onClick={() => chooseSearchScope('file')}
                >
                  file
                </button>
                <button
                  type="button"
                  className={searchScope === 'all' ? 'active' : undefined}
                  aria-pressed={searchScope === 'all'}
                  onClick={() => chooseSearchScope('all')}
                >
                  all
                </button>
              </div>
            </div>
            <div className="git-diff-output" ref={outputRef}>
              {diffLoading ? <div className="git-diff-status"><LoaderCircle className="spin" />Running difftastic</div> : null}
              {!diffLoading && diffError ? <div className="git-diff-error" role="alert">{diffError}</div> : null}
              {!diffLoading && !diffError && selectedFile && diff.trim() === ''
                ? <div className="git-diff-status">No content changes (permissions or identical after merge base)</div>
                : null}
              {!diffLoading && !diffError && diff.trim() !== ''
                ? <pre><AnsiText text={diff} query={contentQuery} activeMatch={currentDiffMatch} /></pre>
                : null}
            </div>
          </div>
        </div>
      </section>
      {pathTooltip ? (
        <div
          className="git-diff-path-tooltip"
          id="git-diff-path-tooltip"
          role="tooltip"
          style={{ left: pathTooltip.left, top: pathTooltip.top }}
        >
          {pathTooltip.path}
        </div>
      ) : null}
    </div>
  )
}

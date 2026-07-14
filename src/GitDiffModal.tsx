import { FileDiff, LoaderCircle, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { parseAnsi, type AnsiSegment } from './ansi'
import type { GitChangedFile, GitDiffApiClient, GitDiffSummary } from './gitApi'

type Props = {
  paneId: string
  panePath: string
  api: GitDiffApiClient
  initialSummary: GitDiffSummary | null
  onClose(): void
}

const APPROXIMATE_CHARACTER_WIDTH = 7.25

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

export function AnsiText({ text }: { text: string }) {
  const segments = useMemo(() => parseAnsi(text), [text])
  return (
    <>
      {segments.map((segment, index) => (
        <span
          key={index}
          className={segmentClassName(segment)}
          style={{
            ...(typeof segment.foreground === 'string' ? { color: segment.foreground } : {}),
            ...(typeof segment.background === 'string' ? { backgroundColor: segment.background } : {}),
          }}
        >
          {segment.text}
        </span>
      ))}
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
  const [targetDraft, setTargetDraft] = useState(initialSummary?.target ?? '')
  const [appliedTarget, setAppliedTarget] = useState<string | undefined>(undefined)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [diffError, setDiffError] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const apiRef = useRef(api)
  apiRef.current = api
  const outputRef = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const diffGeneration = useRef(0)

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  useEffect(() => {
    const request = ++generation.current
    setSummaryLoading(true)
    setSummaryError('')
    apiRef.current
      .summary(paneId, appliedTarget)
      .then((next) => {
        if (request !== generation.current) return
        setSummary(next)
        setTargetDraft((draft) => draft || next.target || '')
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
      .fileDiff(paneId, selectedFile, appliedTarget, width)
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
  }, [paneId, appliedTarget, selectedFile])

  const applyTarget = () => {
    const next = targetDraft.trim()
    setAppliedTarget(next === '' ? undefined : next)
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
            <input
              value={targetDraft}
              onChange={(event) => setTargetDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') applyTarget() }}
              onBlur={applyTarget}
              placeholder="main"
              aria-label="Diff target branch"
              spellCheck={false}
            />
          </div>
          <button type="button" onClick={onClose} aria-label="Close diff view"><X /></button>
        </header>
        <div className="git-diff-body">
          <aside className="git-diff-files" aria-label="Changed files">
            {summaryLoading ? <div className="git-diff-status"><LoaderCircle className="spin" />Loading changes</div> : null}
            {!summaryLoading && summaryError ? <div className="git-diff-error" role="alert">{summaryError}</div> : null}
            {!summaryLoading && !summaryError && summary?.target === null
              ? <div className="git-diff-status">No main or master branch found. Enter a target branch above.</div>
              : null}
            {!summaryLoading && !summaryError && summary?.target !== null && files.length === 0
              ? <div className="git-diff-status">No changes vs {summary?.target ?? 'target'}</div>
              : null}
            {!summaryLoading && !summaryError ? files.map((file) => {
              const status = statusLabel(file)
              return (
                <button
                  type="button"
                  key={file.path}
                  className={`git-diff-file${file.path === selectedFile ? ' selected' : ''}`}
                  onClick={() => setSelectedFile(file.path)}
                  title={file.path}
                >
                  <span className={`git-diff-file-status ${status.className}`} title={status.title}>{status.letter}</span>
                  <span className="git-diff-file-path">{file.path}</span>
                  <span className="git-diff-file-stats">
                    {file.binary
                      ? 'bin'
                      : file.additions === null
                        ? 'new'
                        : <><em className="added">+{file.additions}</em> <em className="deleted">-{file.deletions}</em></>}
                  </span>
                </button>
              )
            }) : null}
          </aside>
          <div className="git-diff-output" ref={outputRef}>
            {diffLoading ? <div className="git-diff-status"><LoaderCircle className="spin" />Running difftastic</div> : null}
            {!diffLoading && diffError ? <div className="git-diff-error" role="alert">{diffError}</div> : null}
            {!diffLoading && !diffError && selectedFile && diff.trim() === ''
              ? <div className="git-diff-status">No content changes (permissions or identical after merge base)</div>
              : null}
            {!diffLoading && !diffError && diff.trim() !== ''
              ? <pre><AnsiText text={diff} /></pre>
              : null}
          </div>
        </div>
      </section>
    </div>
  )
}

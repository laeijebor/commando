import type { GitChangedFile, GitDiffSummary } from '../daemon/paneApi'

/**
 * `GET /api/git/summary` shaped for the Changes section: one header line and
 * one row per file, with the same "+a −d" reading the desktop's git stats use.
 */

export type GitFileRow = {
  path: string
  /** Trailing path segment, which is what fits on a phone. */
  name: string
  /** Everything before the file name, without the trailing slash. */
  directory: string
  status: string
  additions: number | null
  deletions: number | null
  binary: boolean
}

export type GitSummaryView = {
  isRepo: boolean
  branch?: string
  /** What the diff is against, e.g. `origin/main`; null when the daemon found none. */
  target?: string | null
  additions: number
  deletions: number
  fileCount: number
  rows: GitFileRow[]
  pullRequest?: GitDiffSummary['pullRequest']
}

export function gitSummaryView(summary: GitDiffSummary | null): GitSummaryView | null {
  if (!summary) return null
  const files = summary.files ?? []
  return {
    isRepo: summary.isRepo,
    ...(summary.branch ? { branch: summary.branch } : {}),
    ...(summary.target === undefined ? {} : { target: summary.target }),
    additions: summary.additions ?? 0,
    deletions: summary.deletions ?? 0,
    fileCount: files.length,
    rows: files.map(fileRow),
    ...(summary.pullRequest ? { pullRequest: summary.pullRequest } : {}),
  }
}

function fileRow(file: GitChangedFile): GitFileRow {
  const separator = file.path.lastIndexOf('/')
  return {
    path: file.path,
    name: separator === -1 ? file.path : file.path.slice(separator + 1),
    directory: separator === -1 ? '' : file.path.slice(0, separator),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
  }
}

export type DiffLineKind = 'added' | 'removed' | 'hunk' | 'meta' | 'context'

export type DiffLine = { kind: DiffLineKind; text: string }

/**
 * The daemon returns whatever difftastic or delta printed, so the viewer keeps
 * it monospaced and only colours the unified-diff markers it can recognise.
 */
export function parseDiffLines(diff: string): DiffLine[] {
  return diff.split(/\r?\n/u).map((text): DiffLine => {
    if (text.startsWith('@@')) return { kind: 'hunk', text }
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ')) {
      return { kind: 'meta', text }
    }
    if (text.startsWith('+')) return { kind: 'added', text }
    if (text.startsWith('-')) return { kind: 'removed', text }
    return { kind: 'context', text }
  })
}

/** `+212 −48 · 6 files · ⎇ branch` — the mockup's Changes header. */
export function changesHeadline(view: GitSummaryView): string {
  const files = `${view.fileCount} ${view.fileCount === 1 ? 'file' : 'files'}`
  const branch = view.branch ? ` · ⎇ ${view.branch}` : ''
  return `+${view.additions} −${view.deletions} · ${files}${branch}`
}

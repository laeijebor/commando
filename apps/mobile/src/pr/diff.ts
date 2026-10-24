import type { PrRemoteDiff } from '@commando/pr-quick-look'

/**
 * GitHub's per-file patches (`GET /api/prs/diff`) shaped for the phone: one
 * row per file for the list, and numbered lines for a file once it is opened.
 */

export type PrDiffFile = PrRemoteDiff['files'][number]

export type PrFileRow = {
  path: string
  /** Trailing path segment, which is what fits on a phone. */
  name: string
  /** Everything before the file name, without the trailing slash. */
  directory: string
  status: string
  /** One letter for the status column: A, D, R, C or M. */
  badge: 'A' | 'D' | 'R' | 'C' | 'M'
  additions: number
  deletions: number
  patch: string | null
}

export type PatchLineKind = 'add' | 'del' | 'context' | 'hunk' | 'note'

export type PatchLine = {
  kind: PatchLineKind
  text: string
  oldLine: number | null
  newLine: number | null
}

/** How many lines of one file are drawn before "Show more", so a generated file can't stall the list. */
export const PATCH_CHUNK = 300

const BADGES: Record<string, PrFileRow['badge']> = { added: 'A', removed: 'D', renamed: 'R', copied: 'C' }

export function prFileRows(diff: PrRemoteDiff | null | undefined): PrFileRow[] {
  return (diff?.files ?? []).map((file) => {
    const separator = file.path.lastIndexOf('/')
    return {
      path: file.path,
      name: separator === -1 ? file.path : file.path.slice(separator + 1),
      directory: separator === -1 ? '' : file.path.slice(0, separator),
      status: file.status,
      badge: BADGES[file.status] ?? 'M',
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    }
  })
}

export function prDiffTotals(diff: PrRemoteDiff | null | undefined): { files: number; additions: number; deletions: number } {
  const files = diff?.files ?? []
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * A unified patch as numbered lines. GitHub's patches start at the first hunk
 * header; anything before one (a `diff --git` preamble) is kept as a note so a
 * hand-written patch still draws.
 */
export function parsePatch(patch: string): PatchLine[] {
  const lines: PatchLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const rows = patch.split(/\r?\n/u)
  // A patch's trailing newline is not a line of its own.
  if (rows.length > 1 && rows.at(-1) === '') rows.pop()
  for (const raw of rows) {
    const text = raw.replace(/\t/gu, '  ')
    const hunk = HUNK.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      lines.push({ kind: 'hunk', text, oldLine: null, newLine: null })
    } else if (!inHunk || raw.startsWith('\\')) {
      lines.push({ kind: 'note', text, oldLine: null, newLine: null })
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text, oldLine: null, newLine: newLine++ })
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text, oldLine: oldLine++, newLine: null })
    } else {
      lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return lines
}

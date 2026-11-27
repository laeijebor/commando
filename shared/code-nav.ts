/**
 * Code navigation from the diff viewer: go to definition, references and callers of a symbol.
 *
 * A request names a position in one side of a diff, by that side's rev: `'worktree'` for the files
 * on disk, or a full commit SHA. The daemon answers precisely with a language server when the files
 * on disk are the ones shown (and a server handles the language), and otherwise with name matches
 * from `git grep` at that rev.
 */

export type CodeNavKind = 'definition' | 'references' | 'callers'

export const CODE_NAV_KINDS: readonly CodeNavKind[] = ['definition', 'references', 'callers']

export type CodeNavRequest = {
  kind: CodeNavKind
  /** Repo-relative path of the file the symbol was clicked in. */
  file: string
  /** `'worktree'` or a full commit SHA: the rev of the diff side that was clicked. */
  rev: string
  /** 1-based line in that side's file. */
  line: number
  /** 0-based UTF-16 offset of the symbol's first character within the line. */
  character: number
  /** The clicked token's text; the text search looks it up as a whole word. */
  symbol: string
}

export type CodeNavLocation = {
  /** Repo-relative path. */
  file: string
  /** 1-based line. */
  line: number
  /** 0-based UTF-16 offset of the match within the line. */
  character: number
  endLine?: number
  endCharacter?: number
  /** The line's text, trimmed of indentation and capped in length. */
  preview: string
  /** Enclosing function or class, when the engine knows it (callers always have one). */
  container?: string
}

export type CodeNavResult = {
  kind: CodeNavKind
  /** `'language-server'` results are precise; `'text'` results are whole-word name matches. */
  source: 'language-server' | 'text'
  /** Rev the locations' files and lines refer to: `'worktree'` or a full commit SHA. */
  rev: string
  locations: CodeNavLocation[]
  /** More matches existed than were returned. */
  truncated: boolean
  /** Why the result is text matches, or other context worth showing, e.g. "Language server starting". */
  note?: string
}

/** One file at a rev, for the peek preview. */
export type CodeNavFile = {
  file: string
  rev: string
  contents: string | null
  /** Set (and contents null) when the file is binary, too large, or absent at that rev. */
  unavailable?: 'binary' | 'too-large' | 'missing'
}

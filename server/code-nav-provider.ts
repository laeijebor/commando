import type { CodeNavKind } from '../shared/code-nav.js'

/** A precise answer from a language server, in absolute paths; the service makes them repo-relative. */
export type PreciseLocation = {
  /** Absolute path. Locations outside the repository are dropped by the service. */
  path: string
  /** 1-based line. */
  line: number
  /** 0-based UTF-16 offset. */
  character: number
  endLine?: number
  endCharacter?: number
  /** The line's text when the server reports it; otherwise the service reads it. */
  preview?: string
  container?: string
}

export type PreciseQuery = {
  /** Absolute worktree root the server should be scoped to. */
  root: string
  kind: CodeNavKind
  /** Absolute path of the file the symbol is in, read from disk. */
  path: string
  /** 1-based line. */
  line: number
  /** 0-based UTF-16 offset. */
  character: number
}

/**
 * A language-server-backed engine (e.g. tsserver). It only ever sees files on disk, so the service
 * calls it only for the worktree side, or a SHA that matches the worktree's HEAD and an unmodified file.
 */
export interface PreciseNavProvider {
  /** Human name used in notes, e.g. "TypeScript". */
  readonly name: string
  /** Whether this provider handles a file, by its repo-relative path. */
  handles(relativePath: string): boolean
  /**
   * Answers a query, starting a server for `root` if needed. Rejects with
   * `PreciseNavUnavailable` when it can't answer (starting, crashed, timed out, unsupported),
   * so the service falls back to text matches with that reason as the note.
   */
  query(query: PreciseQuery): Promise<PreciseLocation[]>
  /** Stops every server it started (daemon shutdown). */
  dispose(): Promise<void>
}

export class PreciseNavUnavailable extends Error {}

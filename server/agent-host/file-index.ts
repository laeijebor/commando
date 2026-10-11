import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatFileEntry, ChatFileSearchResult } from '../../shared/agent-chat.js'

/** Folders a plain walk never enters (git repos use .gitignore instead). */
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'coverage', 'Pods', 'DerivedData',
  '.DS_Store', '.Trash', 'Library',
])
const MAX_FILES = 50_000
const MAX_WALK_DEPTH = 12
/** An index older than this is rebuilt when the next search arrives. */
const MAX_INDEX_AGE_MS = 10_000
const RESULT_LIMIT = 50

type Index = { entries: ChatFileEntry[]; truncated: boolean; builtAt: number }

export interface FileIndexOptions {
  maxFiles?: number
  maxAgeMs?: number
  now?: () => number
  /** Lists tracked plus untracked, non-ignored files; null outside a git repo. */
  listGitFiles?: (cwd: string) => Promise<string[] | null>
}

/** `git ls-files` with untracked files that .gitignore keeps; null when cwd is not in a repo. */
export function listGitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      resolve([...new Set(stdout.split('\0').filter(Boolean))])
    })
  })
}

async function walk(cwd: string, maxFiles: number): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  let queue: { path: string; depth: number }[] = [{ path: '', depth: 0 }]
  while (queue.length) {
    const next: typeof queue = []
    for (const directory of queue) {
      let entries
      try {
        entries = await readdir(join(cwd, directory.path), { withFileTypes: true })
      } catch {
        continue
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const path = directory.path ? `${directory.path}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name) && directory.depth < MAX_WALK_DEPTH) next.push({ path, depth: directory.depth + 1 })
        } else if (entry.isFile()) {
          files.push(path)
          if (files.length >= maxFiles) return { files, truncated: true }
        }
        // Symlinks are skipped: they can loop or lead out of the folder.
      }
    }
    queue = next
  }
  return { files, truncated: false }
}

/** Files plus every folder above them, folders marked with a trailing slash. */
export function entriesFor(files: readonly string[]): ChatFileEntry[] {
  const directories = new Set<string>()
  for (const file of files) {
    let slash = file.indexOf('/')
    while (slash !== -1) {
      directories.add(`${file.slice(0, slash)}/`)
      slash = file.indexOf('/', slash + 1)
    }
  }
  return [
    ...[...directories].map((path) => ({ path, kind: 'directory' as const })),
    ...files.map((path) => ({ path, kind: 'file' as const })),
  ]
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1]
  return previous === '/' || previous === '-' || previous === '_' || previous === '.' || previous === ' '
}

/**
 * How well `query` matches `path` (higher is better), or null when it does
 * not: substring matches beat scattered ones, and matches in the file or
 * folder name beat matches higher up the path.
 */
export function matchScore(query: string, path: string): number | null {
  const lowerPath = path.toLowerCase()
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const nameStart = trimmed.lastIndexOf('/') + 1
  const name = lowerPath.slice(nameStart, trimmed.length)
  const lengthPenalty = path.length / 100
  const substring = lowerPath.indexOf(query)
  if (substring !== -1) {
    let score = 1000 - substring / 10
    if (name.startsWith(query)) score += 500
    else if (name.includes(query)) score += 300
    if (isBoundary(lowerPath, substring)) score += 100
    return score - lengthPenalty
  }
  // Characters in order, rewarded for landing on word starts and staying together.
  let score = 0
  let position = 0
  let previous = -2
  for (const char of query) {
    const found = lowerPath.indexOf(char, position)
    if (found === -1) return null
    score += found === previous + 1 ? 8 : isBoundary(lowerPath, found) ? 6 : 1
    if (found >= nameStart) score += 2
    previous = found
    position = found + 1
  }
  return score - lengthPenalty
}

/**
 * The `@` mention index for one session folder: `git ls-files` (tracked and
 * untracked, minus ignored files) inside a repo, a capped walk elsewhere.
 * Built on the first search and rebuilt on demand once it is a few seconds old.
 */
export class WorkspaceFileIndex {
  private index: Index | null = null
  private building: Promise<Index> | null = null
  private readonly maxFiles: number
  private readonly maxAgeMs: number
  private readonly now: () => number
  private readonly listGit: (cwd: string) => Promise<string[] | null>

  constructor(private readonly cwd: string, options: FileIndexOptions = {}) {
    this.maxFiles = options.maxFiles ?? MAX_FILES
    this.maxAgeMs = options.maxAgeMs ?? MAX_INDEX_AGE_MS
    this.now = options.now ?? Date.now
    this.listGit = options.listGitFiles ?? listGitFiles
  }

  async search(rawQuery: string, limit = RESULT_LIMIT): Promise<ChatFileSearchResult> {
    const index = await this.current()
    const query = rawQuery.replace(/^\.\//, '').toLowerCase()
    if (!query) {
      // Nothing typed yet: the top level, folders first.
      const top = index.entries.filter((entry) => !entry.path.slice(0, -1).includes('/'))
        .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'directory' ? -1 : 1))
      return { entries: top.slice(0, limit), truncated: index.truncated || top.length > limit }
    }
    const scored: { entry: ChatFileEntry; score: number }[] = []
    for (const entry of index.entries) {
      const score = matchScore(query, entry.path)
      if (score !== null) scored.push({ entry, score })
    }
    scored.sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    return { entries: scored.slice(0, limit).map(({ entry }) => entry), truncated: index.truncated || scored.length > limit }
  }

  private async current(): Promise<Index> {
    if (this.index && this.now() - this.index.builtAt < this.maxAgeMs) return this.index
    // Searches typed while a build runs share it.
    this.building ??= this.build().finally(() => { this.building = null })
    this.index = await this.building
    return this.index
  }

  private async build(): Promise<Index> {
    const git = await this.listGit(this.cwd)
    const listed = git ? { files: git.slice(0, this.maxFiles), truncated: git.length > this.maxFiles } : await walk(this.cwd, this.maxFiles)
    return { entries: entriesFor(listed.files), truncated: listed.truncated, builtAt: this.now() }
  }
}

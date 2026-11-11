/**
 * Diff file filters: hide test files and generated files from the changed-file
 * list. The two switches and each repo's generated patterns are saved by the
 * daemon and shared by every Commando window.
 */

export type DiffFilters = {
  hideTests: boolean
  hideGenerated: boolean
  /** Generated-file patterns by main checkout root; a saved list replaces that repo's built-in one. */
  generatedByRepo: Record<string, string[]>
}

/** One change to the filters; absent fields stay as they are. */
export type DiffFiltersChange = {
  hideTests?: boolean
  hideGenerated?: boolean
  /** Saves a repo's generated patterns; `patterns: null` goes back to its built-in list. */
  repo?: { root: string; patterns: string[] | null }
}

export const DEFAULT_DIFF_FILTERS: DiffFilters = { hideTests: false, hideGenerated: false, generatedByRepo: {} }

export const MAX_DIFF_FILTER_REPOS = 200
export const MAX_GENERATED_PATTERNS = 200
export const MAX_GENERATED_PATTERN_LENGTH = 500

/**
 * Test files across the repos in use: `*.test.*` / `*.spec.*` (including
 * `.unit.test.ts`, `.integration.test.ts`), pytest, Go and XCTest names, and
 * anything inside a test folder.
 */
const TEST_FILE = /(?:^|\/)(?:[^/]*\.(?:test|spec)\.[^/]+|test_[^/]*\.py|[^/]*_test\.(?:py|go)|conftest\.py|[^/]*Tests\.swift)$/
const TEST_FOLDER = /(?:^|\/)(?:__tests__|__mocks__|__snapshots__|tests?|Tests|e2e|fixtures|[^/]+-tests)\//

export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path) || TEST_FOLDER.test(path)
}

/** Generated in every repo, on top of the repo's own list. */
export const COMMON_GENERATED_PATTERNS: readonly string[] = [
  '*.gen.*',
  '*.generated.*',
  'generated/',
  '__generated__/',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'uv.lock',
  'poetry.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'go.sum',
  '*.min.js',
  '*.min.css',
]

/** Built-in lists by repo folder name, used until a repo's list is saved. */
export const BUILT_IN_REPO_GENERATED: Readonly<Record<string, readonly string[]>> = {
  'Save-All': [
    'drizzle/',
    '**/src/client/core/',
    '**/src/client/client/',
    'workers/*/schema.json',
  ],
  vivifit: [
    'drizzle*/',
    'packages/storybook/storybook-static/',
    // A Next.js route named "generated", not generated code.
    '!apps-fe/teaser/src/app/document-templates/generated/',
  ],
}

/** The repo's own generated patterns: its saved list, else the built-in one for its folder name. */
export function repoGeneratedPatterns(filters: DiffFilters, root: string | undefined, name: string | undefined): readonly string[] {
  if (root && filters.generatedByRepo[root]) return filters.generatedByRepo[root]
  return (name && BUILT_IN_REPO_GENERATED[name]) || []
}

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
const segmentSource = (segment: string) => segment.split('*').map((part) => part.split('?').map(escape).join('[^/]')).join('[^/]*')

/**
 * Compiles a gitignore-style pattern against repo-relative paths. A pattern
 * without a slash matches a name at any depth; one with a slash starts at the
 * repo root; `**` spans folders; a trailing slash matches only folders.
 * A leading `!` is handled by `generatedMatcher`, not here.
 */
export function compileGeneratedPattern(pattern: string): RegExp | null {
  let glob = pattern.trim()
  if (!glob || glob.startsWith('#')) return null
  const folder = glob.endsWith('/')
  glob = glob.replace(/\/+$/, '')
  const rooted = glob.startsWith('/')
  glob = glob.replace(/^\/+/, '')
  if (!glob) return null
  const anchored = rooted || glob.includes('/')
  const segments = glob.split('/')
  const body = segments.map((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') return last ? '.*' : '(?:[^/]+/)*'
    return segmentSource(segment) + (last ? '' : '/')
  }).join('')
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}${folder ? '/' : '(?:$|/)'}`)
}

/** A matcher for the common patterns plus the repo's own; a `!pattern` exempts what it matches. */
export function generatedMatcher(patterns: readonly string[]): (path: string) => boolean {
  const include: RegExp[] = [], exempt: RegExp[] = []
  for (const pattern of [...COMMON_GENERATED_PATTERNS, ...patterns]) {
    const negated = pattern.trim().startsWith('!')
    const regex = compileGeneratedPattern(negated ? pattern.trim().slice(1) : pattern)
    if (regex) (negated ? exempt : include).push(regex)
  }
  return (path) => include.some((regex) => regex.test(path)) && !exempt.some((regex) => regex.test(path))
}

const controls = /[\u0000-\u001f\u007f]/

/** Trims, drops blanks and duplicates, and rejects patterns that are too long or contain control characters. */
export function normalizeGeneratedPatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_GENERATED_PATTERNS) throw new Error(`patterns must be a list of at most ${MAX_GENERATED_PATTERNS}`)
  const patterns: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > MAX_GENERATED_PATTERN_LENGTH || controls.test(entry)) {
      throw new Error(`Each pattern must be text up to ${MAX_GENERATED_PATTERN_LENGTH} characters`)
    }
    const pattern = entry.trim()
    if (pattern && !patterns.includes(pattern)) patterns.push(pattern)
  }
  return patterns
}

const isRepoRoot = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !controls.test(value)

/** Parses a change request; throws a readable error on bad input. */
export function parseDiffFiltersChange(value: unknown): DiffFiltersChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  const record = value as Record<string, unknown>
  const change: DiffFiltersChange = {}
  for (const key of ['hideTests', 'hideGenerated'] as const) {
    if (record[key] === undefined) continue
    if (typeof record[key] !== 'boolean') throw new Error(`${key} must be true or false`)
    change[key] = record[key]
  }
  if (record.repo !== undefined) {
    const repo = record.repo as Record<string, unknown> | null
    if (!repo || typeof repo !== 'object' || !isRepoRoot(repo.root)) throw new Error('repo.root must be an absolute repository root')
    change.repo = { root: repo.root, patterns: repo.patterns === null ? null : normalizeGeneratedPatterns(repo.patterns) }
  }
  return change
}

/** Reads saved filters leniently: bad fields fall back to defaults instead of failing. */
export function parseDiffFilters(value: unknown): DiffFilters {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const generatedByRepo: Record<string, string[]> = {}
  const repos = record.generatedByRepo && typeof record.generatedByRepo === 'object' && !Array.isArray(record.generatedByRepo)
    ? Object.entries(record.generatedByRepo as Record<string, unknown>) : []
  for (const [root, patterns] of repos.slice(0, MAX_DIFF_FILTER_REPOS)) {
    if (!isRepoRoot(root)) continue
    try { generatedByRepo[root] = normalizeGeneratedPatterns(patterns) } catch { /* Skip a corrupt entry. */ }
  }
  return { hideTests: record.hideTests === true, hideGenerated: record.hideGenerated === true, generatedByRepo }
}

export function applyDiffFiltersChange(filters: DiffFilters, change: DiffFiltersChange): DiffFilters {
  const next: DiffFilters = { ...filters, generatedByRepo: { ...filters.generatedByRepo } }
  if (change.hideTests !== undefined) next.hideTests = change.hideTests
  if (change.hideGenerated !== undefined) next.hideGenerated = change.hideGenerated
  if (change.repo) {
    if (change.repo.patterns === null) delete next.generatedByRepo[change.repo.root]
    else {
      if (!(change.repo.root in next.generatedByRepo) && Object.keys(next.generatedByRepo).length >= MAX_DIFF_FILTER_REPOS) {
        throw new Error(`Generated patterns are saved for at most ${MAX_DIFF_FILTER_REPOS} repos`)
      }
      next.generatedByRepo[change.repo.root] = change.repo.patterns
    }
  }
  return next
}

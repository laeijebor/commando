import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  CODE_NAV_KINDS,
  type CodeNavFile,
  type CodeNavKind,
  type CodeNavLocation,
  type CodeNavRequest,
  type CodeNavResult,
} from '../shared/code-nav.js'
import { PreciseNavUnavailable, type PreciseLocation, type PreciseNavProvider } from './code-nav-provider.js'
import {
  COMMIT_SHA,
  GitCommandFailure,
  GitDiffError,
  GitDiffInspector,
  MAX_FILE_CONTENTS_BYTES,
  UNKNOWN_OBJECT,
  gitFailure,
  type FileSource,
} from './git-diff.js'

/** Most locations returned for one request. */
export const MAX_NAV_LOCATIONS = 200
const MAX_SYMBOL_LENGTH = 200
const MAX_PREVIEW_LENGTH = 240
/** Longer lines are previewed but not matched against the declaration patterns. */
const MAX_MATCHED_LINE_LENGTH = 2_000
const GREP_TIMEOUT_MS = 20_000
const GREP_BUFFER_BYTES = 32 * 1024 * 1024
/** Files read to find the enclosing function of text callers. */
const MAX_CONTAINER_FILES = 50
const MAX_CONTAINER_SCAN_LINES = 400
const NUL = '\u0000'
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u
const IDENTIFIER = /^[\p{L}\p{N}_$]+$/u
const WORD = '[\\p{L}\\p{N}_$]'
const NAME = `${WORD}+`
const FALLBACK_SUFFIX = ' — showing name matches'

/** Words that may precede a declaration keyword (TS/JS, Swift, Rust, Kotlin-ish modifiers). */
const MODIFIERS = [
  'export', 'default', 'async', 'abstract', 'declare', 'public', 'private', 'protected', 'static', 'readonly',
  'override', 'pub(?:\\([^)]*\\))?', 'fileprivate', 'internal', 'open', 'final', 'mutating', 'indirect', 'lazy',
  'weak', 'unowned', 'nonisolated', 'unsafe', 'extern(?:\\s+"[^"]*")?', '@\\w+(?:\\([^)]*\\))?',
]
/** Keywords that declare the name right after them, across the supported languages. */
const KEYWORDS = [
  'function\\*?', 'class', 'interface', 'type', 'enum', 'const', 'let', 'var', 'namespace', 'module', 'declare',
  'def', 'func', 'struct', 'protocol', 'extension', 'typealias', 'case', 'actor', 'fn', 'trait', 'static', 'mod',
  'union',
]
const MEMBER_MODIFIERS = '(?:(?:static|public|private|protected|readonly|async|get|set|override|abstract|declare)\\s+)*'
const TYPE_ARGUMENTS = '(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>)?'
/** Lines that look like `name(...) {` but are control flow. */
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'with', 'elif', 'until', 'unless', 'when'])
/** Variable keywords only name a container when they hold a function. */
const VARIABLE_KEYWORDS = new Set(['const', 'let', 'var'])

export type CodeNavQuery = Record<keyof CodeNavRequest, string | null>

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Patterns whose `name` group is a declared name; `SYMBOL` is substituted per request. */
function declarationPatterns(name: string): RegExp[] {
  const modifiers = `(?:(?:${MODIFIERS.join('|')})\\s+)*`
  const keywords = `(?:${KEYWORDS.join('|')})`
  const end = `(?!${WORD})`
  return [
    // `export async function name`, `declare const enum name`, `def name`, `pub fn name`, `static mut NAME`.
    new RegExp(`^\\s*${modifiers}(?:${keywords}\\s+)*${keywords}\\s+(?:\\*\\s*)?(?:mut\\s+)?(?:self\\.)?(?<name>${name})${end}`, 'u'),
    // Go methods: `func (r *T) name`.
    new RegExp(`^\\s*func\\s+\\([^)]*\\)\\s*(?<name>${name})${end}`, 'u'),
    // Rust: `impl name`, `impl<T> Trait for name`.
    new RegExp(`^\\s*impl${TYPE_ARGUMENTS}\\s+(?:[\\w:]+${TYPE_ARGUMENTS}\\s+for\\s+)?(?<name>${name})${end}`, 'u'),
    // Methods and signatures: `async name<T>(a: A): R {`, `name(a: A): R`, `name() {`.
    new RegExp(`^\\s*${MEMBER_MODIFIERS}\\*?#?(?<name>${name})\\??\\s*${TYPE_ARGUMENTS}\\s*\\(.*\\)\\s*(?::.*|\\{\\s*)$`, 'u'),
    // A modified method whose parameter list continues on the next line: `async name(`.
    new RegExp(`^\\s*${MEMBER_MODIFIERS.replace(/\*$/u, '+')}\\*?#?(?<name>${name})\\s*${TYPE_ARGUMENTS}\\s*\\(\\s*$`, 'u'),
    // Properties: `name: T`, `name = value`, `readonly name?: T = value`.
    new RegExp(`^\\s*${MEMBER_MODIFIERS}#?(?<name>${name})[?!]?\\s*(?::(?!:)|=(?![=>]))`, 'u'),
  ]
}

const GENERIC_DECLARATIONS = declarationPatterns(NAME)

function isDeclaration(line: string, patterns: readonly RegExp[]): boolean {
  if (line.length > MAX_MATCHED_LINE_LENGTH) return false
  return patterns.some((pattern) => pattern.test(line))
}

function preview(line: string): string {
  return line.replace(/\r$/u, '').trimStart().slice(0, MAX_PREVIEW_LENGTH).trimEnd()
}

function indentation(line: string): number {
  return /^\s*/u.exec(line)![0].length
}

/** The function or class a line sits in: the nearest less-indented declaration above it. */
function enclosingName(lines: readonly string[], index: number): string | undefined {
  const own = indentation(lines[index] ?? '')
  const stop = Math.max(0, index - MAX_CONTAINER_SCAN_LINES)
  let limit = own
  for (let cursor = index - 1; cursor >= stop && limit > 0; cursor -= 1) {
    const line = lines[cursor]!
    if (line.trim().length === 0) continue
    const depth = indentation(line)
    if (depth >= limit) continue
    // A closing bracket (`): R {` ending a parameter list) belongs to a header at its own depth.
    limit = /^\s*[)\]}]/u.test(line) ? depth + 1 : depth
    if (line.length > MAX_MATCHED_LINE_LENGTH) continue
    // Every pattern but the last (properties) can name a function or class.
    for (const pattern of GENERIC_DECLARATIONS.slice(0, -1)) {
      const name = pattern.exec(line)?.groups?.name
      if (!name || CONTROL_WORDS.has(name)) continue
      const keyword = /^\s*(?:export\s+)?(\w+)/u.exec(line)?.[1]
      if (keyword && VARIABLE_KEYWORDS.has(keyword) && !/=>|function/u.test(line)) continue
      return name
    }
  }
  return undefined
}

type GrepMatch = { file: string; line: number; character: number; text: string }

/**
 * Parses `git grep -n --column -z` output: `path NUL line NUL byte-column NUL text LF` per match.
 * Paths are read up to their NUL, so colons and newlines in them survive; a `<sha>:` prefix is removed.
 */
export function parseGrepOutput(output: string, sha?: string): GrepMatch[] {
  const prefix = sha ? `${sha}:` : ''
  const matches: GrepMatch[] = []
  let cursor = 0
  while (cursor < output.length) {
    const pathEnd = output.indexOf(NUL, cursor)
    const lineEnd = pathEnd < 0 ? -1 : output.indexOf(NUL, pathEnd + 1)
    const columnEnd = lineEnd < 0 ? -1 : output.indexOf(NUL, lineEnd + 1)
    if (columnEnd < 0) break
    let textEnd = output.indexOf('\n', columnEnd + 1)
    if (textEnd < 0) textEnd = output.length
    let file = output.slice(cursor, pathEnd)
    if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length)
    const line = Number(output.slice(pathEnd + 1, lineEnd))
    const column = Number(output.slice(lineEnd + 1, columnEnd))
    const text = output.slice(columnEnd + 1, textEnd)
    cursor = textEnd + 1
    if (!file || !Number.isInteger(line) || line < 1) continue
    // git reports a 1-based byte offset; the contract wants a UTF-16 offset.
    const character = Number.isInteger(column) && column >= 1
      ? Buffer.from(text, 'utf8').subarray(0, column - 1).toString('utf8').length
      : 0
    matches.push({ file, line, character, text })
  }
  return matches
}

function shortSha(rev: string): string {
  return rev.slice(0, 8)
}

function withSuffix(reason: string): string {
  return `${reason.trim().replace(/\.$/u, '')}${FALLBACK_SUFFIX}`
}

function joinNotes(...notes: (string | undefined)[]): string | undefined {
  const present = notes.filter((note): note is string => Boolean(note))
  return present.length > 0 ? present.join('. ') : undefined
}

const LANGUAGE_FAMILIES: Record<string, string> = {
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', vue: 'js', svelte: 'js',
  py: 'py', pyi: 'py', go: 'go', swift: 'swift', rs: 'rs', rb: 'rb', java: 'jvm', kt: 'jvm', kts: 'jvm', scala: 'jvm',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', m: 'c', mm: 'c', cs: 'cs', php: 'php',
}
/** Prose mentions a name without declaring or calling it. */
const PROSE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/iu

function languageOf(file: string): string | undefined {
  const extension = /\.([^./]+)$/u.exec(file)?.[1]?.toLowerCase()
  return extension ? LANGUAGE_FAMILIES[extension] : undefined
}

/** The clicked file first, then files in its language, then the rest, each in git grep's order. */
function clickedFileFirst<T extends { file: string }>(items: readonly T[], file: string): T[] {
  const language = languageOf(file)
  const rank = (item: T) => item.file === file ? 0 : language && languageOf(item.file) === language ? 1 : 2
  return items.map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item)
}

/** Checks every parameter but the file, which needs the repository root. */
export function validateCodeNavQuery(query: CodeNavQuery): Omit<CodeNavRequest, 'file'> & { file: string | null } {
  const kind = query.kind
  if (!kind || !(CODE_NAV_KINDS as readonly string[]).includes(kind)) {
    throw new GitDiffError('bad-param', `kind must be one of ${CODE_NAV_KINDS.join(', ')}`)
  }
  const rev = query.rev
  if (rev !== 'worktree' && !(typeof rev === 'string' && COMMIT_SHA.test(rev))) {
    throw new GitDiffError('bad-param', 'rev must be "worktree" or a full commit SHA')
  }
  const line = query.line !== null && /^\d{1,9}$/u.test(query.line) ? Number(query.line) : Number.NaN
  if (!Number.isInteger(line) || line < 1) throw new GitDiffError('bad-param', 'line must be an integer of at least 1')
  const character = query.character !== null && /^\d{1,9}$/u.test(query.character) ? Number(query.character) : Number.NaN
  if (!Number.isInteger(character) || character < 0) {
    throw new GitDiffError('bad-param', 'character must be an integer of at least 0')
  }
  const symbol = query.symbol
  if (!symbol || symbol.length > MAX_SYMBOL_LENGTH || CONTROL_CHARACTER.test(symbol)) {
    throw new GitDiffError('bad-param', `symbol must contain 1-${MAX_SYMBOL_LENGTH} printable characters`)
  }
  return { kind: kind as CodeNavKind, file: query.file, rev, line, character, symbol }
}

export function validateFileAtRev(value: string | null): string {
  if (value === 'worktree' || (typeof value === 'string' && COMMIT_SHA.test(value))) return value
  throw new GitDiffError('bad-param', 'rev must be "worktree" or a full commit SHA')
}

type Eligibility = { provider: PreciseNavProvider } | { provider?: undefined; note?: string }

/**
 * Definition, references and callers for the diff viewer. Answers with a language server when one
 * handles the file and the files on disk are the ones shown, otherwise with whole-word `git grep`
 * matches at the clicked side's rev.
 */
export class CodeNavService {
  constructor(
    private readonly inspector: GitDiffInspector,
    private readonly providers: PreciseNavProvider[] = [],
  ) {}

  /** Registers a language-server provider; the first that handles a file wins. */
  addProvider(provider: PreciseNavProvider): void {
    this.providers.push(provider)
  }

  async navigate(cwd: string, query: CodeNavQuery): Promise<CodeNavResult> {
    const request = validateCodeNavQuery(query)
    const { root, relative } = await this.inspector.repoFile(cwd, request.file)
    const { kind, rev, symbol } = request
    if (rev === 'worktree') await this.worktreeSource(root, relative)
    if (!IDENTIFIER.test(symbol)) {
      return { kind, source: 'text', rev, locations: [], truncated: false, note: 'Not a symbol: pick an identifier to navigate from' }
    }

    const eligibility = await this.eligibility(root, relative, rev)
    let fallbackNote = eligibility.provider ? undefined : eligibility.note
    if (eligibility.provider) {
      try {
        return await this.precise(eligibility.provider, root, relative, { ...request, file: relative })
      } catch (error) {
        fallbackNote = error instanceof PreciseNavUnavailable
          ? withSuffix(error.message)
          : `${eligibility.provider.name} couldn't answer (${error instanceof Error ? error.message : String(error)})${FALLBACK_SUFFIX}`
      }
    }
    const result = await this.text(root, { ...request, file: relative })
    return { ...result, note: joinNotes(fallbackNote, result.note) }
  }

  /** One file at a rev for the peek: the disk for `'worktree'`, the committed blob for a SHA. */
  async fileAt(cwd: string, file: string | null, value: string | null): Promise<CodeNavFile> {
    const rev = validateFileAtRev(value)
    const { root, relative } = await this.inspector.repoFile(cwd, file)
    try {
      const source = rev === 'worktree' ? await this.worktreeSource(root, relative) : await this.inspector.revisionSource(root, relative, rev)
      if (!source) return { file: relative, rev, contents: null, unavailable: 'missing' }
      if (source.size > MAX_FILE_CONTENTS_BYTES) return { file: relative, rev, contents: null, unavailable: 'too-large' }
      const contents = await source.read()
      if (contents.includes(NUL)) return { file: relative, rev, contents: null, unavailable: 'binary' }
      // The file on disk may have grown since it was measured.
      if (Buffer.byteLength(contents) > MAX_FILE_CONTENTS_BYTES) return { file: relative, rev, contents: null, unavailable: 'too-large' }
      return { file: relative, rev, contents }
    } catch (error) {
      throw gitFailure(error, 'git file read')
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.providers.map((provider) => provider.dispose()))
  }

  /** Checks containment (symlinked parents included) for a worktree path. */
  private async worktreeSource(root: string, relative: string): Promise<FileSource | undefined> {
    try {
      return await this.inspector.revisionSource(root, relative, 'worktree')
    } catch (error) {
      throw gitFailure(error, 'git file read')
    }
  }

  private async eligibility(root: string, relative: string, rev: string): Promise<Eligibility> {
    const provider = this.providers.find((candidate) => candidate.handles(relative))
    if (!provider) return {}
    if (rev === 'worktree') return { provider }
    const atOldSide = `Precise results need the files on disk; showing name matches at ${shortSha(rev)}`
    const head = await this.inspector.headSha(root)
    if (head !== rev) return { note: atOldSide }
    try {
      const [{ stdout: tracked }, { stdout: status }] = await Promise.all([
        this.inspector.runGit(root, ['ls-files', '-z', '--', relative]),
        this.inspector.runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', relative]),
      ])
      if (tracked.split(NUL).includes(relative) && status.length === 0) return { provider }
    } catch {
      // Unknown state: the text engine answers at the rev, which is always right.
    }
    return { note: `${relative} has changed on disk since ${shortSha(rev)}; showing name matches at ${shortSha(rev)}` }
  }

  private async precise(
    provider: PreciseNavProvider,
    root: string,
    relative: string,
    request: CodeNavRequest,
  ): Promise<CodeNavResult> {
    // The provider reads the disk and follows links, so it never gets a symlinked file (the rest of
    // the daemon shows a link as its target text), and every answer must really be inside the repo.
    await this.worktreeSource(root, relative)
    if ((await lstat(path.join(root, relative))).isSymbolicLink()) {
      throw new PreciseNavUnavailable(`${relative} is a symlink, which language servers would follow`)
    }
    const found = await provider.query({
      root,
      kind: request.kind,
      path: path.join(root, relative),
      line: request.line,
      character: request.character,
    })
    const realRoot = await realpath(root).catch(() => root)
    const realPaths = new Map<string, Promise<string | undefined>>()
    const real = (absolute: string) => {
      let cached = realPaths.get(absolute)
      if (!cached) {
        cached = path.isAbsolute(absolute) ? realpath(absolute).catch(() => undefined) : Promise.resolve(undefined)
        realPaths.set(absolute, cached)
      }
      return cached
    }

    const seen = new Set<string>()
    const mapped: { location: PreciseLocation; file: string }[] = []
    let outside = 0
    for (const location of found) {
      // By real path, so a symlink in the repo can't surface (or preview) a file outside it.
      const resolved = await real(location.path)
      const file = resolved === undefined ? undefined : this.relativeTo([realRoot], resolved)
      if (file === undefined) {
        outside += 1
        continue
      }
      const key = `${file}${NUL}${location.line}${NUL}${location.character}`
      if (seen.has(key)) continue
      seen.add(key)
      mapped.push({ location, file })
    }
    const kept = mapped.slice(0, MAX_NAV_LOCATIONS)
    const lines = new Map<string, Promise<string[] | undefined>>()
    const readLines = (file: string) => {
      let cached = lines.get(file)
      if (!cached) {
        cached = this.fileLines(root, file, 'worktree')
        lines.set(file, cached)
      }
      return cached
    }
    const locations = await Promise.all(kept.map(async ({ location, file }): Promise<CodeNavLocation> => {
      const text = location.preview ?? (await readLines(file))?.[location.line - 1] ?? ''
      return {
        file,
        line: location.line,
        character: location.character,
        ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
        ...(location.endCharacter !== undefined ? { endCharacter: location.endCharacter } : {}),
        preview: preview(text),
        ...(location.container ? { container: location.container } : {}),
      }
    }))
    return {
      kind: request.kind,
      source: 'language-server',
      rev: 'worktree',
      locations,
      truncated: mapped.length > MAX_NAV_LOCATIONS,
      ...(outside > 0 ? { note: `${outside} result${outside === 1 ? '' : 's'} outside the repository not shown` } : {}),
    }
  }

  private relativeTo(roots: readonly string[], absolute: string): string | undefined {
    if (!path.isAbsolute(absolute)) return undefined
    for (const root of roots) {
      const relative = path.relative(root, path.normalize(absolute))
      if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
        return relative.split(path.sep).join('/')
      }
    }
    return undefined
  }

  private async fileLines(root: string, file: string, rev: string): Promise<string[] | undefined> {
    try {
      const source = await this.inspector.revisionSource(root, file, rev)
      if (!source || source.size > MAX_FILE_CONTENTS_BYTES) return undefined
      const contents = await source.read()
      return contents.includes(NUL) ? undefined : contents.split('\n')
    } catch {
      return undefined
    }
  }

  private async text(root: string, request: CodeNavRequest): Promise<CodeNavResult> {
    const { kind, rev, symbol, file } = request
    const sha = rev === 'worktree' ? undefined : rev
    const args = [
      'grep', '--no-color', '-n', '--column', '-w', '-I', '-F', '-z',
      ...(sha ? [] : ['--untracked']),
      '-e', symbol,
      ...(sha ? [sha] : []),
      '--',
    ]
    let stdout: string
    try {
      ({ stdout } = await this.inspector.runGit(root, args, {
        timeout: GREP_TIMEOUT_MS, maxBuffer: GREP_BUFFER_BYTES, allowExitCodes: [1],
      }))
    } catch (error) {
      if (error instanceof GitCommandFailure && sha && UNKNOWN_OBJECT.test(error.stderr)) {
        throw new GitDiffError('bad-target', `Unknown commit: ${sha}`)
      }
      throw gitFailure(error, 'git grep')
    }

    const matches = parseGrepOutput(stdout, sha)
    const name = escapeRegExp(symbol)
    const declarations = declarationPatterns(name)
    const call = new RegExp(`(?<!${WORD})${name}\\s*${TYPE_ARGUMENTS}\\s*\\(`, 'u')
    let selected: GrepMatch[]
    if (kind === 'references') {
      selected = matches
    } else if (kind === 'definition') {
      selected = matches.filter((match) => !PROSE.test(match.file) && isDeclaration(match.text, declarations)).map((match) => {
        const at = new RegExp(`(?<!${WORD})${name}(?!${WORD})`, 'u').exec(match.text)
        return at ? { ...match, character: at.index } : match
      })
    } else {
      selected = []
      for (const match of matches) {
        if (PROSE.test(match.file) || match.text.length > MAX_MATCHED_LINE_LENGTH || isDeclaration(match.text, declarations)) continue
        const at = call.exec(match.text)
        if (at) selected.push({ ...match, character: at.index })
      }
    }

    const ordered = clickedFileFirst(selected, file)
    const kept = ordered.slice(0, MAX_NAV_LOCATIONS)
    const locations: CodeNavLocation[] = kept.map((match) => ({
      file: match.file,
      line: match.line,
      character: match.character,
      endLine: match.line,
      endCharacter: match.character + symbol.length,
      preview: preview(match.text),
    }))
    if (kind === 'callers') await this.addContainers(root, rev, locations)

    let note: string | undefined
    if (locations.length === 0 && kind === 'definition') {
      note = matches.length > 0
        ? `No declaration of ${symbol} found by name; try References`
        : `No matches for ${symbol}`
    }
    return {
      kind,
      source: 'text',
      rev,
      locations,
      truncated: ordered.length > MAX_NAV_LOCATIONS,
      ...(note ? { note } : {}),
    }
  }

  /** Best-effort enclosing function names for text callers, from the files at the rev. */
  private async addContainers(root: string, rev: string, locations: CodeNavLocation[]): Promise<void> {
    const files = [...new Set(locations.map((location) => location.file))].slice(0, MAX_CONTAINER_FILES)
    const contents = new Map(await Promise.all(files.map(async (file) => [file, await this.fileLines(root, file, rev)] as const)))
    for (const location of locations) {
      const lines = contents.get(location.file)
      const container = lines && enclosingName(lines, location.line - 1)
      if (container) location.container = container
    }
  }
}

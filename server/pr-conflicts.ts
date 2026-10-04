import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrConflicts } from '../shared/pr-quick-look.js'

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
const MAX_FILES = 100
const MAX_FILE_BYTES = 128 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024
type GitResult = { stdout: string; code: number }
type GitRunner = (args: string[], cwd: string, allowConflict?: boolean) => Promise<GitResult>
type Inspection = Pick<PrConflicts, 'baseRefName' | 'headRefName' | 'baseOid' | 'headOid'> & { repo: string; number: number }

export class PrConflictError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

const runGit: GitRunner = (args, cwd, allowConflict = false) => new Promise((resolve, reject) => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GH_PROMPT_DISABLED: '1',
  })
  execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args], {
    cwd, env, encoding: 'utf8', timeout: args.includes('fetch') ? 90_000 : 20_000, maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (!error || (allowConflict && error.code === 1 && !error.killed)) {
      resolve({ stdout, code: error ? 1 : 0 })
    } else {
      reject(new PrConflictError(error.killed ? 'Conflict inspection timed out. Retry to inspect the current commits.'
        : `Unable to inspect merge conflicts: ${stderr.trim().split('\n')[0]?.slice(0, 240) || error.message}`))
    }
  })
})

/** Parse Git's documented NUL-separated sections, not human-readable conflict strings. */
export function parseMergeTree(output: string, code: number) {
  if (code !== 0 && code !== 1) throw new PrConflictError('Git could not complete the merge simulation')
  const fields = output.split('\0')
  const tree = fields.shift() ?? ''
  if (!OID.test(tree)) throw new PrConflictError('Git returned an invalid merge tree')
  const paths: string[] = []
  while (fields.length && fields[0] !== '') paths.push(fields.shift()!)
  if (fields[0] === '') fields.shift()
  const messages: Array<{ paths: string[]; kind: string; text: string }> = []
  while (fields.length && fields[0] !== '') {
    const count = Number(fields.shift())
    if (!Number.isInteger(count) || count < 0 || count > fields.length - 2) throw new PrConflictError('Git returned invalid conflict messages')
    const messagePaths = fields.splice(0, count)
    const kind = fields.shift()!
    const text = fields.shift()!
    if (kind !== 'Auto-merging') messages.push({ paths: messagePaths, kind, text: text.trim() })
  }
  return { tree, paths: [...new Set(paths)], messages, conflicting: code === 1 }
}

/** Every Git write stays inside a disposable bare repository; no checkout, index, or refs are touched. */
export class PrConflictInspector {
  private active = 0
  private cache = new Map<string, { at: number; promise: Promise<PrConflicts> }>()
  constructor(private options: { git?: GitRunner; remote?: (repo: string) => string } = {}) {}

  inspect(input: Inspection): Promise<PrConflicts> {
    if (!OID.test(input.baseOid) || !OID.test(input.headOid) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?\/[A-Za-z0-9._-]{1,100}$/.test(input.repo)
      || !Number.isSafeInteger(input.number) || input.number < 1) return Promise.reject(new PrConflictError('Invalid conflict inspection input', 400))
    const key = JSON.stringify([input.repo.toLowerCase(), input.number, input.baseRefName, input.headRefName, input.baseOid, input.headOid])
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < 60_000) return cached.promise
    if (this.active >= 2) return Promise.reject(new PrConflictError('Conflict inspections are busy. Retry shortly.', 429))
    this.active++
    const promise = this.compute(input).finally(() => { this.active-- })
    this.cache.set(key, { at: Date.now(), promise })
    if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!)
    promise.catch(() => { if (this.cache.get(key)?.promise === promise) this.cache.delete(key) })
    return promise
  }

  private async compute(input: Inspection): Promise<PrConflicts> {
    const directory = await mkdtemp(join(tmpdir(), 'commando-pr-conflicts-'))
    const git = this.options.git ?? runGit
    try {
      await git(['init', '--bare', '--quiet'], directory)
      // Validate the remote ref as a full ref, then fetch only this target and PR (including forks).
      await git(['check-ref-format', `refs/heads/${input.baseRefName}`], directory)
      await git(['remote', 'add', 'origin', this.options.remote?.(input.repo) ?? `https://github.com/${input.repo}.git`], directory)
      await git(['config', 'remote.origin.promisor', 'true'], directory)
      await git(['config', 'remote.origin.partialclonefilter', 'blob:none'], directory)
      await git(['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin',
        `+refs/heads/${input.baseRefName}:refs/heads/target`, `+refs/pull/${input.number}/head:refs/heads/proposed`], directory)
      const base = (await git(['rev-parse', 'refs/heads/target'], directory)).stdout.trim()
      const head = (await git(['rev-parse', 'refs/heads/proposed'], directory)).stdout.trim()
      if (base !== input.baseOid || head !== input.headOid) throw new PrConflictError('The PR or target changed during inspection. Retry for the latest commits.', 409)
      const result = await git(['merge-tree', '--write-tree', '--name-only', '--messages', '-z', base, head], directory, true)
      const parsed = parseMergeTree(result.stdout, result.code)
      const files: PrConflicts['files'] = []
      let bytes = 0
      for (const path of parsed.paths.slice(0, MAX_FILES)) {
        const kind = parsed.messages.find((message) => message.paths.includes(path) && message.kind.startsWith('CONFLICT'))?.kind ?? 'Conflict'
        let content: string | null = null
        let truncated = false
        try {
          const object = `${parsed.tree}:${path}`
          const size = Number((await git(['cat-file', '-s', object], directory)).stdout.trim())
          if (!Number.isFinite(size) || size > MAX_FILE_BYTES || bytes + size > MAX_TOTAL_BYTES) truncated = true
          else {
            const blob = (await git(['cat-file', 'blob', object], directory)).stdout
            if (!blob.includes('\0')) { content = blob; bytes += size }
          }
        } catch { /* Binary, submodule, or deleted paths may have no readable merged blob. Messages still explain the conflict. */ }
        files.push({ path, kind, content, truncated })
      }
      return {
        state: parsed.conflicting ? 'conflicting' : 'clean', baseRefName: input.baseRefName, headRefName: input.headRefName,
        baseOid: base, headOid: head, files, messages: parsed.messages.map((message) => message.text),
        truncated: parsed.paths.length > MAX_FILES || files.some((file) => file.truncated), fetchedAt: Date.now(),
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}

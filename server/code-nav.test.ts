import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CodeNavResult } from '../shared/code-nav.js'
import { PreciseNavUnavailable, type PreciseLocation, type PreciseNavProvider, type PreciseQuery } from './code-nav-provider.js'
import { CodeNavService, MAX_NAV_LOCATIONS, parseGrepOutput, type CodeNavQuery } from './code-nav.js'
import { GitDiffInspector, MAX_FILE_CONTENTS_BYTES, type GitProcessExecutor } from './git-diff.js'

const NUL = String.fromCharCode(0)
const SHA = 'a'.repeat(40)

const APP_TS = [
  "import { helper } from './util'",
  '',
  'export function greet(name: string): string {',
  '  return helper(name)',
  '}',
  '',
  'export class Greeter {',
  '  run() {',
  '    return greet("x")',
  '  }',
  '}',
  '',
].join('\n')

const UTIL_TS = [
  'export const helper = (value: string) => value.trim()',
  '',
  'export async function wrap() {',
  '  const out = helper<string>(" a ")',
  '  return greet(out)',
  '}',
  '',
].join('\n')

const STORE_TS = [
  'export class Store {',
  '  private async load(id: string): Promise<{ id: string } | null> {',
  '    return null',
  '  }',
  '',
  '  async fetchAll(',
  '    ids: string[],',
  '  ): Promise<void> {',
  '    await this.load(ids[0])',
  '  }',
  '}',
  '',
].join('\n')

const TOOL_PY = [
  'def greet(name):',
  '    return "hi " + name',
  '',
  'class Tool:',
  '    def run(self):',
  '        return greet("y")',
  '',
].join('\n')

function query(overrides: Partial<CodeNavQuery> = {}): CodeNavQuery {
  return { kind: 'references', file: 'src/app.ts', rev: 'worktree', line: '3', character: '16', symbol: 'greet', ...overrides }
}

function fakeProvider(answer: (query: PreciseQuery) => Promise<PreciseLocation[]> = async () => []) {
  const query = vi.fn(answer)
  const dispose = vi.fn(async () => undefined)
  const provider: PreciseNavProvider = {
    name: 'TypeScript',
    handles: (file) => /\.tsx?$/u.test(file),
    query,
    dispose,
  }
  return { provider, query, dispose }
}

describe('parseGrepOutput', () => {
  it('reads NUL-separated records, strips the rev prefix and keeps colons in paths', () => {
    const output = [
      `${SHA}:src/a:b.ts${NUL}12${NUL}7${NUL}const héllo = 1\n`,
      `${SHA}:x.ts${NUL}3${NUL}5${NUL}foo(héllo): é\n`,
    ].join('')
    expect(parseGrepOutput(output, SHA)).toEqual([
      { file: 'src/a:b.ts', line: 12, character: 6, text: 'const héllo = 1' },
      { file: 'x.ts', line: 3, character: 4, text: 'foo(héllo): é' },
    ])
  })

  it('converts byte columns to UTF-16 offsets and tolerates a missing final newline', () => {
    expect(parseGrepOutput(`a.ts${NUL}1${NUL}5${NUL}é = é`)).toEqual([
      { file: 'a.ts', line: 1, character: 3, text: 'é = é' },
    ])
  })
})

describe('CodeNavService (fake executor)', () => {
  function executor(grepOutput: string, calls: string[][] = []): GitProcessExecutor {
    return async (_file, args) => {
      calls.push([...args])
      if (args.join(' ') === 'rev-parse --show-toplevel --abbrev-ref HEAD') return { stdout: '/repo\nmain\n', stderr: '' }
      if (args[0] === 'grep') return { stdout: grepOutput, stderr: '' }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    }
  }
  const files = {
    entry: async () => ({ kind: 'file' as const, size: 10 }),
    readlink: async () => '',
    realpath: async (file: string) => file,
  }
  const service = (grepOutput = '', calls: string[][] = []) =>
    new CodeNavService(new GitDiffInspector(executor(grepOutput, calls), {}, Date.now, async () => '', undefined, files))

  it.each([
    [{ kind: 'usages' }, /kind must be/u],
    [{ kind: null }, /kind must be/u],
    [{ rev: 'HEAD' }, /rev must be/u],
    [{ rev: 'abc123' }, /rev must be/u],
    [{ line: '0' }, /line must be/u],
    [{ line: '1.5' }, /line must be/u],
    [{ line: '-1' }, /line must be/u],
    [{ character: '-1' }, /character must be/u],
    [{ character: 'x' }, /character must be/u],
    [{ symbol: '' }, /symbol must/u],
    [{ symbol: 'a'.repeat(201) }, /symbol must/u],
    [{ symbol: 'a\u0001b' }, /symbol must/u],
    [{ file: '../etc/passwd' }, /escapes/u],
    [{ file: '/etc/passwd' }, /Invalid file/u],
  ] as [Partial<CodeNavQuery>, RegExp][])('rejects %o', async (overrides, message) => {
    await expect(service().navigate('/repo', query(overrides))).rejects.toMatchObject({
      name: 'GitDiffError', message: expect.stringMatching(message),
    })
  })

  it('answers a non-symbol token with an empty text result and a note', async () => {
    const calls: string[][] = []
    const result = await service('', calls).navigate('/repo', query({ symbol: '=>' }))
    expect(result).toMatchObject({ kind: 'references', source: 'text', rev: 'worktree', locations: [], truncated: false })
    expect(result.note).toMatch(/Not a symbol/u)
    expect(calls.some((args) => args[0] === 'grep')).toBe(false)
  })

  it('runs git grep with the documented flags at the worktree and at a SHA', async () => {
    const calls: string[][] = []
    await service('', calls).navigate('/repo', query())
    await service('', calls).navigate('/repo', query({ rev: SHA }))
    const greps = calls.filter((args) => args[0] === 'grep')
    expect(greps).toEqual([
      ['grep', '-n', '--column', '-w', '-I', '-F', '-z', '--untracked', '-e', 'greet', '--'],
      ['grep', '-n', '--column', '-w', '-I', '-F', '-z', '-e', 'greet', SHA, '--'],
    ])
  })

  it('caps results at the limit, clicked file first, and marks them truncated', async () => {
    const lines = Array.from({ length: MAX_NAV_LOCATIONS + 5 }, (_, index) => `other.ts${NUL}${index + 1}${NUL}1${NUL}greet()\n`)
    lines.push(`src/app.ts${NUL}9${NUL}12${NUL}    return greet("x")\n`)
    const result = await service(lines.join('')).navigate('/repo', query())
    expect(result.locations).toHaveLength(MAX_NAV_LOCATIONS)
    expect(result.truncated).toBe(true)
    expect(result.locations[0]).toMatchObject({ file: 'src/app.ts', line: 9, character: 11, preview: 'return greet("x")' })
  })
})

describe('CodeNavService (real repository)', () => {
  let root: string
  let first: string
  let head: string
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'a@a' }
  const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env })
  const inspector = () => new GitDiffInspector(undefined, env)
  const nav = (overrides: Partial<CodeNavQuery>, providers: PreciseNavProvider[] = []) =>
    new CodeNavService(inspector(), providers).navigate(root, query(overrides))
  const where = (result: CodeNavResult) => result.locations.map((location) => `${location.file}:${location.line}:${location.character}`)

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-code-nav-')))
    run('init', '-q', '-b', 'main')
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src/app.ts'), APP_TS)
    await writeFile(path.join(root, 'src/util.ts'), UTIL_TS)
    await writeFile(path.join(root, 'tool.py'), TOOL_PY)
    await writeFile(path.join(root, 'src/store.ts'), STORE_TS)
    await writeFile(path.join(root, 'odd:name.ts'), 'greet(1)\n')
    await writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    await symlink('src/app.ts', path.join(root, 'link'))
    run('add', '.')
    run('commit', '-q', '-m', 'First')
    first = run('rev-parse', 'HEAD').trim()
    // The second commit renames greet → salute in Python only; the worktree adds an untracked caller.
    await writeFile(path.join(root, 'tool.py'), TOOL_PY.replaceAll('greet', 'salute'))
    run('commit', '-q', '-am', 'Second')
    head = run('rev-parse', 'HEAD').trim()
    await writeFile(path.join(root, 'new.ts'), 'greet("untracked")\n')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds references at the worktree, including untracked files and paths with colons', async () => {
    const result = await nav({})
    expect(result).toMatchObject({ source: 'text', rev: 'worktree', truncated: false })
    expect(where(result)).toEqual([
      'src/app.ts:3:16', 'src/app.ts:9:11',
      'new.ts:1:0', 'odd:name.ts:1:0', 'src/util.ts:5:9',
    ])
    expect(result.locations[0]).toMatchObject({ preview: 'export function greet(name: string): string {', endCharacter: 21 })
  })

  it('finds definitions across languages at a SHA, clicked file first', async () => {
    const atFirst = await nav({ kind: 'definition', rev: first, file: 'tool.py' })
    expect(atFirst.rev).toBe(first)
    expect(where(atFirst)).toEqual(['tool.py:1:4', 'src/app.ts:3:16'])
    // greet is gone from Python at HEAD.
    expect(where(await nav({ kind: 'definition', rev: head }))).toEqual(['src/app.ts:3:16'])
    expect(where(await nav({ kind: 'definition', symbol: 'helper' }))).toEqual(['src/util.ts:1:13'])
    expect(where(await nav({ kind: 'definition', symbol: 'Greeter' }))).toEqual(['src/app.ts:7:13'])
    expect(where(await nav({ kind: 'definition', symbol: 'run', rev: first }))).toEqual(['src/app.ts:8:2', 'tool.py:5:8'])
  })

  it('finds methods whose return type has braces, and containers with wrapped parameters', async () => {
    expect(where(await nav({ kind: 'definition', symbol: 'load', file: 'src/store.ts' }))).toEqual(['src/store.ts:2:16'])
    const callers = await nav({ kind: 'callers', symbol: 'load', file: 'src/store.ts' })
    expect(callers.locations).toMatchObject([{ file: 'src/store.ts', line: 9, character: 15, container: 'fetchAll' }])
  })

  it('suggests References when no declaration is found', async () => {
    const result = await nav({ kind: 'definition', symbol: 'value' })
    expect(result.locations).toEqual([])
    expect(result.note).toMatch(/try References/u)
  })

  it('finds callers with their enclosing function, excluding declarations', async () => {
    const result = await nav({ kind: 'callers', rev: first })
    expect(result.locations.map((location) => [location.file, location.line, location.container])).toEqual([
      ['src/app.ts', 9, 'run'],
      ['odd:name.ts', 1, undefined],
      ['src/util.ts', 5, 'wrap'],
      ['tool.py', 6, 'run'],
    ])
    const generic = await nav({ kind: 'callers', symbol: 'helper', file: 'src/util.ts' })
    expect(where(generic)).toEqual(['src/util.ts:4:14', 'src/app.ts:4:9'])
    expect(generic.locations.map((location) => location.container)).toEqual(['wrap', 'greet'])
  })

  it('reports an unknown commit as a bad target', async () => {
    await expect(nav({ rev: 'b'.repeat(40) })).rejects.toMatchObject({ kind: 'bad-target' })
  })

  describe('precise provider', () => {
    it('is used for the worktree, mapping paths, dropping outside ones and filling previews', async () => {
      const { provider, query: providerQuery } = fakeProvider(async () => [
        { path: path.join(root, 'src/util.ts'), line: 5, character: 9 },
        { path: path.join(root, 'src/util.ts'), line: 5, character: 9 },
        { path: path.join(root, 'src/app.ts'), line: 3, character: 16, preview: '   custom   ', container: 'top' },
        { path: '/usr/lib/node_modules/typescript/lib/lib.d.ts', line: 1, character: 0 },
        { path: path.join(path.dirname(root), 'sibling/x.ts'), line: 1, character: 0 },
      ])
      const result = await nav({}, [provider])
      expect(providerQuery).toHaveBeenCalledWith({ root, kind: 'references', path: path.join(root, 'src/app.ts'), line: 3, character: 16 })
      expect(result).toMatchObject({ source: 'language-server', rev: 'worktree', truncated: false })
      expect(result.locations).toEqual([
        { file: 'src/util.ts', line: 5, character: 9, preview: 'return greet(out)' },
        { file: 'src/app.ts', line: 3, character: 16, preview: 'custom', container: 'top' },
      ])
      expect(result.note).toBe('2 results outside the repository not shown')
    })

    it('caps precise results', async () => {
      const { provider } = fakeProvider(async () => Array.from({ length: MAX_NAV_LOCATIONS + 1 }, (_, index) => (
        { path: path.join(root, 'src/app.ts'), line: 1, character: index, preview: 'x' }
      )))
      const result = await nav({}, [provider])
      expect(result.locations).toHaveLength(MAX_NAV_LOCATIONS)
      expect(result.truncated).toBe(true)
    })

    it('is used for the HEAD SHA when the file is clean and tracked', async () => {
      const { provider, query: providerQuery } = fakeProvider()
      const result = await nav({ rev: head }, [provider])
      expect(providerQuery).toHaveBeenCalledOnce()
      expect(result).toMatchObject({ source: 'language-server', rev: 'worktree' })
    })

    it('is skipped for the HEAD SHA when the file is modified on disk', async () => {
      await writeFile(path.join(root, 'src/app.ts'), `${APP_TS}// edit\n`)
      try {
        const { provider, query: providerQuery } = fakeProvider()
        const result = await nav({ rev: head }, [provider])
        expect(providerQuery).not.toHaveBeenCalled()
        expect(result).toMatchObject({ source: 'text', rev: head })
        expect(result.note).toMatch(/has changed on disk/u)
      } finally {
        await writeFile(path.join(root, 'src/app.ts'), APP_TS)
      }
    })

    it('is skipped for an untracked file at the HEAD SHA', async () => {
      const { provider, query: providerQuery } = fakeProvider()
      await nav({ rev: head, file: 'new.ts' }, [provider])
      expect(providerQuery).not.toHaveBeenCalled()
    })

    it('is skipped for an older SHA with a note naming it', async () => {
      const { provider, query: providerQuery } = fakeProvider()
      const result = await nav({ rev: first }, [provider])
      expect(providerQuery).not.toHaveBeenCalled()
      expect(result).toMatchObject({ source: 'text', rev: first })
      expect(result.note).toBe(`Precise results need the files on disk; showing name matches at ${first.slice(0, 8)}`)
    })

    it('is skipped without a note for files it does not handle', async () => {
      const { provider, query: providerQuery } = fakeProvider()
      const result = await nav({ file: 'tool.py', symbol: 'salute' }, [provider])
      expect(providerQuery).not.toHaveBeenCalled()
      expect(result.note).toBeUndefined()
    })

    it('falls back to text matches with the reason when the provider rejects', async () => {
      const loading = fakeProvider(async () => { throw new PreciseNavUnavailable('TypeScript server is still loading.') })
      const result = await nav({ kind: 'definition' }, [loading.provider])
      expect(result).toMatchObject({ source: 'text', rev: 'worktree', note: 'TypeScript server is still loading — showing name matches' })
      expect(where(result)).toEqual(['src/app.ts:3:16'])

      const crashed = fakeProvider(async () => { throw new Error('socket closed') })
      await expect(nav({}, [crashed.provider])).resolves.toMatchObject({
        source: 'text', note: "TypeScript couldn't answer (socket closed) — showing name matches",
      })
    })

    it('disposes providers', async () => {
      const { provider, dispose } = fakeProvider()
      await new CodeNavService(inspector(), [provider]).dispose()
      expect(dispose).toHaveBeenCalledOnce()
    })
  })

  describe('fileAt', () => {
    const fileAt = (file: string, rev: string) => new CodeNavService(inspector()).fileAt(root, file, rev)

    it('reads the worktree and a SHA', async () => {
      await expect(fileAt('new.ts', 'worktree')).resolves.toEqual({ file: 'new.ts', rev: 'worktree', contents: 'greet("untracked")\n' })
      await expect(fileAt('tool.py', first)).resolves.toEqual({ file: 'tool.py', rev: first, contents: TOOL_PY })
      await expect(fileAt('link', 'worktree')).resolves.toMatchObject({ contents: 'src/app.ts' })
    })

    it('marks missing, binary and too-large files unavailable', async () => {
      await expect(fileAt('new.ts', first)).resolves.toEqual({ file: 'new.ts', rev: first, contents: null, unavailable: 'missing' })
      await expect(fileAt('nope.ts', 'worktree')).resolves.toMatchObject({ contents: null, unavailable: 'missing' })
      await expect(fileAt('blob.bin', head)).resolves.toMatchObject({ contents: null, unavailable: 'binary' })
      await writeFile(path.join(root, 'big.txt'), 'x'.repeat(MAX_FILE_CONTENTS_BYTES + 1))
      try {
        await expect(fileAt('big.txt', 'worktree')).resolves.toMatchObject({ contents: null, unavailable: 'too-large' })
      } finally {
        await rm(path.join(root, 'big.txt'))
      }
    })

    it('rejects bad revs, escaping paths and symlinked parents out of the repository', async () => {
      await expect(fileAt('new.ts', 'HEAD')).rejects.toMatchObject({ kind: 'bad-param' })
      await expect(fileAt('../x', 'worktree')).rejects.toMatchObject({ kind: 'bad-file' })
      const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-code-nav-outside-')))
      try {
        await writeFile(path.join(outside, 'secret.ts'), 'secret')
        await symlink(outside, path.join(root, 'escape'))
        await expect(fileAt('escape/secret.ts', 'worktree')).rejects.toMatchObject({ kind: 'bad-file' })
        await expect(nav({ file: 'escape/secret.ts' })).rejects.toMatchObject({ kind: 'bad-file' })
      } finally {
        await rm(path.join(root, 'escape'))
        await rm(outside, { recursive: true, force: true })
      }
    })

    it('reports an unknown commit as a bad target', async () => {
      await expect(fileAt('tool.py', 'c'.repeat(40))).rejects.toMatchObject({ kind: 'bad-target' })
    })
  })
})

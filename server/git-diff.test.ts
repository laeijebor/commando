import { describe, expect, it } from 'vitest'
import {
  GitCommandFailure,
  GitDiffError,
  GitDiffInspector,
  validateDiffWidth,
  validateGitTarget,
  type GitExecutorOptions,
  type GitProcessExecutor,
} from './git-diff.js'

const NUL = String.fromCharCode(0)
const ROOT = '/repo'
const BRANCH = 'feature'
const BASE = 'basesha'

type Call = { file: string; args: string[]; options: GitExecutorOptions }

type FakeRepoOptions = {
  refs?: string[]
  numstat?: string
  nameStatus?: string
  untracked?: string[]
  diffOutput?: string
  diffFailure?: GitCommandFailure
  refList?: string[]
}

function failure(stderr = '', missingBinary = false): GitCommandFailure {
  return new GitCommandFailure('git failed', stderr, missingBinary)
}

function fakeRepo(options: FakeRepoOptions = {}) {
  const {
    refs = ['main'],
    numstat = '',
    nameStatus = '',
    untracked = [],
    diffOutput = 'DIFF',
    diffFailure,
    refList = [],
  } = options
  const calls: Call[] = []
  const execute: GitProcessExecutor = async (file, args, executorOptions) => {
    calls.push({ file, args: [...args], options: executorOptions })
    const joined = args.join(' ')
    if (file === 'difft') return { stdout: diffOutput, stderr: '' }
    if (joined === 'rev-parse --show-toplevel --abbrev-ref HEAD') {
      return { stdout: `${ROOT}\n${BRANCH}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const ref = args[3].replace(/\^\{commit\}$/u, '')
      if (refs.includes(ref)) return { stdout: 'sha\n', stderr: '' }
      throw failure()
    }
    if (args[0] === 'merge-base') return { stdout: `${BASE}\n`, stderr: '' }
    if (args[0] === 'for-each-ref') return { stdout: refList.join('\n'), stderr: '' }
    if (args[0] === 'diff' && args.includes('--numstat')) return { stdout: numstat, stderr: '' }
    if (args[0] === 'diff' && args.includes('--name-status')) return { stdout: nameStatus, stderr: '' }
    if (args[0] === 'ls-files' && args.includes('--')) {
      const target = args[args.length - 1]
      const listed = untracked.includes(target) ? `${target}${NUL}` : ''
      return { stdout: listed, stderr: '' }
    }
    if (args[0] === 'ls-files') {
      return { stdout: untracked.map((entry) => `${entry}${NUL}`).join(''), stderr: '' }
    }
    if (args[0] === 'diff' && args[1] === '--ext-diff') {
      if (diffFailure) throw diffFailure
      return { stdout: diffOutput, stderr: '' }
    }
    throw new Error(`Unexpected command: ${file} ${joined}`)
  }
  return { calls, execute }
}

function notARepo(): GitProcessExecutor {
  return async (file, args) => {
    if (args[0] === 'rev-parse') throw failure('fatal: not a git repository')
    throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
  }
}

describe('validateGitTarget', () => {
  it('accepts plain branch and remote refs', () => {
    expect(validateGitTarget('main')).toBe('main')
    expect(validateGitTarget('origin/feature-1')).toBe('origin/feature-1')
  })

  it.each(['', '  main', '-option', 'a..b', 'has space', 'tick~1', 'star*'])(
    'rejects %j',
    (value) => {
      expect(() => validateGitTarget(value)).toThrow(GitDiffError)
    },
  )
})

describe('validateDiffWidth', () => {
  it('defaults and clamps', () => {
    expect(validateDiffWidth(undefined)).toBe(180)
    expect(validateDiffWidth('abc')).toBe(180)
    expect(validateDiffWidth('10')).toBe(60)
    expect(validateDiffWidth('9999')).toBe(500)
    expect(validateDiffWidth('120')).toBe(120)
  })
})

describe('GitDiffInspector.summary', () => {
  it('reports non-repositories', async () => {
    const inspector = new GitDiffInspector(notARepo(), {})
    await expect(inspector.summary('/tmp')).resolves.toEqual({ isRepo: false })
  })

  it('parses numstat, statuses, and untracked files', async () => {
    const repo = fakeRepo({
      numstat: `10\t2\tsrc/app.ts${NUL}-\t-\tlogo.png${NUL}0\t5\told.ts${NUL}`,
      nameStatus: `M${NUL}src/app.ts${NUL}A${NUL}logo.png${NUL}D${NUL}old.ts${NUL}`,
      untracked: ['notes.md'],
    })
    const inspector = new GitDiffInspector(repo.execute, {})
    const summary = await inspector.summary('/repo/sub')
    expect(summary).toMatchObject({
      isRepo: true,
      root: ROOT,
      branch: BRANCH,
      target: 'main',
      additions: 10,
      deletions: 7,
    })
    expect(summary.files).toEqual([
      { path: 'logo.png', status: 'A', additions: null, deletions: null, binary: true },
      { path: 'notes.md', status: 'U', additions: null, deletions: null, binary: false },
      { path: 'old.ts', status: 'D', additions: 0, deletions: 5, binary: false },
      { path: 'src/app.ts', status: 'M', additions: 10, deletions: 2, binary: false },
    ])
  })

  it('falls back to master when main is missing', async () => {
    const repo = fakeRepo({ refs: ['master'] })
    const inspector = new GitDiffInspector(repo.execute, {})
    const summary = await inspector.summary('/repo')
    expect(summary.target).toBe('master')
  })

  it('reports a null target when no default branch exists', async () => {
    const repo = fakeRepo({ refs: [] })
    const inspector = new GitDiffInspector(repo.execute, {})
    const summary = await inspector.summary('/repo')
    expect(summary.target).toBeNull()
    expect(summary.files).toEqual([])
  })

  it('rejects unknown explicit targets', async () => {
    const repo = fakeRepo({ refs: ['main'] })
    const inspector = new GitDiffInspector(repo.execute, {})
    await expect(inspector.summary('/repo', 'nope')).rejects.toMatchObject({ kind: 'bad-target' })
  })

  it('caches summaries within the TTL', async () => {
    const repo = fakeRepo()
    let clock = 0
    const inspector = new GitDiffInspector(repo.execute, {}, () => clock)
    await inspector.summary('/repo')
    const callsAfterFirst = repo.calls.length
    clock = 1_000
    await inspector.summary('/repo')
    expect(repo.calls.length).toBe(callsAfterFirst)
    clock = 60_000
    await inspector.summary('/repo')
    expect(repo.calls.length).toBeGreaterThan(callsAfterFirst)
  })
})

describe('GitDiffInspector.branches', () => {
  it('lists deduplicated branches without symbolic refs like origin/HEAD', async () => {
    const repo = fakeRepo({
      refList: ['feature', 'main', 'origin\trefs/remotes/origin/main', 'origin/main', 'main', '', 'origin/feature-2'],
    })
    const inspector = new GitDiffInspector(repo.execute, {})
    const result = await inspector.branches('/repo')
    expect(result).toEqual({
      isRepo: true,
      current: BRANCH,
      branches: ['feature', 'main', 'origin/main', 'origin/feature-2'],
    })
  })

  it('reports non-repositories', async () => {
    const inspector = new GitDiffInspector(notARepo(), {})
    await expect(inspector.branches('/tmp')).resolves.toEqual({ isRepo: false })
  })
})

describe('GitDiffInspector.fileDiff', () => {
  it('runs git with difftastic as the external diff for tracked files', async () => {
    const repo = fakeRepo({ diffOutput: 'STRUCTURAL' })
    const inspector = new GitDiffInspector(repo.execute, { PATH: '/bin' })
    const diff = await inspector.fileDiff('/repo', 'src/app.ts', undefined, 120)
    expect(diff).toBe('STRUCTURAL')
    const diffCall = repo.calls.find((call) => call.args[0] === 'diff' && call.args[1] === '--ext-diff')
    expect(diffCall).toBeDefined()
    expect(diffCall?.args).toEqual(['diff', '--ext-diff', BASE, '--', 'src/app.ts'])
    expect(diffCall?.options.env).toMatchObject({
      GIT_EXTERNAL_DIFF: 'difft',
      DFT_COLOR: 'always',
      DFT_WIDTH: '120',
      PATH: '/bin',
    })
  })

  it('diffs untracked files against /dev/null with difft directly', async () => {
    const repo = fakeRepo({ untracked: ['notes.md'], diffOutput: 'NEWFILE' })
    const inspector = new GitDiffInspector(repo.execute, {})
    const diff = await inspector.fileDiff('/repo', 'notes.md', undefined, 100)
    expect(diff).toBe('NEWFILE')
    const difftCall = repo.calls.find((call) => call.file === 'difft')
    expect(difftCall?.args).toContain('/dev/null')
    expect(difftCall?.args).toContain(`${ROOT}/notes.md`)
  })

  it('rejects paths that escape the repository', async () => {
    const repo = fakeRepo()
    const inspector = new GitDiffInspector(repo.execute, {})
    await expect(inspector.fileDiff('/repo', '../secret', undefined, 100))
      .rejects.toMatchObject({ kind: 'bad-file' })
    await expect(inspector.fileDiff('/repo', '/etc/passwd', undefined, 100))
      .rejects.toMatchObject({ kind: 'bad-file' })
  })

  it('maps a missing difft binary to a helpful error', async () => {
    const repo = fakeRepo({ diffFailure: failure('external diff died, stopping at src/app.ts') })
    const inspector = new GitDiffInspector(repo.execute, {})
    await expect(inspector.fileDiff('/repo', 'src/app.ts', undefined, 100))
      .rejects.toMatchObject({ kind: 'difft-missing' })
  })
})

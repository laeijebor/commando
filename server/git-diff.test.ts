import { describe, expect, it } from 'vitest'
import {
  GitCommandFailure,
  GitDiffError,
  GitDiffInspector,
  validateDiffDisplay,
  validateDiffEngine,
  validateDiffSearchQuery,
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
  branch?: string
  refs?: string[]
  numstat?: string
  nameStatus?: string
  untracked?: string[]
  diffOutput?: string
  diffFailure?: GitCommandFailure
  searchPatch?: string
  refList?: string[]
  /** Lines for the auto-base for-each-ref call: `sha<TAB>shortname<TAB>symref`. */
  refTips?: string[]
  autoUnique?: string[]
  autoBoundary?: string[]
  nameRev?: string
  pullRequestOutput?: string
  pullRequestsByNumber?: Record<string, string>
  pullRequestFailure?: GitCommandFailure
}

function failure(stderr = '', missingBinary = false): GitCommandFailure {
  return new GitCommandFailure('git failed', stderr, missingBinary)
}

function fakeRepo(options: FakeRepoOptions = {}) {
  const {
    branch = BRANCH,
    refs = ['main'],
    numstat = '',
    nameStatus = '',
    untracked = [],
    diffOutput = 'DIFF',
    diffFailure,
    searchPatch = '',
    refList = [],
    refTips = ['mainsha\tmain\t'],
    autoUnique = ['uniquesha'],
    autoBoundary = [BASE],
    nameRev = 'origin/main',
    pullRequestOutput = '',
    pullRequestsByNumber = {},
    pullRequestFailure,
  } = options
  const calls: Call[] = []
  const execute: GitProcessExecutor = async (file, args, executorOptions) => {
    calls.push({ file, args: [...args], options: executorOptions })
    const joined = args.join(' ')
    if (file === 'gh') {
      if (pullRequestFailure) throw pullRequestFailure
      const requestedNumber = args[2] !== '--json' ? args[2] : undefined
      if (requestedNumber) {
        const output = pullRequestsByNumber[requestedNumber]
        if (output === undefined) throw failure('pull request not found')
        return { stdout: output, stderr: '' }
      }
      return { stdout: pullRequestOutput, stderr: '' }
    }
    if (file === 'difft') return { stdout: diffOutput, stderr: '' }
    if (file === 'delta') return { stdout: `DELTA:${executorOptions.input ?? ''}`, stderr: '' }
    if (joined === 'rev-parse --show-toplevel --abbrev-ref HEAD') {
      return { stdout: `${ROOT}\n${branch}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const ref = args[3].replace(/\^\{commit\}$/u, '')
      if (refs.includes(ref)) return { stdout: 'sha\n', stderr: '' }
      throw failure()
    }
    if (args[0] === 'merge-base') return { stdout: `${BASE}\n`, stderr: '' }
    if (args[0] === 'for-each-ref' && args[1]?.startsWith('--format=%(objectname)')) {
      return { stdout: refTips.join('\n'), stderr: '' }
    }
    if (args[0] === 'for-each-ref') return { stdout: refList.join('\n'), stderr: '' }
    if (args[0] === 'rev-list' && args[1] === '--boundary') {
      const lines = [...autoUnique, ...autoBoundary.map((sha) => `-${sha}`)]
      return { stdout: lines.join('\n'), stderr: '' }
    }
    if (args[0] === 'rev-list' && args[1] === '--no-walk=sorted') {
      return { stdout: `${autoBoundary[0] ?? ''}\n`, stderr: '' }
    }
    if (args[0] === 'name-rev') return { stdout: `${nameRev}\n`, stderr: '' }
    if (args[0] === 'diff' && args.includes('--numstat')) return { stdout: numstat, stderr: '' }
    if (args[0] === 'diff' && args.includes('--name-status')) return { stdout: nameStatus, stderr: '' }
    if (args[0] === 'diff' && args.includes('--unified=0')) return { stdout: searchPatch, stderr: '' }
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
    if (args[0] === 'diff') return { stdout: 'PATCH', stderr: '' }
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

describe('validateDiffEngine / validateDiffDisplay', () => {
  it('defaults and validates', () => {
    expect(validateDiffEngine(undefined)).toBe('difftastic')
    expect(validateDiffEngine('delta')).toBe('delta')
    expect(() => validateDiffEngine('meld')).toThrow(GitDiffError)
    expect(validateDiffDisplay(undefined)).toBe('side-by-side')
    expect(validateDiffDisplay('inline')).toBe('inline')
    expect(() => validateDiffDisplay('unified')).toThrow(GitDiffError)
  })
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

describe('validateDiffSearchQuery', () => {
  it('trims valid queries and rejects empty or oversized values', () => {
    expect(validateDiffSearchQuery('  needle  ')).toBe('needle')
    expect(() => validateDiffSearchQuery('   ')).toThrow(GitDiffError)
    expect(() => validateDiffSearchQuery('x'.repeat(201))).toThrow(GitDiffError)
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
      target: `origin/main @ ${BASE.slice(0, 7)}`,
      targetMode: 'auto',
      baseCommit: BASE,
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

  it('reports the open pull request associated with the current branch', async () => {
    const repo = fakeRepo({
      pullRequestOutput: JSON.stringify({
        number: 42,
        title: 'Show pull requests in pane footers',
        url: 'https://github.com/example/commando/pull/42',
        state: 'OPEN',
        isDraft: true,
      }),
    })
    const inspector = new GitDiffInspector(repo.execute, { PATH: '/bin' })

    const summary = await inspector.summary('/repo')

    expect(summary.pullRequest).toEqual({
      number: 42,
      title: 'Show pull requests in pane footers',
      url: 'https://github.com/example/commando/pull/42',
      isDraft: true,
    })
    const call = repo.calls.find((entry) => entry.file === 'gh')
    expect(call?.args).toEqual(['pr', 'view', '--json', 'number,title,url,state,isDraft'])
    expect(call?.options).toMatchObject({ cwd: ROOT, shell: false })
    expect(call?.options.env).toMatchObject({ PATH: '/bin', GH_PROMPT_DISABLED: '1' })
  })

  it('ignores closed pull requests and malformed pull request URLs', async () => {
    const closed = fakeRepo({
      pullRequestOutput: JSON.stringify({
        number: 42,
        title: 'Already merged',
        url: 'https://github.com/example/commando/pull/42',
        state: 'MERGED',
        isDraft: false,
      }),
    })
    const malformed = fakeRepo({
      pullRequestOutput: JSON.stringify({
        number: 43,
        title: 'Unsafe URL',
        url: 'javascript:alert(1)',
        state: 'OPEN',
        isDraft: false,
      }),
    })

    await expect(new GitDiffInspector(closed.execute, {}).summary('/repo'))
      .resolves.not.toHaveProperty('pullRequest')
    await expect(new GitDiffInspector(malformed.execute, {}).summary('/repo'))
      .resolves.not.toHaveProperty('pullRequest')
  })

  it('keeps the Git summary available when GitHub CLI is unavailable', async () => {
    const repo = fakeRepo({ pullRequestFailure: failure('', true) })
    const inspector = new GitDiffInspector(repo.execute, {})

    const summary = await inspector.summary('/repo')

    expect(summary).toMatchObject({ isRepo: true, branch: BRANCH, targetMode: 'auto' })
    expect(summary.pullRequest).toBeUndefined()
  })

  it('skips pull request discovery for a detached HEAD', async () => {
    const repo = fakeRepo({ branch: 'HEAD' })
    const inspector = new GitDiffInspector(repo.execute, {})

    await inspector.summary('/repo')

    expect(repo.calls).not.toContainEqual(expect.objectContaining({ file: 'gh' }))
  })

  it('resolves the latest explicitly linked open pull request from pane evidence', async () => {
    const repo = fakeRepo({
      pullRequestsByNumber: {
        '109': JSON.stringify({
          number: 109,
          title: 'Add video indicators to exercise picker',
          url: 'https://github.com/laeijebor/vivifit/pull/109',
          state: 'OPEN',
          isDraft: false,
        }),
      },
    })
    const inspector = new GitDiffInspector(repo.execute, {})
    const evidence = '\u001b]8;id=pr;https://github.com/laeijebor/vivifit/pull/109\u001b\\PR #109\u001b]8;;\u001b\\'

    await expect(inspector.pullRequestFromEvidence(ROOT, evidence)).resolves.toEqual({
      number: 109,
      title: 'Add video indicators to exercise picker',
      url: 'https://github.com/laeijebor/vivifit/pull/109',
      isDraft: false,
    })
    const call = repo.calls.find((entry) => entry.file === 'gh')
    expect(call?.args).toEqual(['pr', 'view', '109', '--json', 'number,title,url,state,isDraft'])
  })

  it('rejects merged and foreign-repository pull request evidence', async () => {
    const merged = fakeRepo({
      pullRequestsByNumber: {
        '109': JSON.stringify({
          number: 109,
          title: 'Already merged',
          url: 'https://github.com/laeijebor/vivifit/pull/109',
          state: 'MERGED',
          isDraft: false,
        }),
      },
    })
    const foreign = fakeRepo({
      pullRequestsByNumber: {
        '109': JSON.stringify({
          number: 109,
          title: 'Different repository',
          url: 'https://github.com/laeijebor/vivifit/pull/109',
          state: 'OPEN',
          isDraft: false,
        }),
      },
    })

    await expect(new GitDiffInspector(merged.execute, {}).pullRequestFromEvidence(
      ROOT,
      'https://github.com/laeijebor/vivifit/pull/109',
    )).resolves.toBeUndefined()
    await expect(new GitDiffInspector(foreign.execute, {}).pullRequestFromEvidence(
      ROOT,
      'https://github.com/example/another-repo/pull/109',
    )).resolves.toBeUndefined()
  })

  it('does not fall back to an older open PR when the latest referenced PR is closed', async () => {
    const repo = fakeRepo({
      pullRequestsByNumber: {
        '108': JSON.stringify({
          number: 108,
          title: 'Older open PR',
          url: 'https://github.com/laeijebor/vivifit/pull/108',
          state: 'OPEN',
          isDraft: false,
        }),
        '109': JSON.stringify({
          number: 109,
          title: 'Latest merged PR',
          url: 'https://github.com/laeijebor/vivifit/pull/109',
          state: 'MERGED',
          isDraft: false,
        }),
      },
    })
    const inspector = new GitDiffInspector(repo.execute, {})

    await expect(inspector.pullRequestFromEvidence(
      ROOT,
      'Earlier https://github.com/laeijebor/vivifit/pull/108 then https://github.com/laeijebor/vivifit/pull/109',
    )).resolves.toBeUndefined()
    expect(repo.calls.filter((entry) => entry.file === 'gh')).toHaveLength(1)
    expect(repo.calls.find((entry) => entry.file === 'gh')?.args[2]).toBe('109')
  })

  it('ignores evidence without an explicit pull request URL', async () => {
    const repo = fakeRepo()
    const inspector = new GitDiffInspector(repo.execute, {})

    await expect(inspector.pullRequestFromEvidence(ROOT, 'PR #109 is open')).resolves.toBeUndefined()
    expect(repo.calls).not.toContainEqual(expect.objectContaining({ file: 'gh' }))
  })

  it('uses the merge base for an explicit target', async () => {
    const repo = fakeRepo({ refs: ['develop'] })
    const inspector = new GitDiffInspector(repo.execute, {})
    const summary = await inspector.summary('/repo', 'develop')
    expect(summary).toMatchObject({ target: 'develop', targetMode: 'ref', baseCommit: BASE })
    const numstatCall = repo.calls.find((call) => call.args.includes('--numstat'))
    expect(numstatCall?.args).toContain(BASE)
  })

  it('excludes this branch and its remote copies from branch-point detection', async () => {
    const repo = fakeRepo({
      refTips: [
        `headsha\t${BRANCH}\t`,
        `pushsha\torigin/${BRANCH}\t`,
        'symsha\torigin\trefs/remotes/origin/main',
        'mainsha\tmain\t',
      ],
    })
    const inspector = new GitDiffInspector(repo.execute, {})
    await inspector.summary('/repo')
    const revList = repo.calls.find((call) => call.args[0] === 'rev-list' && call.args[1] === '--boundary')
    expect(revList?.args).toContain('mainsha')
    expect(revList?.args).not.toContain('headsha')
    expect(revList?.args).not.toContain('pushsha')
    expect(revList?.args).not.toContain('symsha')
  })

  it('falls back to uncommitted changes when the branch has no own commits', async () => {
    const repo = fakeRepo({ autoUnique: [], autoBoundary: [] })
    const inspector = new GitDiffInspector(repo.execute, {})
    const summary = await inspector.summary('/repo')
    expect(summary.target).toBe('HEAD (uncommitted changes)')
    expect(summary.targetMode).toBe('auto')
    const numstatCall = repo.calls.find((call) => call.args.includes('--numstat'))
    expect(numstatCall?.args).toContain('HEAD')
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

  it('passes the requested display mode to difftastic', async () => {
    const repo = fakeRepo()
    const inspector = new GitDiffInspector(repo.execute, {})
    await inspector.fileDiff('/repo', 'src/app.ts', undefined, 120, 'difftastic', 'inline')
    const diffCall = repo.calls.find((call) => call.args[1] === '--ext-diff')
    expect(diffCall?.options.env).toMatchObject({ DFT_DISPLAY: 'inline' })
  })

  it('pipes the git patch through delta for tracked files', async () => {
    const repo = fakeRepo()
    const inspector = new GitDiffInspector(repo.execute, {})
    const diff = await inspector.fileDiff('/repo', 'src/app.ts', undefined, 120, 'delta', 'side-by-side')
    expect(diff).toBe('DELTA:PATCH')
    const gitCall = repo.calls.find((call) => call.file === 'git' && call.args[0] === 'diff')
    expect(gitCall?.args).toEqual(['diff', BASE, '--', 'src/app.ts'])
    const deltaCall = repo.calls.find((call) => call.file === 'delta')
    expect(deltaCall?.args).toContain('--side-by-side')
    expect(deltaCall?.args).toContain('--width')
    expect(deltaCall?.options.input).toBe('PATCH')
    expect(deltaCall?.options.allowExitCodes).toContain(1)
  })

  it('omits the side-by-side flag for inline delta diffs', async () => {
    const repo = fakeRepo()
    const inspector = new GitDiffInspector(repo.execute, {})
    await inspector.fileDiff('/repo', 'src/app.ts', undefined, 120, 'delta', 'inline')
    const deltaCall = repo.calls.find((call) => call.file === 'delta')
    expect(deltaCall?.args).not.toContain('--side-by-side')
  })

  it('compares untracked files directly with delta', async () => {
    const repo = fakeRepo({ untracked: ['notes.md'] })
    const inspector = new GitDiffInspector(repo.execute, {})
    await inspector.fileDiff('/repo', 'notes.md', undefined, 120, 'delta', 'side-by-side')
    const deltaCall = repo.calls.find((call) => call.file === 'delta')
    expect(deltaCall?.args).toContain('/dev/null')
    expect(deltaCall?.args).toContain(`${ROOT}/notes.md`)
    expect(deltaCall?.options.allowExitCodes).toContain(1)
  })

  it('maps a missing difft binary to a helpful error', async () => {
    const repo = fakeRepo({ diffFailure: failure('external diff died, stopping at src/app.ts') })
    const inspector = new GitDiffInspector(repo.execute, {})
    await expect(inspector.fileDiff('/repo', 'src/app.ts', undefined, 100))
      .rejects.toMatchObject({ kind: 'tool-missing' })
  })
})

describe('GitDiffInspector.search', () => {
  it('finds case-insensitive matches on both sides of changed tracked lines', async () => {
    const repo = fakeRepo({
      searchPatch: [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10 +10,2 @@',
        '-old Needle',
        '+new needle',
        '+needle twice needle',
      ].join('\n'),
    })
    const inspector = new GitDiffInspector(repo.execute, {})

    await expect(inspector.search('/repo', 'needle')).resolves.toEqual({
      query: 'needle',
      matches: [
        { file: 'src/app.ts', line: 10, side: 'removed', preview: 'old Needle', occurrences: 1 },
        { file: 'src/app.ts', line: 10, side: 'added', preview: 'new needle', occurrences: 1 },
        { file: 'src/app.ts', line: 11, side: 'added', preview: 'needle twice needle', occurrences: 2 },
      ],
      totalMatches: 4,
      matchingFiles: 1,
      truncated: false,
    })
    expect(repo.calls).toContainEqual(expect.objectContaining({
      file: 'git',
      args: ['diff', '--no-color', '--no-ext-diff', '--unified=0', '--no-renames', BASE, '--'],
    }))
  })

  it('includes untracked text files in the same search result', async () => {
    const repo = fakeRepo({ untracked: ['notes.md'] })
    const inspector = new GitDiffInspector(
      repo.execute,
      {},
      Date.now,
      async (file) => file.endsWith('notes.md') ? 'First needle\nNo match\nNEEDLE again' : '',
    )

    await expect(inspector.search('/repo', 'needle')).resolves.toMatchObject({
      totalMatches: 2,
      matchingFiles: 1,
      matches: [
        { file: 'notes.md', line: 1, side: 'added', preview: 'First needle', occurrences: 1 },
        { file: 'notes.md', line: 3, side: 'added', preview: 'NEEDLE again', occurrences: 1 },
      ],
    })
  })
})

import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  GitCommandFailure,
  GitDiffError,
  GitDiffInspector,
  MAX_FILE_CONTENTS_BYTES,
  parseBlamePorcelain,
  validateBlameRev,
  validateDiffDisplay,
  validateDiffEngine,
  validateDiffSearchQuery,
  validateDiffWidth,
  validateGitTarget,
  type GitExecutorOptions,
  type GitProcessExecutor,
  type WorktreeEntry,
  type WorktreeFiles,
} from './git-diff.js'

const NUL = String.fromCharCode(0)
const ROOT = '/repo'
const BRANCH = 'feature'
const BASE = 'basesha'

type Call = { file: string; args: string[]; options: GitExecutorOptions }

type FakeRepoOptions = {
  branch?: string
  refs?: string[]
  remotes?: Record<string, string>
  mergeBase?: string
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
    remotes = { origin: 'git@github.com:acme/widgets.git' },
    mergeBase = BASE,
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
    if (joined === 'remote') return { stdout: Object.keys(remotes).join('\n'), stderr: '' }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      if (remotes[args[2]] === '!error') throw new Error(`fatal: No such remote '${args[2]}'`)
      return { stdout: remotes[args[2]] ?? '', stderr: '' }
    }
    if (args[0] === 'merge-base') {
      if (mergeBase === '!timeout') throw new GitCommandFailure('git timed out', '', false)
      return { stdout: `${mergeBase}\n`, stderr: '' }
    }
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

  it('caches branch pull request lookups across summary polls', async () => {
    const found = fakeRepo({
      pullRequestOutput: JSON.stringify({ number: 42, title: 'T', url: 'https://github.com/example/commando/pull/42', state: 'OPEN', isDraft: false }),
    })
    let now = 0
    const inspector = new GitDiffInspector(found.execute, {}, () => now)
    const lookups = () => found.calls.filter((entry) => entry.file === 'gh').length
    await inspector.summary('/repo')
    now = 2 * 60_000
    expect((await inspector.summary('/repo')).pullRequest?.number).toBe(42)
    expect(lookups()).toBe(1)
    now = 4 * 60_000
    await inspector.summary('/repo')
    expect(lookups()).toBe(2)

    const missing = fakeRepo({ pullRequestOutput: '' })
    now = 0
    const missingInspector = new GitDiffInspector(missing.execute, {}, () => now)
    const missingLookups = () => missing.calls.filter((entry) => entry.file === 'gh').length
    await missingInspector.summary('/repo')
    now = 30_000
    await missingInspector.summary('/repo')
    expect(missingLookups()).toBe(1)
    now = 90_000
    await missingInspector.summary('/repo')
    expect(missingLookups()).toBe(2)
  })

  it('skips branch PR lookups while PR sync is paused and reports GitHub throttling', async () => {
    let pausedUntil = 0
    const github = { pausedUntil: vi.fn(() => pausedUntil), rateLimited: vi.fn() }
    const found = fakeRepo({
      pullRequestOutput: JSON.stringify({ number: 42, title: 'T', url: 'https://github.com/example/commando/pull/42', state: 'OPEN', isDraft: false }),
    })
    let now = 0
    const inspector = new GitDiffInspector(found.execute, {}, () => now, undefined, github)
    await inspector.summary('/repo')
    pausedUntil = 60 * 60_000
    now = 10 * 60_000
    expect((await inspector.summary('/repo')).pullRequest?.number).toBe(42)
    expect(found.calls.filter((entry) => entry.file === 'gh')).toHaveLength(1)

    const throttled = fakeRepo({ pullRequestFailure: failure('gh: API rate limit exceeded for user ID 1 (HTTP 403)') })
    await new GitDiffInspector(throttled.execute, {}, () => 0, undefined, { pausedUntil: () => 0, rateLimited: github.rateLimited }).summary('/repo')
    expect(github.rateLimited).toHaveBeenCalledWith('graphql', expect.stringContaining('rate limit'))

    // The lookup that hits the throttle keeps the PR it already knew about.
    let fail = false
    const flaky = fakeRepo({ pullRequestOutput: JSON.stringify({ number: 7, title: 'T', url: 'https://github.com/example/commando/pull/7', state: 'OPEN', isDraft: false }) })
    const execute: typeof flaky.execute = (file, args, options) => fail && file === 'gh'
      ? Promise.reject(failure('gh: API rate limit exceeded for user ID 1 (HTTP 403)'))
      : flaky.execute(file, args, options)
    let at = 0
    const keeping = new GitDiffInspector(execute, {}, () => at, undefined, { pausedUntil: () => 0, rateLimited: () => undefined })
    await keeping.summary('/repo')
    fail = true
    at = 4 * 60_000
    expect((await keeping.summary('/repo')).pullRequest?.number).toBe(7)
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

  it('compares an explicit base and head without including working-tree files', async () => {
    const repo = fakeRepo({ refs: ['base-tip', 'head-tip'], untracked: ['notes.md'] })
    const inspector = new GitDiffInspector(repo.execute, {})

    const summary = await inspector.summary('/repo', 'base-tip', 'head-tip')

    expect(summary).toMatchObject({
      target: 'base-tip…head-tip',
      targetMode: 'ref',
      baseCommit: BASE,
    })
    expect(repo.calls).toContainEqual(expect.objectContaining({
      file: 'git',
      args: ['merge-base', 'base-tip', 'head-tip'],
    }))
    expect(repo.calls.find((call) => call.args.includes('--numstat'))?.args).toContain('head-tip')
    expect(repo.calls.some((call) => call.args[0] === 'ls-files')).toBe(false)
  })

  it.each(['summary', 'difftastic', 'delta', 'search'] as const)('uses a local base fallback for %s when the pinned base is missing and the head is not an ancestor', async (operation) => {
    const repo = fakeRepo({ refs: ['refs/remotes/origin/main', 'head-tip'], numstat: `1\t0\tsrc/app.ts${NUL}`, nameStatus: `M${NUL}src/app.ts${NUL}` })
    const inspector = new GitDiffInspector(repo.execute, {})
    if (operation === 'summary') {
      await expect(inspector.summary('/repo', 'missing-base', 'head-tip', 'acme/widgets', 'main'))
        .resolves.toMatchObject({ files: [{ path: 'src/app.ts' }], target: 'origin/main…head-tip' })
      // A fallback summary must not populate the exact-only comparison cache.
      await expect(inspector.summary('/repo', 'missing-base', 'head-tip')).rejects.toThrow('Unknown git ref: missing-base')
    } else if (operation === 'search') {
      await inspector.search('/repo', 'needle', 'missing-base', 'head-tip', 'acme/widgets', 'main')
    } else {
      await inspector.fileDiff('/repo', 'src/app.ts', 'missing-base', 120, operation, 'inline', 'head-tip', 'acme/widgets', 'main')
    }
    expect(repo.calls).toContainEqual(expect.objectContaining({ args: ['merge-base', 'refs/remotes/origin/main', 'head-tip'] }))
    expect(repo.calls.filter((call) => call.args[0] === 'rev-parse' && call.args[1] === '--verify').slice(0, 3).map((call) => call.args[3]))
      .toEqual(['missing-base^{commit}', 'refs/remotes/origin/main^{commit}', 'head-tip^{commit}'])
    expect(repo.calls.some((call) => call.args[0] === 'fetch')).toBe(false)
  })

  it.each(['summary', 'difftastic', 'delta', 'search'] as const)('rejects the %s base fallback when its branch already contains the head', async (operation) => {
    // The head is a named ref; its resolved OID is "sha" in this fixture.
    const repo = fakeRepo({ refs: ['refs/remotes/origin/main', 'head-tip'], mergeBase: 'sha' })
    const inspector = new GitDiffInspector(repo.execute, {})
    const request = operation === 'summary' ? inspector.summary('/repo', 'missing-base', 'head-tip', 'acme/widgets', 'main')
      : operation === 'search' ? inspector.search('/repo', 'needle', 'missing-base', 'head-tip', 'acme/widgets', 'main')
        : inspector.fileDiff('/repo', 'src/app.ts', 'missing-base', 120, operation, 'inline', 'head-tip', 'acme/widgets', 'main')
    await expect(request).rejects.toMatchObject({
      kind: 'bad-target',
      message: "The PR's base commit isn't in this repo and its branch already contains the PR",
    })
    expect(repo.calls.some((call) => call.args[0] === 'diff')).toBe(false)
  })

  it('prefers the pinned base even when the remote branch already contains a merged PR', async () => {
    const repo = fakeRepo({ refs: ['base-tip', 'head-tip', 'refs/remotes/origin/main'], mergeBase: 'sha' })
    await new GitDiffInspector(repo.execute, {}).summary('/repo', 'base-tip', 'head-tip', 'acme/widgets', 'main')
    expect(repo.calls).toContainEqual(expect.objectContaining({ args: ['merge-base', 'base-tip', 'head-tip'] }))
    expect(repo.calls.some((call) => call.args.includes('refs/remotes/origin/main^{commit}'))).toBe(false)
    expect(repo.calls.some((call) => call.args[0] === 'remote')).toBe(false)
  })

  it.each(['git@GitHub.com:ACME/Widgets.git', 'https://GITHUB.com/Acme/Widgets.git', 'ssh://git@github.com/acme/widgets.git'])(
    'matches the PR repository to upstream using the fetch URL %s', async (url) => {
      const repo = fakeRepo({ refs: ['refs/remotes/origin/main', 'refs/remotes/upstream/main', 'head-tip'],
        remotes: { origin: 'https://github.com/fork/widgets.git', upstream: url } })
      const summary = await new GitDiffInspector(repo.execute, {}).summary('/repo', 'missing-base', 'head-tip', 'acme/widgets', 'main')
      expect(summary.target).toBe('upstream/main…head-tip')
      expect(repo.calls).toContainEqual(expect.objectContaining({ args: ['merge-base', 'refs/remotes/upstream/main', 'head-tip'] }))
      expect(repo.calls.some((call) => call.args.includes('refs/remotes/origin/main^{commit}'))).toBe(false)
    },
  )

  it('skips a remote whose URL cannot be read and uses the next matching remote', async () => {
    const repo = fakeRepo({ refs: ['refs/remotes/upstream/main', 'head-tip'],
      remotes: { broken: '!error', upstream: 'https://github.com/acme/widgets.git' } })
    const summary = await new GitDiffInspector(repo.execute, {}).summary('/repo', 'missing-base', 'head-tip', 'acme/widgets', 'main')
    expect(summary.target).toBe('upstream/main…head-tip')
  })

  it('rejects a fallback with no common ancestor instead of diffing unrelated trees', async () => {
    const repo = fakeRepo({ refs: ['refs/remotes/upstream/main', 'head-tip'], mergeBase: '',
      remotes: { upstream: 'https://github.com/acme/widgets.git' } })
    await expect(new GitDiffInspector(repo.execute, {}).summary('/repo', 'missing-base', 'head-tip', 'acme/widgets', 'main'))
      .rejects.toMatchObject({ kind: 'bad-target' })
    expect(repo.calls.some((call) => call.args[0] === 'diff')).toBe(false)
  })

  it('rejects a pinned PR comparison with no common ancestor', async () => {
    const repo = fakeRepo({ refs: ['base-tip', 'head-tip'], mergeBase: '' })
    await expect(new GitDiffInspector(repo.execute, {}).summary('/repo', 'base-tip', 'head-tip'))
      .rejects.toMatchObject({ kind: 'bad-target' })
    expect(repo.calls.some((call) => call.args[0] === 'diff')).toBe(false)
  })

  it('reports a merge-base timeout as a git failure, not a missing common ancestor', async () => {
    const repo = fakeRepo({ refs: ['base-tip', 'head-tip'], mergeBase: '!timeout' })
    const failure = await new GitDiffInspector(repo.execute, {}).summary('/repo', 'base-tip', 'head-tip').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GitCommandFailure)
  })

  it('uses the remote-tracking ref even when a local branch has the same short name', async () => {
    const repo = fakeRepo({ refs: ['origin/main', 'refs/remotes/origin/main', 'head-tip'] })
    const summary = await new GitDiffInspector(repo.execute, {}).summary('/repo', 'missing-base', 'head-tip', 'acme/widgets', 'main')
    expect(summary.target).toBe('origin/main…head-tip')
    expect(repo.calls).toContainEqual(expect.objectContaining({ args: ['merge-base', 'refs/remotes/origin/main', 'head-tip'] }))
    expect(repo.calls.some((call) => call.args.includes('origin/main^{commit}'))).toBe(false)
  })

  it('rejects an origin fork instead of diffing against the wrong repository', async () => {
    const repo = fakeRepo({ refs: ['refs/remotes/origin/main', 'head-tip'], remotes: { origin: 'git@github.com:fork/widgets.git' } })
    await expect(new GitDiffInspector(repo.execute, {}).summary('/repo', 'missing-base', 'head-tip', 'acme/widgets', 'main'))
      .rejects.toMatchObject({ kind: 'bad-target', message: 'Unknown git ref: missing-base' })
    expect(repo.calls.some((call) => call.args[0] === 'merge-base')).toBe(false)
    expect(repo.calls.some((call) => call.args.includes('refs/remotes/origin/main^{commit}'))).toBe(false)
  })

  it('rejects a matching remote without a local base ref', async () => {
    const repo = fakeRepo({ refs: ['head-tip'], remotes: { upstream: 'https://github.com/acme/widgets' } })
    await expect(new GitDiffInspector(repo.execute, {}).summary('/repo', 'missing-base', 'head-tip', 'acme/widgets', 'main'))
      .rejects.toMatchObject({ kind: 'bad-target', message: 'Unknown git ref: missing-base' })
    expect(repo.calls.some((call) => call.args[0] === 'merge-base')).toBe(false)
  })

  it('still rejects a missing head when the base fallback exists', async () => {
    const repo = fakeRepo({ refs: ['refs/remotes/origin/main'] })
    await expect(new GitDiffInspector(repo.execute, {}).summary('/repo', 'missing-base', 'missing-head', 'acme/widgets', 'main'))
      .rejects.toThrow('Unknown git ref: missing-head')
  })

  it('validates the fallback and restricts it to explicit comparisons', async () => {
    const repo = fakeRepo({ refs: ['base-tip', 'head-tip'] })
    const inspector = new GitDiffInspector(repo.execute, {})
    await expect(inspector.summary('/repo', 'base-tip', 'head-tip', 'acme/widgets', '--unsafe')).rejects.toThrow('Invalid git target ref')
    await expect(inspector.summary('/repo', 'base-tip', 'head-tip', '../invalid', 'main')).rejects.toThrow('Invalid PR base fallback repository')
    await expect(inspector.summary('/repo', 'base-tip', 'head-tip', 'acme/widgets')).rejects.toThrow('Invalid git target ref')
    await expect(inspector.summary('/repo', 'base-tip', undefined, 'acme/widgets', 'main')).rejects.toThrow('requires an explicit base and head')
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

  it('runs difftastic against an explicit head commit for PR comparisons', async () => {
    const repo = fakeRepo({ refs: ['base-tip', 'head-tip'], diffOutput: 'STRUCTURAL' })
    const inspector = new GitDiffInspector(repo.execute, {})

    await inspector.fileDiff('/repo', 'src/app.ts', 'base-tip', 120, 'difftastic', 'side-by-side', 'head-tip')

    expect(repo.calls.find((call) => call.args[1] === '--ext-diff')?.args).toEqual([
      'diff', '--ext-diff', BASE, 'head-tip', '--', 'src/app.ts',
    ])
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

  it('pipes the explicit PR comparison range through delta', async () => {
    const repo = fakeRepo({ refs: ['base-tip', 'head-tip'] })
    const inspector = new GitDiffInspector(repo.execute, {})

    await inspector.fileDiff('/repo', 'src/app.ts', 'base-tip', 120, 'delta', 'inline', 'head-tip')

    expect(repo.calls.find((call) => call.file === 'git' && call.args[0] === 'diff')?.args).toEqual([
      'diff', BASE, 'head-tip', '--', 'src/app.ts',
    ])
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
      files: [{ file: 'src/app.ts', matches: 4 }],
      totalMatches: 4,
      matchingFiles: 1,
      truncated: false,
    })
    expect(repo.calls).toContainEqual(expect.objectContaining({
      file: 'git',
      args: ['diff', '--no-color', '--no-ext-diff', '--unified=0', '--no-renames', BASE, '--'],
    }))
  })

  it('searches the explicit PR comparison range', async () => {
    const repo = fakeRepo({ refs: ['base-tip', 'head-tip'] })
    const inspector = new GitDiffInspector(repo.execute, {})

    await inspector.search('/repo', 'needle', 'base-tip', 'head-tip')

    expect(repo.calls).toContainEqual(expect.objectContaining({
      file: 'git',
      args: ['diff', '--no-color', '--no-ext-diff', '--unified=0', '--no-renames', BASE, 'head-tip', '--'],
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
      files: [{ file: 'notes.md', matches: 2 }],
    })
  })
})

const BASE_SHA = 'b'.repeat(40)
const HEAD_SHA = 'c'.repeat(40)
const OTHER_SHA = 'd'.repeat(40)
const ZERO_SHA = '0'.repeat(40)

type TreeFile = string | { size: number }

type ContentsRepoOptions = FakeRepoOptions & {
  /** Commit trees by full SHA: path -> contents (or just a size, for oversize blobs). */
  trees?: Record<string, Record<string, TreeFile>>
  blameOutput?: string
  blameFailure?: GitCommandFailure
}

/** fakeRepo plus the commands fileContents and blame run. */
function contentsRepo(options: ContentsRepoOptions = {}) {
  const { trees = {}, blameOutput = '', blameFailure, ...repoOptions } = options
  const repo = fakeRepo(repoOptions)
  const shas: Record<string, string> = { [BASE]: BASE_SHA, 'head-tip': HEAD_SHA }
  const blobs = new Map<string, string>()
  const execute: GitProcessExecutor = async (file, args, executorOptions) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--verify' && shas[args[3].replace(/\^\{commit\}$/u, '')]) {
      repo.calls.push({ file, args: [...args], options: executorOptions })
      return { stdout: `${shas[args[3].replace(/\^\{commit\}$/u, '')]}\n`, stderr: '' }
    }
    if (file === 'git' && args[0] === 'ls-tree') {
      repo.calls.push({ file, args: [...args], options: executorOptions })
      const [, , , sha, , relative] = args
      const entry = trees[sha]?.[relative]
      if (entry === undefined) return { stdout: '', stderr: '' }
      const object = `blob-${sha.slice(0, 1)}-${relative}`
      const size = typeof entry === 'string' ? Buffer.byteLength(entry) : entry.size
      if (typeof entry === 'string') blobs.set(object, entry)
      return { stdout: `100644 blob ${object} ${String(size).padStart(7)}\t${relative}${NUL}`, stderr: '' }
    }
    if (file === 'git' && args[0] === 'cat-file') {
      repo.calls.push({ file, args: [...args], options: executorOptions })
      return { stdout: blobs.get(args[2]) ?? '', stderr: '' }
    }
    if (file === 'git' && args[0] === 'blame') {
      repo.calls.push({ file, args: [...args], options: executorOptions })
      if (blameFailure) throw blameFailure
      return { stdout: blameOutput, stderr: '' }
    }
    return repo.execute(file, args, executorOptions)
  }
  return { calls: repo.calls, execute }
}

type DiskFile = string | { symlink: string } | { size: number } | 'directory'

/** An in-memory working tree under ROOT; `links` maps directories to their real paths. */
function fakeDisk(files: Record<string, DiskFile>, links: Record<string, string> = {}) {
  const absolute = (relative: string) => `${ROOT}/${relative}`
  const lookup = (file: string) => Object.entries(files).find(([relative]) => absolute(relative) === file)?.[1]
  const reads: string[] = []
  const worktree: WorktreeFiles = {
    async entry(file): Promise<WorktreeEntry | undefined> {
      const value = lookup(file)
      if (value === undefined) return undefined
      if (value === 'directory') return { kind: 'directory', size: 0 }
      if (typeof value === 'string') return { kind: 'file', size: Buffer.byteLength(value) }
      if ('symlink' in value) return { kind: 'symlink', size: value.symlink.length }
      return { kind: 'file', size: value.size }
    },
    async readlink(file) {
      const value = lookup(file)
      if (typeof value === 'object' && 'symlink' in value) return value.symlink
      throw new Error('not a symlink')
    },
    async realpath(file) {
      return links[file] ?? file
    },
  }
  const readTextFile = async (file: string) => {
    reads.push(file)
    const value = lookup(file)
    if (typeof value !== 'string') throw new Error(`cannot read ${file}`)
    return value
  }
  return { worktree, readTextFile, reads }
}

function contentsInspector(repo: { execute: GitProcessExecutor }, disk = fakeDisk({}), now: () => number = Date.now) {
  return new GitDiffInspector(repo.execute, {}, now, disk.readTextFile, undefined, disk.worktree)
}

describe('GitDiffInspector.fileContents', () => {
  it('reads the base side from the resolved base commit and the new side from disk', async () => {
    const repo = contentsRepo({ trees: { [BASE_SHA]: { 'src/app.ts': 'old\n' } } })
    const disk = fakeDisk({ 'src/app.ts': 'new\n' })

    await expect(contentsInspector(repo, disk).fileContents('/repo', 'src/app.ts')).resolves.toEqual({
      file: 'src/app.ts',
      old: { path: 'src/app.ts', contents: 'old\n', rev: BASE_SHA },
      new: { path: 'src/app.ts', contents: 'new\n', rev: 'worktree' },
    })
    expect(repo.calls).toContainEqual(expect.objectContaining({ args: ['rev-parse', '--verify', '--quiet', `${BASE}^{commit}`] }))
    expect(repo.calls).toContainEqual(expect.objectContaining({ args: ['ls-tree', '-l', '-z', BASE_SHA, '--', 'src/app.ts'] }))
    expect(repo.calls).toContainEqual(expect.objectContaining({ args: ['cat-file', 'blob', 'blob-b-src/app.ts'] }))
    expect(disk.reads).toEqual([`${ROOT}/src/app.ts`])
  })

  it('reads both sides from commits for an explicit base and head, never the disk', async () => {
    const repo = contentsRepo({
      refs: ['base-tip', 'head-tip'],
      trees: { [BASE_SHA]: { 'src/app.ts': 'old' }, [HEAD_SHA]: { 'src/app.ts': 'pr' } },
    })
    const disk = fakeDisk({ 'src/app.ts': 'local edits' })

    await expect(contentsInspector(repo, disk).fileContents('/repo', 'src/app.ts', 'base-tip', 'head-tip')).resolves.toEqual({
      file: 'src/app.ts',
      old: { path: 'src/app.ts', contents: 'old', rev: BASE_SHA },
      new: { path: 'src/app.ts', contents: 'pr', rev: HEAD_SHA },
    })
    expect(repo.calls).toContainEqual(expect.objectContaining({ args: ['merge-base', 'base-tip', 'head-tip'] }))
    expect(disk.reads).toEqual([])
  })

  it('reports added and untracked files with no old side', async () => {
    const repo = contentsRepo()
    const disk = fakeDisk({ 'notes.md': 'hello' })
    await expect(contentsInspector(repo, disk).fileContents('/repo', 'notes.md')).resolves.toMatchObject({
      old: null,
      new: { contents: 'hello', rev: 'worktree' },
    })
  })

  it('reports deleted files with no new side', async () => {
    const repo = contentsRepo({ refs: ['base-tip', 'head-tip'], trees: { [BASE_SHA]: { 'gone.ts': 'bye' } } })
    await expect(contentsInspector(repo).fileContents('/repo', 'gone.ts', 'base-tip', 'head-tip')).resolves.toMatchObject({
      old: { contents: 'bye', rev: BASE_SHA },
      new: null,
    })
    await expect(contentsInspector(repo).fileContents('/repo', 'gone.ts')).resolves.toMatchObject({ new: null })
  })

  it('rejects a file that exists on neither side', async () => {
    await expect(contentsInspector(contentsRepo()).fileContents('/repo', 'missing.ts')).rejects.toMatchObject({ kind: 'bad-file' })
  })

  it('marks binary files unavailable instead of sending either side', async () => {
    const repo = contentsRepo({ trees: { [BASE_SHA]: { 'logo.png': `PNG${NUL}data` } } })
    const disk = fakeDisk({ 'logo.png': 'text now' })
    await expect(contentsInspector(repo, disk).fileContents('/repo', 'logo.png')).resolves.toEqual({
      file: 'logo.png', old: null, new: null, unavailable: 'binary',
    })
  })

  it('marks oversize files unavailable without reading them', async () => {
    const repo = contentsRepo({ trees: { [BASE_SHA]: { 'big.json': { size: MAX_FILE_CONTENTS_BYTES + 1 } } } })
    const disk = fakeDisk({ 'big.json': 'small' })
    await expect(contentsInspector(repo, disk).fileContents('/repo', 'big.json')).resolves.toEqual({
      file: 'big.json', old: null, new: null, unavailable: 'too-large',
    })
    expect(repo.calls.some((call) => call.args[0] === 'cat-file')).toBe(false)
    expect(disk.reads).toEqual([])

    const onDisk = fakeDisk({ 'big.json': { size: MAX_FILE_CONTENTS_BYTES + 1 } })
    await expect(contentsInspector(contentsRepo(), onDisk).fileContents('/repo', 'big.json'))
      .resolves.toMatchObject({ unavailable: 'too-large' })
    expect(onDisk.reads).toEqual([])
  })

  it('reads blobs with a buffer that fits the size limit', async () => {
    const repo = contentsRepo({ trees: { [BASE_SHA]: { 'a.ts': 'a' } } })
    await contentsInspector(repo, fakeDisk({ 'a.ts': 'b' })).fileContents('/repo', 'a.ts')
    expect(repo.calls.find((call) => call.args[0] === 'cat-file')?.options.maxBuffer).toBeGreaterThan(MAX_FILE_CONTENTS_BYTES)
  })

  it('uses the link target text for a symlink on disk without following it', async () => {
    const repo = contentsRepo({ trees: { [BASE_SHA]: { link: 'old-target' } } })
    const disk = fakeDisk({ link: { symlink: '/etc/passwd' } })
    await expect(contentsInspector(repo, disk).fileContents('/repo', 'link')).resolves.toMatchObject({
      old: { contents: 'old-target' },
      new: { contents: '/etc/passwd', rev: 'worktree' },
    })
    expect(disk.reads).toEqual([])
  })

  it('refuses a path whose parent directory is a symlink out of the repository', async () => {
    const disk = fakeDisk({ 'escape/passwd': 'root:x:0:0' }, { [`${ROOT}/escape`]: '/etc' })
    await expect(contentsInspector(contentsRepo(), disk).fileContents('/repo', 'escape/passwd'))
      .rejects.toMatchObject({ kind: 'bad-file' })
    expect(disk.reads).toEqual([])
  })

  it('rejects paths that escape the repository', async () => {
    await expect(contentsInspector(contentsRepo()).fileContents('/repo', '../secret')).rejects.toMatchObject({ kind: 'bad-file' })
    await expect(contentsInspector(contentsRepo()).fileContents('/repo', '/etc/passwd')).rejects.toMatchObject({ kind: 'bad-file' })
  })

  it('maps git failures to exec errors', async () => {
    const repo = fakeRepo()
    const execute: GitProcessExecutor = async (file, args, options) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { stdout: `${BASE_SHA}\n`, stderr: '' }
      if (args[0] === 'ls-tree') throw failure('fatal: bad object')
      return repo.execute(file, args, options)
    }
    await expect(contentsInspector({ execute }).fileContents('/repo', 'a.ts')).rejects.toMatchObject({
      kind: 'exec', message: expect.stringContaining('fatal: bad object'),
    })
  })
})

const BLAME_PORCELAIN = [
  `${BASE_SHA} 1 1 2`,
  'author Ada Lovelace',
  'author-mail <ada@example.com>',
  'author-time 1700000000',
  'author-tz +0000',
  'summary Add the engine',
  'filename src/app.ts',
  '\tline one',
  `${BASE_SHA} 2 2`,
  '\tline two',
  `${OTHER_SHA} 5 3 1`,
  'author Grace Hopper',
  'author-time 1710000000',
  'summary Fix a bug',
  'previous 1111111111111111111111111111111111111111 src/app.ts',
  'filename src/app.ts',
  '\tline three',
  `${BASE_SHA} 3 4 1`,
  'filename src/app.ts',
  '\tline four',
  `${ZERO_SHA} 5 5 1`,
  'author Not Committed Yet',
  'author-time 1800000000',
  'summary Version of src/app.ts from src/app.ts',
  'filename src/app.ts',
  '\tline five',
  '',
].join('\n')

describe('validateBlameRev', () => {
  it('accepts worktree and full SHAs only', () => {
    expect(validateBlameRev('worktree')).toBe('worktree')
    expect(validateBlameRev(BASE_SHA)).toBe(BASE_SHA)
    expect(validateBlameRev('e'.repeat(64))).toBe('e'.repeat(64))
  })

  it.each([null, '', 'HEAD', 'main', 'abc1234', 'B'.repeat(40), `${'b'.repeat(39)}g`, 'b'.repeat(41), '--worktree'])('rejects %j', (value) => {
    expect(() => validateBlameRev(value)).toThrow(expect.objectContaining({ kind: 'bad-param' }))
  })
})

describe('parseBlamePorcelain', () => {
  it('maps every final line to its commit, reusing metadata for repeated SHAs', () => {
    const result = parseBlamePorcelain(BLAME_PORCELAIN, () => 1_234_000)
    expect(result.lines).toEqual([BASE_SHA, BASE_SHA, OTHER_SHA, BASE_SHA, ZERO_SHA])
    expect(result.commits).toEqual({
      [BASE_SHA]: { sha: BASE_SHA, author: 'Ada Lovelace', authorTime: 1700000000, summary: 'Add the engine', uncommitted: false },
      [OTHER_SHA]: { sha: OTHER_SHA, author: 'Grace Hopper', authorTime: 1710000000, summary: 'Fix a bug', uncommitted: false },
      [ZERO_SHA]: { sha: ZERO_SHA, author: 'You', authorTime: 1234, summary: 'Not committed yet', uncommitted: true },
    })
  })
})

describe('GitDiffInspector.blame', () => {
  it('blames the file at a commit SHA', async () => {
    const repo = contentsRepo({ blameOutput: BLAME_PORCELAIN })
    const blame = await contentsInspector(repo).blame('/repo', 'src/app.ts', BASE_SHA)
    expect(blame).toMatchObject({ file: 'src/app.ts', rev: BASE_SHA, lines: [BASE_SHA, BASE_SHA, OTHER_SHA, BASE_SHA, ZERO_SHA] })
    expect(repo.calls.find((call) => call.args[0] === 'blame')?.args).toEqual(['blame', '--porcelain', BASE_SHA, '--', 'src/app.ts'])
  })

  it('blames the working tree without a revision', async () => {
    const repo = contentsRepo({ blameOutput: BLAME_PORCELAIN })
    await contentsInspector(repo).blame('/repo', 'src/app.ts', 'worktree')
    expect(repo.calls.find((call) => call.args[0] === 'blame')?.args).toEqual(['blame', '--porcelain', '--', 'src/app.ts'])
  })

  it('caches SHA blames but always re-runs worktree blames', async () => {
    const repo = contentsRepo({ blameOutput: BLAME_PORCELAIN })
    const inspector = contentsInspector(repo)
    const blameCalls = () => repo.calls.filter((call) => call.args[0] === 'blame').length

    const first = await inspector.blame('/repo', 'src/app.ts', BASE_SHA)
    await expect(inspector.blame('/repo/sub', 'src/app.ts', BASE_SHA)).resolves.toEqual(first)
    expect(blameCalls()).toBe(1)
    await inspector.blame('/repo', 'src/other.ts', BASE_SHA)
    await inspector.blame('/repo', 'src/app.ts', OTHER_SHA)
    expect(blameCalls()).toBe(3)

    await inspector.blame('/repo', 'src/app.ts', 'worktree')
    await inspector.blame('/repo', 'src/app.ts', 'worktree')
    expect(blameCalls()).toBe(5)
  })

  it('does not cache a failed SHA blame', async () => {
    const repo = contentsRepo({ blameFailure: failure('fatal: something transient') })
    const inspector = contentsInspector(repo)
    await expect(inspector.blame('/repo', 'a.ts', BASE_SHA)).rejects.toMatchObject({ kind: 'exec' })
    await expect(inspector.blame('/repo', 'a.ts', BASE_SHA)).rejects.toMatchObject({ kind: 'exec' })
    expect(repo.calls.filter((call) => call.args[0] === 'blame')).toHaveLength(2)
  })

  it('reports every line of an untracked file as one uncommitted commit', async () => {
    const repo = contentsRepo({ blameFailure: failure("fatal: no such path 'notes.md' in HEAD") })
    const disk = fakeDisk({ 'notes.md': 'one\ntwo\nthree\n' })
    await expect(contentsInspector(repo, disk, () => 5_000_000).blame('/repo', 'notes.md', 'worktree')).resolves.toEqual({
      file: 'notes.md',
      rev: 'worktree',
      commits: { [ZERO_SHA]: { sha: ZERO_SHA, author: 'You', authorTime: 5000, summary: 'Not committed yet', uncommitted: true } },
      lines: [ZERO_SHA, ZERO_SHA, ZERO_SHA],
    })
  })

  it('maps a path missing at a SHA to bad-file and other git failures to exec', async () => {
    const missing = contentsRepo({ blameFailure: failure(`fatal: no such path 'a.ts' in ${BASE_SHA}`) })
    await expect(contentsInspector(missing).blame('/repo', 'a.ts', BASE_SHA)).rejects.toMatchObject({ kind: 'bad-file' })
    const broken = contentsRepo({ blameFailure: failure('fatal: corrupt object') })
    await expect(contentsInspector(broken).blame('/repo', 'a.ts', 'worktree')).rejects.toMatchObject({ kind: 'exec' })
  })

  it('rejects an invalid rev before running git', async () => {
    const repo = contentsRepo()
    await expect(contentsInspector(repo).blame('/repo', 'a.ts', 'HEAD~1')).rejects.toMatchObject({ kind: 'bad-param' })
    expect(repo.calls).toEqual([])
  })
})

describe('GitDiffInspector file contents and blame in a real repository', () => {
  it('reads committed, modified, untracked and symlinked files and blames them', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'commando-git-diff-')))
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'a@a' }
    const run = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env })
    try {
      run('init', '-q', '-b', 'main')
      await writeFile(path.join(root, 'app.ts'), 'one\ntwo\n')
      await symlink('app.ts', path.join(root, 'link'))
      run('add', '.')
      run('commit', '-q', '-m', 'First commit')
      const first = run('rev-parse', 'HEAD').trim()
      await writeFile(path.join(root, 'app.ts'), 'one\ntwo\nthree\n')
      await writeFile(path.join(root, 'notes.md'), 'draft\n')
      await rm(path.join(root, 'link'))
      await symlink('notes.md', path.join(root, 'link'))

      const inspector = new GitDiffInspector(undefined, env)
      await expect(inspector.fileContents(root, 'app.ts')).resolves.toEqual({
        file: 'app.ts',
        old: { path: 'app.ts', contents: 'one\ntwo\n', rev: first },
        new: { path: 'app.ts', contents: 'one\ntwo\nthree\n', rev: 'worktree' },
      })
      await expect(inspector.fileContents(root, 'link')).resolves.toMatchObject({
        old: { contents: 'app.ts' }, new: { contents: 'notes.md' },
      })
      await expect(inspector.fileContents(root, 'notes.md')).resolves.toMatchObject({ old: null, new: { contents: 'draft\n' } })

      const committed = await inspector.blame(root, 'app.ts', first)
      expect(committed.lines).toEqual([first, first])
      expect(committed.commits[first]).toMatchObject({ author: 'Ada', summary: 'First commit', uncommitted: false })

      const worktree = await inspector.blame(root, 'app.ts', 'worktree')
      expect(worktree.lines).toEqual([first, first, ZERO_SHA])
      expect(worktree.commits[ZERO_SHA]).toMatchObject({ uncommitted: true })

      await expect(inspector.blame(root, 'notes.md', 'worktree')).resolves.toMatchObject({ lines: [ZERO_SHA] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

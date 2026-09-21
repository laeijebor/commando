import { GIT_SUMMARY } from '../testing/fixtures'
import { changesHeadline, gitSummaryView, parseDiffLines } from './gitSummary'

describe('the git summary view', () => {
  it('turns the daemon summary into one row per file', () => {
    const view = gitSummaryView(GIT_SUMMARY)
    expect(view?.fileCount).toBe(4)
    expect(view?.rows[0]).toEqual({
      path: 'shared/protocol.ts',
      name: 'protocol.ts',
      directory: 'shared',
      status: 'M',
      additions: 24,
      deletions: 2,
      binary: false,
    })
    expect(view?.target).toBe('origin/main')
  })

  it('reads a file with no directory, and a summary with no files', () => {
    const view = gitSummaryView({
      isRepo: true,
      files: [{ path: 'README.md', status: 'A', additions: null, deletions: null, binary: true }],
    })
    expect(view?.rows[0]?.directory).toBe('')
    expect(gitSummaryView({ isRepo: false })?.rows).toEqual([])
    expect(gitSummaryView(null)).toBeNull()
  })

  it('heads the section the way the mockup does', () => {
    const view = gitSummaryView(GIT_SUMMARY)
    expect(view && changesHeadline(view)).toBe('+212 −48 · 4 files · ⎇ feat/companion-app')
  })

  it('colours a unified diff by line kind', () => {
    const lines = parseDiffLines([
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '@@ -1,3 +1,4 @@',
      ' context',
      '+added',
      '-removed',
    ].join('\n'))
    expect(lines.map((line) => line.kind)).toEqual([
      'meta', 'meta', 'hunk', 'context', 'added', 'removed',
    ])
  })
})

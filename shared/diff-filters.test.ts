import { describe, expect, it } from 'vitest'
import { applyDiffFiltersChange, compileGeneratedPattern, DEFAULT_DIFF_FILTERS, generatedMatcher, isTestPath, parseDiffFilters, parseDiffFiltersChange, repoGeneratedPatterns, BUILT_IN_REPO_GENERATED } from './diff-filters.js'

describe('isTestPath', () => {
  it('recognizes test names and test folders used across the open repos', () => {
    for (const path of ['src/a.test.ts', 'w/room/src/board-rows.unit.test.ts', 'w/test/x.integration.test.ts', 'a.spec.tsx', 'p/s/component.unit.test.ts',
      'scripts/report.unit.test.py', 'backend/test_api.py', 'pkg/thing_test.go', 'backend/conftest.py', 'apps/Tests/AppTests/InboxTests.swift',
      'pkg/__tests__/x.jest.ts', 'pkg/__snapshots__/a.json', 'smoke-tests/data-api/cases.ts', 'e2e/flow.ts', 'fixtures/a.json']) expect(isTestPath(path), path).toBe(true)
    for (const path of ['src/testing.ts', 'src/latest/a.ts', 'native/spec/NativeModule.ts', 'src/contest.ts', 'docs/testing.md', 'src/attest.py', 'src/Test.swift']) expect(isTestPath(path), path).toBe(false)
  })
})

describe('generated patterns', () => {
  it('matches names anywhere, rooted paths, ** and folders like .gitignore', () => {
    const match = (pattern: string, path: string) => compileGeneratedPattern(pattern)!.test(path)
    expect(match('*.gen.ts', 'contracts/data-api/src/client/sdk.gen.ts')).toBe(true)
    expect(match('drizzle/', 'workers/room/src/drizzle/aurora/meta/_journal.json')).toBe(true)
    expect(match('drizzle/', 'workers/drizzle.config.ts')).toBe(false)
    expect(match('workers/*/schema.json', 'workers/proxy/schema.json')).toBe(true)
    expect(match('workers/*/schema.json', 'other/workers/proxy/schema.json')).toBe(false)
    expect(match('**/src/client/core/', 'contracts/data-api/src/client/core/auth.ts')).toBe(true)
    expect(match('/pnpm-lock.yaml', 'apps/pnpm-lock.yaml')).toBe(false)
    expect(compileGeneratedPattern('# comment')).toBeNull()
    expect(compileGeneratedPattern('   ')).toBeNull()
  })
  it('adds common patterns to the repo list, and ! keeps a path visible', () => {
    const vivifit = generatedMatcher(BUILT_IN_REPO_GENERATED.vivifit!)
    expect(vivifit('pnpm-lock.yaml')).toBe(true)
    expect(vivifit('packages/prisma-orm/src/generated/client/index.js')).toBe(true)
    expect(vivifit('apps-be/vivifit-do/drizzle-chat-room/meta/_journal.json')).toBe(true)
    expect(vivifit('apps-fe/teaser/src/app/document-templates/generated/[id]/edit/page.tsx')).toBe(false)
    expect(vivifit('apps-fe/teaser/src/app/page.tsx')).toBe(false)
  })
  it('uses a saved list over the built-in one for the repo', () => {
    const filters = { ...DEFAULT_DIFF_FILTERS, generatedByRepo: { '/dev/Save-All': ['custom/'] } }
    expect(repoGeneratedPatterns(filters, '/dev/Save-All', 'Save-All')).toEqual(['custom/'])
    expect(repoGeneratedPatterns(filters, '/other/Save-All', 'Save-All')).toBe(BUILT_IN_REPO_GENERATED['Save-All'])
    expect(repoGeneratedPatterns(filters, '/dev/x', 'x')).toEqual([])
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(repoGeneratedPatterns(DEFAULT_DIFF_FILTERS, `/dev/${name}`, name)).toEqual([])
      expect(() => generatedMatcher(repoGeneratedPatterns(DEFAULT_DIFF_FILTERS, `/dev/${name}`, name))).not.toThrow()
    }
  })
})

describe('parsing and applying changes', () => {
  it('validates changes and applies them', () => {
    expect(() => parseDiffFiltersChange({ hideTests: 'yes' })).toThrow('true or false')
    expect(() => parseDiffFiltersChange({ repo: { root: 'relative', patterns: [] } })).toThrow('absolute')
    expect(() => parseDiffFiltersChange({ repo: { root: '/r', patterns: ['bad\u0000'] } })).toThrow('pattern')
    const change = parseDiffFiltersChange({ hideTests: true, repo: { root: '/r', patterns: [' a/ ', '', 'a/', 'b'] } })
    expect(change).toEqual({ hideTests: true, repo: { root: '/r', patterns: ['a/', 'b'] } })
    const next = applyDiffFiltersChange(DEFAULT_DIFF_FILTERS, change)
    expect(next).toEqual({ hideTests: true, hideGenerated: false, generatedByRepo: { '/r': ['a/', 'b'] }, revision: 1 })
    expect(applyDiffFiltersChange(next, { repo: { root: '/r', patterns: null } }).generatedByRepo).toEqual({})
    expect(DEFAULT_DIFF_FILTERS.generatedByRepo).toEqual({})
  })
  it('reads saved filters leniently', () => {
    expect(parseDiffFilters({ hideTests: true, hideGenerated: 'x', generatedByRepo: { '/r': ['a'], rel: ['b'], '/bad': 'c' }, revision: 7 }))
      .toEqual({ hideTests: true, hideGenerated: false, generatedByRepo: { '/r': ['a'] }, revision: 7 })
    expect(parseDiffFilters({ revision: -1 }).revision).toBe(0)
    expect(parseDiffFilters(null)).toEqual(DEFAULT_DIFF_FILTERS)
  })
})

describe('pattern safety and stability', () => {
  it('caps wildcards so a pattern cannot backtrack badly, and collapses *** to **', () => {
    expect(() => parseDiffFiltersChange({ repo: { root: '/r', patterns: ['*a*a*a*a*a*a*a*b'] } })).toThrow('at most 6')
    expect(parseDiffFiltersChange({ repo: { root: '/r', patterns: ['***/gen/'] } }).repo!.patterns).toEqual(['**/gen/'])
  })
  it('returns the same empty list for repos without patterns, so callers can memoize', () => {
    expect(repoGeneratedPatterns(DEFAULT_DIFF_FILTERS, '/a', 'a')).toBe(repoGeneratedPatterns(DEFAULT_DIFF_FILTERS, '/b', undefined))
  })
})

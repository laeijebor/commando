import { parsePatch, prDiffTotals, prFileRows } from './diff'

const DIFF = {
  base: 'b',
  head: 'h',
  truncated: false,
  files: [
    { path: 'src/app/main.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1,3 +1,4 @@\n line' },
    { path: 'README.md', status: 'added', additions: 4, deletions: 0, patch: null },
    { path: 'old/name.ts', status: 'renamed', additions: 0, deletions: 0, patch: null },
    { path: 'gone.ts', status: 'removed', additions: 0, deletions: 9, patch: null },
  ],
}

it('splits each file into name and directory with a status badge', () => {
  const rows = prFileRows(DIFF)
  expect(rows.map((row) => [row.name, row.directory, row.badge])).toEqual([
    ['main.ts', 'src/app', 'M'],
    ['README.md', '', 'A'],
    ['name.ts', 'old', 'R'],
    ['gone.ts', '', 'D'],
  ])
  expect(prDiffTotals(DIFF)).toEqual({ files: 4, additions: 6, deletions: 10 })
  expect(prFileRows(null)).toEqual([])
})

it('numbers old and new lines through every hunk', () => {
  const lines = parsePatch('@@ -10,3 +10,4 @@ function a() {\n context\n-removed\n+added\n+added again\n\\ No newline at end of file\n@@ -40 +41 @@\n-x\n+y\n')
  expect(lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
    ['hunk', null, null],
    ['context', 10, 10],
    ['del', 11, null],
    ['add', null, 11],
    ['add', null, 12],
    ['note', null, null],
    ['hunk', null, null],
    ['del', 40, null],
    ['add', null, 41],
  ])
})

it('keeps a preamble before the first hunk as notes and expands tabs', () => {
  const lines = parsePatch('diff --git a/x b/x\n@@ -1 +1 @@\n+\tindented')
  expect(lines[0]).toEqual({ kind: 'note', text: 'diff --git a/x b/x', oldLine: null, newLine: null })
  expect(lines[2]?.text).toBe('+  indented')
})

it('reads a headerless excerpt as diff lines', () => {
  expect(parsePatch(' a\n-b\n+c', { headerless: true }).map((line) => line.kind)).toEqual(['context', 'del', 'add'])
  expect(parsePatch(' a\n-b').map((line) => line.kind)).toEqual(['note', 'note'])
})

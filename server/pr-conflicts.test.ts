import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMergeTree, PrConflictInspector } from './pr-conflicts.js'

const execute = promisify(execFile)
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function git(cwd: string, ...args: string[]) {
  const result = await execute('git', ['-c', 'user.name=Conflict Test', '-c', 'user.email=test@example.invalid', ...args], { cwd })
  return result.stdout.trim()
}

async function fixture(mode: 'text' | 'binary' | 'clean' | 'delete' = 'text') {
  const directory = await mkdtemp(join(tmpdir(), 'commando-conflict-test-'))
  directories.push(directory)
  await git(directory, 'init', '-b', 'main')
  const path = mode === 'binary' ? 'binary.dat' : 'file with spaces\nand newline.txt'
  await writeFile(join(directory, path), mode === 'binary' ? Buffer.from([0, 1, 2]) : 'shared line\n')
  await git(directory, 'add', '.')
  await git(directory, 'commit', '-m', 'common ancestor')
  const ancestor = await git(directory, 'rev-parse', 'HEAD')
  await git(directory, 'switch', '-c', 'release')
  if (mode === 'delete') await git(directory, 'rm', path)
  else await writeFile(join(directory, path), mode === 'binary' ? Buffer.from([0, 3, 4]) : 'target branch line\n')
  await git(directory, 'add', '.')
  await git(directory, 'commit', '-m', 'target change')
  const baseOid = await git(directory, 'rev-parse', 'HEAD')
  await git(directory, 'switch', '-c', 'feature', ancestor)
  await writeFile(join(directory, mode === 'clean' ? 'independent.txt' : path), mode === 'binary' ? Buffer.from([0, 5, 6]) : 'pull request line\n')
  await git(directory, 'add', '.')
  await git(directory, 'commit', '-m', 'PR change')
  const headOid = await git(directory, 'rev-parse', 'HEAD')
  await git(directory, 'update-ref', 'refs/pull/12/head', headOid)
  const input = { repo: 'acme/widgets', number: 12, baseRefName: 'release', headRefName: 'feature', baseOid, headOid }
  const inspector = new PrConflictInspector({ remote: () => directory })
  return { directory, path, input, inspector }
}

describe('read-only conflict inspection', () => {
  it('simulates the actual target, preserves unusual paths, and leaves checkout/index/HEAD unchanged', async () => {
    const { directory, path, input, inspector } = await fixture()
    const index = await readFile(join(directory, '.git/index'))
    const first = inspector.inspect(input)
    expect(inspector.inspect(input)).toBe(first)
    const result = await first
    expect(result.state).toBe('conflicting')
    expect(result.baseRefName).toBe('release')
    expect(result.files[0]).toMatchObject({ path, kind: 'CONFLICT (contents)', truncated: false })
    expect(result.files[0].content).toContain('<<<<<<<')
    expect(result.files[0].content).toContain('target branch line')
    expect(result.files[0].content).toContain('pull request line')
    expect(await git(directory, 'rev-parse', 'HEAD')).toBe(input.headOid)
    expect(await git(directory, 'status', '--porcelain')).toBe('')
    expect(await readFile(join(directory, '.git/index'))).toEqual(index)
    await git(directory, 'branch', 'another-target', input.baseOid)
    expect((await inspector.inspect({ ...input, baseRefName: 'another-target' })).baseRefName).toBe('another-target')
  })

  it('reports clean merges and binary and modify/delete conflicts accurately', async () => {
    const clean = await fixture('clean')
    expect(await clean.inspector.inspect(clean.input)).toMatchObject({ state: 'clean', files: [] })
    const binary = await fixture('binary')
    const binaryResult = await binary.inspector.inspect(binary.input)
    expect(binaryResult).toMatchObject({ state: 'conflicting', files: [{ path: 'binary.dat', content: null }] })
    expect(binaryResult.messages.join('\n')).toContain('binary')
    const deleted = await fixture('delete')
    const deletedResult = await deleted.inspector.inspect(deleted.input)
    expect(deletedResult.state).toBe('conflicting')
    expect(deletedResult.files[0].kind).toBe('CONFLICT (modify/delete)')
  })

  it('inspects the live target tip rather than the base sha GitHub recorded at the last PR sync', async () => {
    const { directory, input, inspector } = await fixture('clean')
    await git(directory, 'switch', 'release')
    await writeFile(join(directory, 'independent.txt'), 'target moved on\n')
    await git(directory, 'add', '.')
    await git(directory, 'commit', '-m', 'target moves after the PR was opened')
    const tip = await git(directory, 'rev-parse', 'HEAD')
    expect(await inspector.inspect(input)).toMatchObject({ state: 'conflicting', baseOid: tip, files: [{ path: 'independent.txt' }] })
  })

  it('rejects races instead of returning stale conflicts', async () => {
    const { input, inspector } = await fixture()
    await expect(inspector.inspect({ ...input, headOid: 'f'.repeat(40) })).rejects.toMatchObject({ status: 409 })
  })

  it('validates request identity before invoking Git', async () => {
    const run = vi.fn()
    const inspector = new PrConflictInspector({ git: run })
    await expect(inspector.inspect({ repo: '../bad', number: 12, baseRefName: 'main', headRefName: 'feature', headOid: 'b'.repeat(40) })).rejects.toMatchObject({ status: 400 })
    expect(run).not.toHaveBeenCalled()
  })

  it('limits large previews before reading their contents and reports truncation explicitly', async () => {
    const base = 'a'.repeat(40), head = 'b'.repeat(40), tree = 'c'.repeat(40)
    const run = vi.fn(async (args: string[]) => ({ code: args[0] === 'merge-tree' ? 1 : 0,
      stdout: args[0] === 'rev-parse' ? (args[1].endsWith('target') ? base : head)
        : args[0] === 'merge-tree' ? `${tree}\0huge.ts\0\0`
        : args[0] === 'cat-file' ? String(129 * 1024) : '',
    }))
    const inspector = new PrConflictInspector({ git: run })
    expect(await inspector.inspect({ repo: 'acme/widgets', number: 12, baseRefName: 'main', headRefName: 'feature', headOid: head }))
      .toMatchObject({ state: 'conflicting', truncated: true, files: [{ path: 'huge.ts', content: null, truncated: true }] })
    expect(run.mock.calls.some(([args]) => args[0] === 'cat-file' && args[1] === 'blob')).toBe(false)
  })
})

describe('merge-tree output parser', () => {
  it('uses exit status even when no individual files conflict', () => {
    const tree = 'a'.repeat(40)
    const result = parseMergeTree(`${tree}\0\0` + '1\0folder\0CONFLICT (directory rename)\0Directory rename requires resolution\0', 1)
    expect(result).toMatchObject({ tree, paths: [], conflicting: true, messages: [{ kind: 'CONFLICT (directory rename)' }] })
  })
  it('rejects malformed object IDs and message records', () => {
    expect(() => parseMergeTree('invalid\0', 0)).toThrow()
    expect(() => parseMergeTree(`${'a'.repeat(40)}\0\0x\0`, 1)).toThrow()
  })
})

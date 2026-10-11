import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileIndex, entriesFor, matchScore } from './file-index.js'

let dir: string

async function put(path: string, text = 'x'): Promise<void> {
  await mkdir(join(dir, path, '..'), { recursive: true })
  await writeFile(join(dir, path), text)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-index-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('workspace file index', () => {
  it('lists tracked and untracked files in a repo, but not ignored ones', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    await put('.gitignore', 'secret.env\nbuild/\n')
    await put('src/chat/ChatComposer.tsx')
    await put('server/agent-host/session.ts')
    await put('secret.env')
    await put('build/out.js')
    execFileSync('git', ['add', 'src', '.gitignore'], { cwd: dir })
    const index = new WorkspaceFileIndex(dir)
    const paths = (await index.search('', 100)).entries.map((entry) => entry.path)
    expect(paths).toEqual(['server/', 'src/', '.gitignore'])
    const all = (await index.search('s', 100)).entries.map((entry) => entry.path)
    expect(all).toContain('server/agent-host/session.ts')
    expect(all).toContain('src/chat/')
    expect(all).not.toContain('secret.env')
    expect(all.some((path) => path.startsWith('build'))).toBe(false)
  })

  it('walks a folder outside git, skipping dependency folders and symlinks', async () => {
    await put('notes/todo.md')
    await put('node_modules/pkg/index.js')
    await symlink(join(dir, 'notes'), join(dir, 'loop'))
    const index = new WorkspaceFileIndex(dir, { listGitFiles: async () => null })
    const paths = (await index.search('', 100)).entries.map((entry) => entry.path)
    expect(paths).toEqual(['notes/'])
    expect((await index.search('todo')).entries).toEqual([{ path: 'notes/todo.md', kind: 'file' }])
  })

  it('ranks name matches over path matches and scattered ones last', async () => {
    const index = new WorkspaceFileIndex(dir, {
      listGitFiles: async () => ['server/agent-host/session.ts', 'src/chat/ChatComposer.tsx', 'docs/composer-notes.md', 'src/cache/old.ts'],
    })
    expect((await index.search('composer')).entries.map((entry) => entry.path)).toEqual(['docs/composer-notes.md', 'src/chat/ChatComposer.tsx'])
    expect((await index.search('srvses')).entries.map((entry) => entry.path)).toEqual(['server/agent-host/session.ts'])
    expect(matchScore('zzz', 'src/a.ts')).toBeNull()
    expect(matchScore('chat', 'src/chat/') ?? 0).toBeGreaterThan(matchScore('chat', 'src/chat/ChatPane.tsx') ?? 0)
  })

  it('caps the index and the results, and says so', async () => {
    const files = Array.from({ length: 30 }, (_, index) => `f${index}.ts`)
    const index = new WorkspaceFileIndex(dir, { maxFiles: 20, listGitFiles: async () => files })
    const result = await index.search('f', 5)
    expect(result.entries).toHaveLength(5)
    expect(result.truncated).toBe(true)
  })

  it('rebuilds once the index is stale, sharing a build between searches', async () => {
    let now = 0
    const listGitFiles = vi.fn(async () => ['a.ts'])
    const index = new WorkspaceFileIndex(dir, { listGitFiles, now: () => now, maxAgeMs: 1000 })
    await Promise.all([index.search('a'), index.search('a')])
    expect(listGitFiles).toHaveBeenCalledTimes(1)
    now = 500
    await index.search('a')
    expect(listGitFiles).toHaveBeenCalledTimes(1)
    now = 2000
    await index.search('a')
    expect(listGitFiles).toHaveBeenCalledTimes(2)
  })

  it('derives folders from file paths', () => {
    expect(entriesFor(['a/b/c.ts', 'a/d.ts'])).toEqual([
      { path: 'a/', kind: 'directory' }, { path: 'a/b/', kind: 'directory' },
      { path: 'a/b/c.ts', kind: 'file' }, { path: 'a/d.ts', kind: 'file' },
    ])
  })
})

describe('workspace file index failures', () => {
  it('walks a folder that is not a repo, but reports other git failures instead of ignoring .gitignore', async () => {
    const { listGitFiles } = await import('./file-index.js')
    expect(await listGitFiles(dir)).toBeNull()
    const broken = new WorkspaceFileIndex(dir, { listGitFiles: async () => { throw new Error('git ls-files failed: dubious ownership') } })
    await expect(broken.search('a')).rejects.toThrow('dubious ownership')
  })

  it('reports an unreadable session folder instead of an empty one', async () => {
    const missing = new WorkspaceFileIndex(join(dir, 'gone'), { listGitFiles: async () => null })
    await expect(missing.search('a')).rejects.toThrow(/ENOENT/)
  })
})

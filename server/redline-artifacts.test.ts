import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RedlineArtifactError, RedlineArtifactRegistry } from './redline-artifacts.js'

function artifactDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'redline-artifacts-'))
  writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app.css'), 'body{}')
  return dir
}

describe('RedlineArtifactRegistry', () => {
  it('registers a directory and serves files under it', () => {
    const registry = new RedlineArtifactRegistry()
    const dir = realpathSync(artifactDir())
    const { id } = registry.register(dir)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(registry.resolve(id, 'index.html')).toBe(join(dir, 'index.html'))
    expect(registry.resolve(id, 'assets/app.css')).toBe(join(dir, 'assets', 'app.css'))
  })

  it('serves index.html for the empty path and trailing slash', () => {
    const registry = new RedlineArtifactRegistry()
    const { id } = registry.register(realpathSync(artifactDir()))
    expect(registry.resolve(id, '')).toMatch(/index\.html$/)
    expect(registry.resolve(id, 'assets/')).toBeNull() // no assets/index.html
  })

  it('refuses traversal and absolute paths', () => {
    const registry = new RedlineArtifactRegistry()
    const { id } = registry.register(realpathSync(artifactDir()))
    expect(registry.resolve(id, '../etc/passwd')).toBeNull()
    expect(registry.resolve(id, 'assets/../../etc/passwd')).toBeNull()
    expect(registry.resolve(id, '/etc/passwd')).toBeNull()
    expect(registry.resolve(id, 'a%2F..%2F..')).toBeNull()
  })

  it('refuses symlinks that escape the registered directory', () => {
    const registry = new RedlineArtifactRegistry()
    const dir = realpathSync(artifactDir())
    symlinkSync('/etc', join(dir, 'escape'))
    const { id } = registry.register(dir)
    expect(registry.resolve(id, 'escape/passwd')).toBeNull()
  })

  it('returns null for unknown ids and missing files', () => {
    const registry = new RedlineArtifactRegistry()
    const { id } = registry.register(realpathSync(artifactDir()))
    expect(registry.resolve('0123456789abcdef', 'index.html')).toBeNull()
    expect(registry.resolve(id, 'nope.html')).toBeNull()
  })

  it('rejects bad registrations', () => {
    const registry = new RedlineArtifactRegistry()
    expect(() => registry.register('relative/path')).toThrow(RedlineArtifactError)
    expect(() => registry.register('/definitely/not/a/real/dir-xyz')).toThrow(RedlineArtifactError)
    const filePath = join(artifactDir(), 'index.html')
    expect(() => registry.register(filePath)).toThrow(RedlineArtifactError)
  })

  it('caps registrations at 16', () => {
    const registry = new RedlineArtifactRegistry()
    for (let index = 0; index < 16; index += 1) registry.register(artifactDir())
    expect(() => registry.register(artifactDir())).toThrow(RedlineArtifactError)
  })

  it('unregister frees the id', () => {
    const registry = new RedlineArtifactRegistry()
    const { id } = registry.register(realpathSync(artifactDir()))
    expect(registry.unregister(id)).toBe(true)
    expect(registry.unregister(id)).toBe(false)
    expect(registry.resolve(id, 'index.html')).toBeNull()
  })
})

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultRedlineArtifactStatePath,
  REDLINE_ARTIFACT_TTL_MS,
  RedlineArtifactError,
  RedlineArtifactRegistry,
} from './redline-artifacts.js'

function artifactDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'redline-artifacts-'))
  writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app.css'), 'body{}')
  return dir
}

describe('RedlineArtifactRegistry', () => {
  it('namespaces the default state file by daemon port', () => {
    expect(defaultRedlineArtifactStatePath(3911)).toBe(join(homedir(), '.commando', 'redline-artifacts-3911.json'))
  })

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

  it('persists registrations: a new instance over the same state file serves the same id', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const dir = realpathSync(artifactDir())
    const { id } = new RedlineArtifactRegistry({ statePath }).register(dir)
    const reborn = new RedlineArtifactRegistry({ statePath })
    expect(reborn.resolve(id, 'index.html')).toBe(join(dir, 'index.html'))
  })

  it.each(['null', '{"artifacts":"nope"}'])('ignores an invalid state container: %s', (contents) => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    writeFileSync(statePath, contents)
    const registry = new RedlineArtifactRegistry({ statePath })
    const dir = realpathSync(artifactDir())
    const { id } = registry.register(dir)
    expect(registry.resolve(id, 'index.html')).toBe(join(dir, 'index.html'))
  })

  it('persists the state file with owner-only permissions', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    new RedlineArtifactRegistry({ statePath }).register(realpathSync(artifactDir()))
    expect(statSync(statePath).mode & 0o777).toBe(0o600)
  })

  it('re-registering the same directory returns the existing id', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const registry = new RedlineArtifactRegistry({ statePath })
    const dir = realpathSync(artifactDir())
    const first = registry.register(dir)
    expect(registry.register(dir).id).toBe(first.id)
    // Idempotent hits must not burn the cap.
    for (let index = 0; index < 15; index += 1) registry.register(artifactDir())
    expect(registry.register(dir).id).toBe(first.id)
  })

  it('drops persisted entries whose directory has vanished', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const dir = realpathSync(artifactDir())
    const { id } = new RedlineArtifactRegistry({ statePath }).register(dir)
    rmSync(dir, { recursive: true, force: true })
    const reborn = new RedlineArtifactRegistry({ statePath })
    expect(reborn.resolve(id, 'index.html')).toBeNull()
  })

  it('expires persisted entries older than the ttl', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const dir = realpathSync(artifactDir())
    let clock = 1_000
    const { id } = new RedlineArtifactRegistry({ statePath, now: () => clock }).register(dir)
    clock += REDLINE_ARTIFACT_TTL_MS + 1
    const reborn = new RedlineArtifactRegistry({ statePath, now: () => clock })
    expect(reborn.resolve(id, 'index.html')).toBeNull()
  })

  it('expires entries while the registry is running', () => {
    let clock = 1_000
    const registry = new RedlineArtifactRegistry({ now: () => clock })
    const { id } = registry.register(realpathSync(artifactDir()))
    clock += REDLINE_ARTIFACT_TTL_MS + 1
    expect(registry.resolve(id, 'index.html')).toBeNull()
  })

  it('prunes expired entries before enforcing the registration cap', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    let clock = 1_000
    const registry = new RedlineArtifactRegistry({ statePath, now: () => clock })
    const expiredIds = Array.from({ length: 16 }, () => registry.register(realpathSync(artifactDir())).id)
    clock += REDLINE_ARTIFACT_TTL_MS + 1
    const dir = realpathSync(artifactDir())
    const { id } = registry.register(dir)
    expect(registry.resolve(id, 'index.html')).toBe(join(dir, 'index.html'))
    expect(registry.resolve(expiredIds[0], 'index.html')).toBeNull()
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { artifacts: unknown[] }
    expect(persisted.artifacts).toHaveLength(1)
  })

  it('drops an entry when its persisted directory path has been rebound to a symlink', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const dir = realpathSync(artifactDir())
    const replacement = realpathSync(artifactDir())
    const { id } = new RedlineArtifactRegistry({ statePath }).register(dir)
    rmSync(dir, { recursive: true, force: true })
    symlinkSync(replacement, dir)
    const reborn = new RedlineArtifactRegistry({ statePath })
    expect(reborn.resolve(id, 'index.html')).toBeNull()
  })

  it('keeps the 16 newest valid persisted entries', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const artifacts = Array.from({ length: 17 }, (_, index) => ({
      id: index.toString(16).padStart(16, '0'),
      dir: realpathSync(artifactDir()),
      registeredAt: index + 1,
    }))
    writeFileSync(statePath, JSON.stringify({ artifacts }))
    const registry = new RedlineArtifactRegistry({ statePath, now: () => 20 })
    expect(registry.resolve(artifacts[0].id, 'index.html')).toBeNull()
    for (const artifact of artifacts.slice(1)) {
      expect(registry.resolve(artifact.id, 'index.html')).toBe(join(artifact.dir, 'index.html'))
    }
  })

  it('deduplicates persisted directories by keeping the newest id', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const dir = realpathSync(artifactDir())
    const olderId = '0000000000000001'
    const newerId = '0000000000000002'
    writeFileSync(
      statePath,
      JSON.stringify({
        artifacts: [
          { id: olderId, dir, registeredAt: 10 },
          { id: newerId, dir, registeredAt: 20 },
        ],
      }),
    )
    const registry = new RedlineArtifactRegistry({ statePath, now: () => 20 })
    expect(registry.resolve(olderId, 'index.html')).toBeNull()
    expect(registry.resolve(newerId, 'index.html')).toBe(join(dir, 'index.html'))
  })

  it('rejects non-finite timestamps and clamps future timestamps on load', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const invalidDir = realpathSync(artifactDir())
    const futureDir = realpathSync(artifactDir())
    writeFileSync(
      statePath,
      `{"artifacts":[{"id":"0000000000000001","dir":${JSON.stringify(invalidDir)},"registeredAt":1e999},{"id":"0000000000000002","dir":${JSON.stringify(futureDir)},"registeredAt":200}]}`,
    )
    const registry = new RedlineArtifactRegistry({ statePath, now: () => 100 })
    expect(registry.resolve('0000000000000001', 'index.html')).toBeNull()
    expect(registry.resolve('0000000000000002', 'index.html')).toBe(join(futureDir, 'index.html'))
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as {
      artifacts: Array<{ id: string; registeredAt: number }>
    }
    expect(persisted.artifacts).toEqual([{ id: '0000000000000002', dir: futureDir, registeredAt: 100 }])
  })

  it('does not retain a registration when persisting it fails', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const registry = new RedlineArtifactRegistry({ statePath })
    for (let index = 0; index < 15; index += 1) registry.register(realpathSync(artifactDir()))
    rmSync(statePath)
    mkdirSync(statePath)
    expect(() => registry.register(realpathSync(artifactDir()))).toThrow()
    rmSync(statePath, { recursive: true })
    expect(() => registry.register(realpathSync(artifactDir()))).not.toThrow()
  })

  it('does not remove a registration when persisting the removal fails', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const registry = new RedlineArtifactRegistry({ statePath })
    const dir = realpathSync(artifactDir())
    const { id } = registry.register(dir)
    rmSync(statePath)
    mkdirSync(statePath)
    expect(() => registry.unregister(id)).toThrow()
    expect(registry.resolve(id, 'index.html')).toBe(join(dir, 'index.html'))
  })

  it('unregister removes the entry from the state file too', () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'redline-state-')), 'artifacts.json')
    const registry = new RedlineArtifactRegistry({ statePath })
    const { id } = registry.register(realpathSync(artifactDir()))
    registry.unregister(id)
    const reborn = new RedlineArtifactRegistry({ statePath })
    expect(reborn.resolve(id, 'index.html')).toBeNull()
  })
})

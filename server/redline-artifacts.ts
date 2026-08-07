import { randomBytes } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

const MAX_ARTIFACT_DIRS = 16

export class RedlineArtifactError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * In-memory registry of directories the daemon serves as redline artifacts.
 * Ids are unguessable; resolution is strictly confined to the registered
 * directory — normalized paths AND realpaths must stay inside it, so neither
 * `..` segments nor symlinks can escape.
 */
export class RedlineArtifactRegistry {
  private readonly dirs = new Map<string, string>()

  register(dir: string): { id: string } {
    if (typeof dir !== 'string' || !isAbsolute(dir)) {
      throw new RedlineArtifactError(400, 'dir must be an absolute path')
    }
    if (this.dirs.size >= MAX_ARTIFACT_DIRS) {
      throw new RedlineArtifactError(429, `At most ${MAX_ARTIFACT_DIRS} artifact directories can be registered`)
    }
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      throw new RedlineArtifactError(404, 'dir does not exist')
    }
    if (!statSync(real).isDirectory()) {
      throw new RedlineArtifactError(400, 'dir must be a directory')
    }
    const id = randomBytes(8).toString('hex')
    this.dirs.set(id, real)
    return { id }
  }

  unregister(id: string): boolean {
    return this.dirs.delete(id)
  }

  /** Maps an artifact request path to an absolute file path, or null. */
  resolve(id: string, requestPath: string): string | null {
    const root = this.dirs.get(id)
    if (!root) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(requestPath)
    } catch {
      return null
    }
    if (decoded.includes('\0') || isAbsolute(decoded)) return null
    const relative = decoded === '' || decoded.endsWith('/') ? `${decoded}index.html` : decoded
    const normalized = normalize(relative)
    if (normalized === '..' || normalized.startsWith(`..${sep}`)) return null
    const candidate = resolve(root, normalized)
    if (candidate !== root && !candidate.startsWith(root + sep)) return null
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      return null
    }
    if (real !== root && !real.startsWith(root + sep)) return null
    try {
      if (!statSync(real).isFile()) return null
    } catch {
      return null
    }
    return join(root, normalized)
  }
}

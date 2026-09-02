import type { PaneRepo } from '../shared/protocol.js'
import type { GitRepoInfo } from '../shared/tmux-create.js'

const DEFAULT_TTL_MS = 30_000
const MAX_CONCURRENT_PROBES = 4

type CacheEntry = { at: number; repo: PaneRepo | undefined }

export type PaneRepoResolverOptions = {
  ttlMs?: number
  now?: () => number
}

function toPaneRepo(info: GitRepoInfo): PaneRepo | undefined {
  if (!info.isRepo || !info.mainRoot || !info.name) return undefined
  return {
    root: info.mainRoot,
    name: info.name,
    branch: info.branch ?? '',
    isWorktree: info.isWorktree ?? false,
    ...(info.defaultBranch ? { defaultBranch: info.defaultBranch } : {}),
  }
}

/**
 * Resolves pane directories to their repositories with a per-path cache, so a
 * snapshot with many panes in a few directories costs a handful of git calls.
 */
export class PaneRepoResolver {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(
    private readonly probe: (directory: string) => Promise<GitRepoInfo>,
    options: PaneRepoResolverOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
  }

  async resolve(paths: readonly string[]): Promise<Map<string, PaneRepo | undefined>> {
    const wanted = [...new Set(paths.filter((value) => value.startsWith('/')))]
    const now = this.now()
    const stale = wanted.filter((directory) => {
      const entry = this.cache.get(directory)
      return !entry || now - entry.at >= this.ttlMs
    })

    const queue = [...stale]
    const worker = async () => {
      for (let directory = queue.shift(); directory !== undefined; directory = queue.shift()) {
        let repo: PaneRepo | undefined
        try {
          repo = toPaneRepo(await this.probe(directory))
        } catch {
          repo = undefined
        }
        this.cache.set(directory, { at: this.now(), repo })
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PROBES, queue.length) }, worker))

    for (const directory of [...this.cache.keys()]) {
      if (!wanted.includes(directory)) this.cache.delete(directory)
    }
    return new Map(wanted.map((directory) => [directory, this.cache.get(directory)?.repo]))
  }
}

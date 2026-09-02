import { describe, expect, it, vi } from 'vitest'
import type { GitRepoInfo } from '../shared/tmux-create.js'
import { PaneRepoResolver } from './pane-repos.js'

const MAIN = '/Users/dev/gizmo/Save-All'

function probeFor(table: Record<string, GitRepoInfo>) {
  return vi.fn(async (directory: string): Promise<GitRepoInfo> => table[directory] ?? { isRepo: false })
}

const mainInfo: GitRepoInfo = { isRepo: true, root: MAIN, mainRoot: MAIN, name: 'Save-All', branch: 'main', isWorktree: false, defaultBranch: 'main', remote: 'origin' }
const worktreeInfo: GitRepoInfo = { isRepo: true, root: `${MAIN}-worktrees/coins`, mainRoot: MAIN, name: 'Save-All', branch: 'referral-coins-reward', isWorktree: true, defaultBranch: 'main', remote: 'origin' }

describe('PaneRepoResolver', () => {
  it('maps each distinct pane path to its repository once', async () => {
    const probe = probeFor({ [MAIN]: mainInfo, [`${MAIN}-worktrees/coins`]: worktreeInfo })
    const resolver = new PaneRepoResolver(probe)
    const repos = await resolver.resolve([MAIN, MAIN, `${MAIN}-worktrees/coins`, '/tmp/plain'])
    expect(repos.get(MAIN)).toEqual({ root: MAIN, name: 'Save-All', branch: 'main', isWorktree: false, defaultBranch: 'main' })
    expect(repos.get(`${MAIN}-worktrees/coins`)).toEqual({ root: MAIN, name: 'Save-All', branch: 'referral-coins-reward', isWorktree: true, defaultBranch: 'main' })
    expect(repos.get('/tmp/plain')).toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('serves repeated paths from the cache until the ttl expires', async () => {
    let now = 1_000
    const probe = probeFor({ [MAIN]: mainInfo })
    const resolver = new PaneRepoResolver(probe, { ttlMs: 500, now: () => now })
    await resolver.resolve([MAIN])
    await resolver.resolve([MAIN])
    expect(probe).toHaveBeenCalledTimes(1)
    now = 1_600
    await resolver.resolve([MAIN])
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('caches non-repository paths too', async () => {
    const probe = probeFor({})
    const resolver = new PaneRepoResolver(probe)
    await resolver.resolve(['/tmp/plain'])
    await resolver.resolve(['/tmp/plain'])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('forgets paths that no longer appear so the cache does not grow forever', async () => {
    const probe = probeFor({ [MAIN]: mainInfo })
    const resolver = new PaneRepoResolver(probe)
    await resolver.resolve([MAIN, '/tmp/plain'])
    await resolver.resolve(['/tmp/plain'])
    await resolver.resolve([MAIN])
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('treats a failing probe as no repository without rejecting the whole batch', async () => {
    const probe = vi.fn(async (directory: string): Promise<GitRepoInfo> => {
      if (directory === '/boom') throw new Error('git exploded')
      return mainInfo
    })
    const resolver = new PaneRepoResolver(probe)
    const repos = await resolver.resolve(['/boom', MAIN])
    expect(repos.get('/boom')).toBeUndefined()
    expect(repos.get(MAIN)?.name).toBe('Save-All')
  })
})

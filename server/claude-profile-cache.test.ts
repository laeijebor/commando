import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeProfile } from '../shared/tmux-create.js'
import { ClaudeProfileCache } from './claude-profile-cache.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 }))) })

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'commando-profile-cache-'))
  dirs.push(home)
  const profile = (name: string): ClaudeProfile => ({ name, configDir: join(home, `.${name}`) })
  let clock = 1_000
  const discover = vi.fn(async (): Promise<ClaudeProfile[]> => [])
  const cache = () => new ClaudeProfileCache(join(home, '.commando', 'claude-profiles.json'), home, discover, 30_000, () => clock, 50)
  return { home, profile, discover, cache, advance: (ms: number) => { clock += ms } }
}

describe('ClaudeProfileCache', () => {
  it('waits for the first scan, stores it, and answers from memory while fresh', async () => {
    const { profile, discover, cache } = await setup()
    const work = profile('claudew')
    discover.mockResolvedValueOnce([work])
    const profiles = cache()
    expect(await profiles.list()).toEqual([work])
    expect(await profiles.list()).toEqual([work])
    expect(discover).toHaveBeenCalledOnce()
    await profiles.idle()
    expect(JSON.parse(await readFile(profiles.path, 'utf8'))).toEqual({ profiles: [work] })
    expect((await stat(profiles.path)).mode & 0o777).toBe(0o600)
  })

  it('answers a restarted daemon from disk when the rescan is slow, then keeps the rescan', async () => {
    const { profile, discover, cache } = await setup()
    const [work, personal] = [profile('claudew'), profile('claudep')]
    discover.mockResolvedValueOnce([work])
    const first = cache()
    await first.refresh()
    await first.idle()

    let finishScan!: (found: ClaudeProfile[]) => void
    discover.mockReturnValueOnce(new Promise((resolve) => { finishScan = resolve }))
    const restarted = cache()
    expect(await restarted.list()).toEqual([work])
    expect(discover).toHaveBeenCalledTimes(2)
    finishScan([personal, work])
    await restarted.idle()
    expect(await restarted.list()).toEqual([personal, work])
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('answers a stale read with a quick rescan, shared by concurrent reads', async () => {
    const { profile, discover, cache, advance } = await setup()
    const [work, personal] = [profile('claudew'), profile('claudep')]
    discover.mockResolvedValueOnce([work])
    const profiles = cache()
    await profiles.list()
    advance(30_000)
    discover.mockResolvedValueOnce([personal])
    expect(await Promise.all([profiles.list(), profiles.list()])).toEqual([[personal], [personal]])
    expect(discover).toHaveBeenCalledTimes(2)
    await profiles.idle()
  })

  it('runs one more scan after a running one for callers that need a fresh list', async () => {
    const { profile, discover, cache, advance } = await setup()
    const [work, added] = [profile('claudew'), profile('claudex')]
    discover.mockResolvedValueOnce([work])
    const profiles = cache()
    await profiles.list()
    advance(30_000)
    let finishScan!: (found: ClaudeProfile[]) => void
    discover.mockReturnValueOnce(new Promise((resolve) => { finishScan = resolve }))
    expect(await profiles.list()).toEqual([work])

    // The folder is created while that scan runs, so it may have missed it.
    discover.mockResolvedValueOnce([work, added])
    const fresh = Promise.all([profiles.refresh(), profiles.refresh()])
    finishScan([work])
    expect(await fresh).toEqual([[work, added], [work, added]])
    expect(discover).toHaveBeenCalledTimes(3)
    expect(await profiles.list()).toEqual([work, added])
    await profiles.idle()
  })

  it('ignores stored entries outside the home folder and a corrupt file', async () => {
    const { home, profile, discover, cache } = await setup()
    const work = profile('claudew')
    const profiles = cache()
    discover.mockResolvedValueOnce([work])
    await profiles.refresh()
    await profiles.idle()
    await writeFile(profiles.path, JSON.stringify({ profiles: [work, { name: 'x', configDir: '/etc' }, { name: 1, configDir: join(home, '.claudep') }] }))
    discover.mockReturnValueOnce(new Promise(() => {}))
    expect(await cache().list()).toEqual([work])

    await writeFile(profiles.path, '{')
    discover.mockResolvedValueOnce([])
    const reread = cache()
    expect(await reread.list()).toEqual([])
    await reread.idle()
  })
})

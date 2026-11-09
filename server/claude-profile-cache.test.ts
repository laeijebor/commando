import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeProfile } from '../shared/tmux-create.js'
import { ClaudeProfileCache } from './claude-profile-cache.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'commando-profile-cache-'))
  dirs.push(home)
  const profile = (name: string): ClaudeProfile => ({ name, configDir: join(home, `.${name}`) })
  let clock = 1_000
  const discover = vi.fn(async (): Promise<ClaudeProfile[]> => [])
  const cache = () => new ClaudeProfileCache(join(home, '.commando', 'claude-profiles.json'), home, discover, 30_000, () => clock)
  return { home, profile, discover, cache, advance: (ms: number) => { clock += ms } }
}

/** Resolves once pending background work (scan, then store) has run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('ClaudeProfileCache', () => {
  it('waits for the first scan, stores it, and answers from memory while fresh', async () => {
    const { profile, discover, cache } = await setup()
    const work = profile('claudew')
    discover.mockResolvedValueOnce([work])
    const profiles = cache()
    expect(await profiles.list()).toEqual([work])
    expect(await profiles.list()).toEqual([work])
    expect(discover).toHaveBeenCalledOnce()
    await settle()
    expect(JSON.parse(await readFile(profiles.path, 'utf8'))).toEqual({ profiles: [work] })
    expect((await stat(profiles.path)).mode & 0o777).toBe(0o600)
  })

  it('answers a restarted daemon from disk at once, then rescans in the background', async () => {
    const { profile, discover, cache } = await setup()
    const [work, personal] = [profile('claudew'), profile('claudep')]
    discover.mockResolvedValueOnce([work])
    await cache().refresh()
    await settle()

    let finishScan!: (found: ClaudeProfile[]) => void
    discover.mockReturnValueOnce(new Promise((resolve) => { finishScan = resolve }))
    const restarted = cache()
    expect(await restarted.list()).toEqual([work])
    expect(discover).toHaveBeenCalledTimes(2)
    finishScan([personal, work])
    await settle()
    expect(await restarted.list()).toEqual([personal, work])
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('rescans once stale and shares one scan between concurrent callers', async () => {
    const { profile, discover, cache, advance } = await setup()
    const work = profile('claudew')
    discover.mockResolvedValue([work])
    const profiles = cache()
    await profiles.list()
    advance(30_000)
    await Promise.all([profiles.list(), profiles.list(), profiles.refresh()])
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('ignores stored entries outside the home folder and a corrupt file', async () => {
    const { home, profile, discover, cache } = await setup()
    const work = profile('claudew')
    const profiles = cache()
    discover.mockResolvedValueOnce([work])
    await profiles.refresh()
    await settle()
    await writeFile(profiles.path, JSON.stringify({ profiles: [work, { name: 'x', configDir: '/etc' }, { name: 1, configDir: join(home, '.claudep') }] }))
    expect(await cache().list()).toEqual([work])

    await writeFile(profiles.path, '{')
    discover.mockResolvedValueOnce([])
    expect(await cache().list()).toEqual([])
    await settle()
  })
})

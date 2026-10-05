import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultPaneIdentityPath, TmuxPaneIdentityStore, type PaneIdentityObservation } from './tmux-pane-identity-store.js'

const TARGET = '550e8400-e29b-41d4-a716-446655440000'
const OTHER = '6ba7b810-9dad-41d1-80b4-00c04fd430c8'
const directories: string[] = []
const pane: PaneIdentityObservation = { paneId: '%42', storedValue: '', sessionName: 'work', windowIndex: 0, paneIndex: 0, path: '/workspace' }
async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-identity-test-'))
  directories.push(directory)
  return new TmuxPaneIdentityStore(join(directory, 'identities.json'))
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('durable pane identity', () => {
  it('restores the same target after a different server recreates the slot with a different numeric ID', async () => {
    const first = await store()
    await first.remember('100:1234', [pane], new Map([['%42', TARGET]]))
    const replay = new TmuxPaneIdentityStore(first.statePath)
    const persist = vi.fn().mockResolvedValue(undefined)
    const restored = await replay.restore('200:5678', [{ ...pane, paneId: '%7' }], persist)
    expect(restored[0].storedValue).toBe(`v1:%7:${TARGET}`)
    expect(persist).toHaveBeenCalledWith('%7', `v1:%7:${TARGET}`)
    expect((await stat(first.statePath)).mode & 0o777).toBe(0o600)
  })

  it('keeps late-restoring slots through partial snapshots and daemon reloads', async () => {
    const first = await store()
    const sibling = { ...pane, paneId: '%43', paneIndex: 1 }
    await first.remember('100:1234', [pane, sibling], new Map([['%42', TARGET], ['%43', OTHER]]))
    const persist = vi.fn().mockResolvedValue(undefined)
    const initial = await first.restore('200:5678', [{ ...pane, paneId: '%7' }], persist)
    await first.remember('200:5678', initial, new Map([['%7', TARGET]]))
    const replay = new TmuxPaneIdentityStore(first.statePath)
    const later = await replay.restore('200:5678', [initial[0], { ...sibling, paneId: '%8' }], persist)
    expect(later[1].storedValue).toBe(`v1:%8:${OTHER}`)
  })

  it.each([
    ['same server', '100:1234', pane],
    ['different directory', '200:5678', { ...pane, path: '/unrelated' }],
    ['different session', '200:5678', { ...pane, sessionName: 'unrelated' }],
    ['inherited option', '200:5678', { ...pane, paneId: '%8', storedValue: `v1:%42:${TARGET}` }],
  ])('does not reattach history for %s', async (_label, serverId, observation) => {
    const first = await store()
    await first.remember('100:1234', [pane], new Map([['%42', TARGET]]))
    const persist = vi.fn()
    await first.restore(serverId, [observation], persist)
    expect(persist).not.toHaveBeenCalled()
  })

  it('does not reclaim a target already attached elsewhere or an ambiguous slot', async () => {
    const first = await store()
    await first.remember('100:1234', [pane], new Map([['%42', TARGET]]))
    const persist = vi.fn()
    await first.restore('200:5678', [pane, { ...pane, paneId: '%8', paneIndex: 1, storedValue: `v1:%8:${TARGET}` }], persist)
    await first.restore('200:5678', [pane, { ...pane, paneId: '%8' }], persist)
    expect(persist).not.toHaveBeenCalled()
  })

  it('replaces a consumed slot so closing its restored pane cannot restore the old target again', async () => {
    const first = await store()
    await first.remember('100:1234', [pane], new Map([['%42', TARGET]]))
    await first.remember('200:5678', [{ ...pane, paneId: '%7' }], new Map([['%7', TARGET]]))
    const persist = vi.fn()
    await first.restore('200:5678', [{ ...pane, paneId: '%8' }], persist)
    expect(persist).not.toHaveBeenCalled()
  })

  it('updates the durable slot after a rename/move and rejects corrupt state instead of overwriting it', async () => {
    const first = await store()
    await first.remember('100:1234', [pane], new Map([['%42', TARGET]]))
    const moved = { ...pane, sessionName: 'renamed', windowIndex: 2 }
    await first.remember('100:1234', [moved], new Map([['%42', TARGET]]))
    const persist = vi.fn().mockResolvedValue(undefined)
    const restored = await first.restore('200:5678', [moved], persist)
    expect(restored[0].storedValue).toContain(TARGET)
    await writeFile(first.statePath, '{bad json')
    await expect(new TmuxPaneIdentityStore(first.statePath).restore('200:5678', [pane], persist)).rejects.toThrow()
    expect(await readFile(first.statePath, 'utf8')).toBe('{bad json')
  })

  it('isolates sidecars by tmux socket', () => {
    vi.stubEnv('COMMANDO_PANE_IDENTITIES_PATH', '')
    vi.stubEnv('COMMANDO_TMUX_SOCKET_PATH', '')
    vi.stubEnv('COMMANDO_TMUX_SOCKET_NAME', '')
    const standard = defaultPaneIdentityPath()
    vi.stubEnv('COMMANDO_TMUX_SOCKET_NAME', 'qa-resurrect')
    expect(defaultPaneIdentityPath()).not.toBe(standard)
  })
})

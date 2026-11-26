import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_CAPTURE_OWNER_FILE, sweepStaleBoardCaptureProfiles } from './board-capture-profiles.js'

let root: string
const uid = process.getuid?.() ?? 501
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'board-capture-sweep-test-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function profile(name: string, owner?: unknown) {
  const path = join(root, `commando-board-browser-${name}`); await mkdir(path)
  if (owner) await writeFile(join(path, BOARD_CAPTURE_OWNER_FILE), JSON.stringify(owner))
  return path
}
function fakeProcesses(alive = new Set<number>()) {
  return {
    alive: vi.fn((pid: number) => alive.has(pid)),
    inspect: vi.fn((_pid: number) => undefined as { uid: number; group: number; command: string } | undefined),
    killGroup: vi.fn((pid: number) => { alive.delete(pid) }),
  }
}
describe('stale Board capture profiles (stub processes only)', () => {
  it('kills only a verified owned detached group after its daemon dies, then removes the profile', async () => {
    const path = await profile('stale', { ownerPid: 100, browserPid: 200, ownerUid: uid })
    const proc = fakeProcesses(new Set([200]))
    proc.inspect.mockReturnValue({ uid, group: 200, command: `Chromium --headless=new --user-data-dir=${path} about:blank` })
    expect(await sweepStaleBoardCaptureProfiles({ root, uid, processes: proc })).toEqual({ removed: 1, errors: [] })
    expect(proc.killGroup).toHaveBeenCalledExactlyOnceWith(200)
    await expect(access(path)).rejects.toThrow()
  })
  it('preserves active daemons, foreign owners, reused pids, wrong process groups and profile-prefix lookalikes', async () => {
    const live = await profile('live', { ownerPid: 101, browserPid: 201, ownerUid: uid })
    const foreign = await profile('foreign', { ownerPid: 102, browserPid: 202, ownerUid: uid + 1 })
    const reused = await profile('reused', { ownerPid: 103, browserPid: 203, ownerUid: uid })
    const group = await profile('wrong-group', { ownerPid: 104, browserPid: 204, ownerUid: uid })
    const prefix = await profile('prefix', { ownerPid: 105, browserPid: 205, ownerUid: uid })
    const proc = fakeProcesses(new Set([101, 201, 202, 203, 204, 205]))
    proc.inspect.mockImplementation((pid) => pid === 203 ? { uid, group: pid, command: 'Unrelated program' }
      : pid === 204 ? { uid, group: 999, command: `Chromium --headless --user-data-dir=${group}` }
        : { uid, group: pid, command: `Chromium --headless --user-data-dir=${prefix}-other` })
    const result = await sweepStaleBoardCaptureProfiles({ root, uid, processes: proc })
    expect(result.removed).toBe(0); expect(result.errors).toHaveLength(3)
    expect(proc.killGroup).not.toHaveBeenCalled()
    for (const path of [live, foreign, reused, group, prefix]) await expect(access(path)).resolves.toBeUndefined()
  })
  it('cleans old ownerless directories and dead launch leases while preserving fresh/live leases and symlinks', async () => {
    const old = await profile('old'), fresh = await profile('fresh')
    await utimes(old, new Date(0), new Date(0))
    const lease = await profile('dead-lease', { ownerPid: 100, ownerUid: uid, phase: 'launching' })
    const live = await profile('live-lease', { ownerPid: 101, ownerUid: uid, phase: 'launching' })
    await utimes(live, new Date(0), new Date(0))
    const outside = join(root, 'unrelated-profile'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'keep')
    await symlink(outside, join(root, 'commando-board-browser-link'))
    const proc = fakeProcesses(new Set([101]))
    expect(await sweepStaleBoardCaptureProfiles({ root, uid, processes: proc })).toEqual({ removed: 2, errors: [] })
    for (const path of [old, lease]) await expect(access(path)).rejects.toThrow()
    for (const path of [fresh, live]) await expect(access(path)).resolves.toBeUndefined()
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('keep')
    expect(proc.killGroup).not.toHaveBeenCalled()
  })
  it('refuses foreign process uids, symlinked/corrupt owner files and directories owned by another user', async () => {
    const foreign = await profile('process-uid', { ownerPid: 100, browserPid: 200, ownerUid: uid })
    const corrupt = await profile('corrupt'); await writeFile(join(corrupt, BOARD_CAPTURE_OWNER_FILE), '{bad')
    const linked = await profile('linked-owner'); await symlink(join(foreign, BOARD_CAPTURE_OWNER_FILE), join(linked, BOARD_CAPTURE_OWNER_FILE))
    const proc = fakeProcesses(new Set([200]))
    proc.inspect.mockReturnValue({ uid: uid + 1, group: 200, command: `Chromium --headless --user-data-dir=${foreign}` })
    expect((await sweepStaleBoardCaptureProfiles({ root, uid, processes: proc })).removed).toBe(0)
    expect((await sweepStaleBoardCaptureProfiles({ root, uid: uid + 1, processes: proc })).removed).toBe(0)
    expect(proc.killGroup).not.toHaveBeenCalled()
  })
})

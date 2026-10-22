import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol.js'
import { Commander, commanderInstructions } from './commander.js'
const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
it('creates exactly one default Claude hosted chat, persists identity and reconciles live pane changes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'commander-')); dirs.push(home)
  const snapshot = { panes: [], sessions: [] } as unknown as CommandoSnapshot
  const createSession = vi.fn(async () => {
    snapshot.panes.push({ id: '%1', targetId: 'stable', sessionId: '$1' } as TmuxPane)
    return { created: { paneId: '%1' } } as never
  })
  const changed = vi.fn(), options = { home, statePath: join(home, 'commander.json'), snapshot: () => snapshot, creator: { createSession }, refreshSnapshot: vi.fn(async () => {}), changed }
  const commander = new Commander(options); await commander.load()
  const [a, b] = await Promise.all([commander.ensure(), commander.ensure()])
  expect(a).toEqual({ targetId: 'stable', paneId: '%1', sessionId: '$1' }); expect(b).toEqual(a)
  expect(createSession).toHaveBeenCalledExactlyOnceWith({ name: 'Commander', cwd: join(home, '.commando', 'commander'), agent: { provider: 'claude-chat', permissionMode: 'default' } })
  const instructions = await readFile(join(home, '.commando/commander/CLAUDE.md'), 'utf8')
  expect(await readFile(join(home, '.commando/commander/AGENTS.md'), 'utf8')).toBe(instructions)
  expect(instructions).toContain('Never answer an agent\'s question')
  const cliPath = join(home, '.commando/hooks/commando-agents.mjs')
  expect(instructions).toContain(cliPath)
  expect(JSON.parse(await readFile(join(home, '.commando/commander/.claude/settings.json'), 'utf8'))).toEqual({
    permissions: { allow: [`Bash(node "${cliPath}":*)`, `Bash(node ${cliPath}:*)`] },
  })
  snapshot.panes = []; commander.reconcile()
  expect(changed).toHaveBeenLastCalledWith({ targetId: 'stable' })
  const restarted = new Commander(options); await restarted.load()
  expect(restarted.state()).toEqual({ targetId: 'stable' })
  snapshot.panes.push({ id: '%2', targetId: 'stable', sessionId: '$2' } as TmuxPane); restarted.reconcile()
  expect(restarted.state()).toMatchObject({ paneId: '%2' })
  await restarted.forget()
  expect(snapshot.panes).toHaveLength(1)
  expect(JSON.parse(await readFile(options.statePath, 'utf8'))).toEqual({ targetId: null })
})
it('instructions distinguish daemon notices, verbatim relays, explicit steering and permission boundaries', () => {
  const text = commanderInstructions('/hooks/commando-agents.mjs')
  for (const term of ['list', 'read %N', 'relay %N', 'nudge %N', 'cancel', 'verbatim', 'explicitly asks', 'approve a permission prompt', '[Commando]', 'outcome first']) expect(text).toContain(term)
})

it('merges only the CLI permissions into existing settings on startup without duplicating rules', async () => {
  const home = await mkdtemp(join(tmpdir(), 'commander-settings-')); dirs.push(home)
  const cliPath = join(home, 'custom hooks', 'commando-agents.mjs')
  const quoted = `Bash(node "${cliPath}":*)`, unquoted = `Bash(node ${cliPath}:*)`
  const path = join(home, '.commando/commander/.claude/settings.json')
  await mkdir(join(home, '.commando/commander/.claude'), { recursive: true })
  const existing = { model: 'sonnet', env: { KEEP: 'yes' }, permissions: { allow: ['Read', quoted], deny: ['Bash(rm:*)'], defaultMode: 'default' } }
  await writeFile(path, JSON.stringify(existing))
  const statePath = join(home, 'state.json'); await writeFile(statePath, JSON.stringify({ targetId: 'stable' }))
  const options = { home, cliPath, statePath, snapshot: () => ({ panes: [] } as unknown as CommandoSnapshot),
    creator: { createSession: vi.fn() }, refreshSnapshot: async () => {}, changed: vi.fn() }
  await new Commander(options).load()
  const expected = { ...existing, permissions: { ...existing.permissions, allow: ['Read', quoted, unquoted] } }
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(expected)
  await new Commander(options).load()
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(expected)
  expect(options.creator.createSession).not.toHaveBeenCalled()
})
it('preserves malformed existing settings instead of overwriting them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'commander-invalid-settings-')); dirs.push(home)
  const path = join(home, '.commando/commander/.claude/settings.json')
  await mkdir(join(home, '.commando/commander/.claude'), { recursive: true })
  await writeFile(path, '{broken')
  const statePath = join(home, 'state.json'); await writeFile(statePath, JSON.stringify({ targetId: 'stable' }))
  const commander = new Commander({ home, statePath, snapshot: () => ({ panes: [] } as unknown as CommandoSnapshot),
    creator: { createSession: vi.fn() }, refreshSnapshot: async () => {}, changed: vi.fn() })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(commander.load()).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
  expect(await readFile(path, 'utf8')).toBe('{broken')
})

it.each(['null', '', '{}', '[]', '{"targetId":5}'])('continues with empty Commander state for a corrupt file: %s', async (raw) => {
  const home = await mkdtemp(join(tmpdir(), 'commander-state-')); dirs.push(home)
  const statePath = join(home, 'state.json'); await writeFile(statePath, raw)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const commander = new Commander({ home, statePath, snapshot: () => ({ panes: [] } as unknown as CommandoSnapshot),
    creator: { createSession: vi.fn() }, refreshSnapshot: async () => {}, changed: vi.fn() })
  await expect(commander.load()).resolves.toBeUndefined()
  expect(commander.state()).toEqual({ targetId: null })
  expect(log).toHaveBeenCalledWith(expect.stringContaining(statePath), expect.any(Error))
})
it.each(['null', '{}broken', '{"permissions":null}', '{"permissions":[]}', '{"permissions":{"allow":null}}', '{"permissions":{"allow":{}}}', '{"permissions":{"allow":[7]}}'])('skips invalid tool permissions on load and ensure: %s', async (raw) => {
  const home = await mkdtemp(join(tmpdir(), 'commander-settings-')); dirs.push(home)
  const path = join(home, '.commando/commander/.claude/settings.json')
  await mkdir(join(home, '.commando/commander/.claude'), { recursive: true }); await writeFile(path, raw)
  const statePath = join(home, 'state.json'); await writeFile(statePath, '{"targetId":"old"}')
  const snapshot = { panes: [], sessions: [] } as unknown as CommandoSnapshot
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const commander = new Commander({ home, statePath, snapshot: () => snapshot,
    creator: { createSession: vi.fn(async () => { snapshot.panes.push({ id: '%1', targetId: 'new' } as TmuxPane); return { created: { paneId: '%1' } } as never }) },
    refreshSnapshot: async () => {}, changed: vi.fn() })
  await commander.load(); expect(commander.state().targetId).toBe('old')
  await expect(commander.ensure()).resolves.toMatchObject({ targetId: 'new' })
  expect(await readFile(path, 'utf8')).toBe(raw)
  expect(log).toHaveBeenCalledTimes(2)
  expect(log.mock.calls.every(([line]) => line.includes(path))).toBe(true)
})

it('switches profile by closing the old Commander session and starting a fresh one, and keeps the profile across restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'commander-profile-')); dirs.push(home)
  const configDir = join(home, '.claudew')
  const snapshot = { panes: [{ id: '%1', targetId: 'old', sessionId: '$1' }], sessions: [{ id: '$1', name: 'Commander' }] } as unknown as CommandoSnapshot
  const statePath = join(home, 'commander.json'); await writeFile(statePath, JSON.stringify({ targetId: 'old' }))
  let next = 2
  const createSession = vi.fn(async () => {
    const id = next++
    snapshot.panes.push({ id: `%${id}`, targetId: `new-${id}`, sessionId: `$${id}` } as TmuxPane)
    return { created: { paneId: `%${id}` } } as never
  })
  const closeSession = vi.fn(async (sessionId: string) => {
    snapshot.panes = snapshot.panes.filter((pane) => pane.sessionId !== sessionId)
    snapshot.sessions = snapshot.sessions.filter((session) => session.id !== sessionId)
  })
  const changed = vi.fn()
  const options = { home, statePath, snapshot: () => snapshot, creator: { createSession }, refreshSnapshot: vi.fn(async () => {}), changed, closeSession }
  const commander = new Commander(options); await commander.load()

  expect(await commander.switchProfile(configDir)).toEqual({ targetId: 'new-2', paneId: '%2', sessionId: '$2', configDir })
  expect(closeSession).toHaveBeenCalledExactlyOnceWith('$1')
  expect(createSession).toHaveBeenCalledExactlyOnceWith({ name: 'Commander', cwd: join(home, '.commando', 'commander'), agent: { provider: 'claude-chat', permissionMode: 'default', configDir } })
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ targetId: 'new-2', configDir })
  expect(changed).toHaveBeenLastCalledWith({ targetId: 'new-2', paneId: '%2', sessionId: '$2', configDir })

  // A restart keeps the profile, and a Commander recreated after its pane went away uses it.
  snapshot.panes = []
  const restarted = new Commander(options); await restarted.load()
  expect(restarted.state()).toEqual({ targetId: 'new-2', configDir })
  await restarted.ensure()
  expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ agent: expect.objectContaining({ configDir }) }))

  // Back to the default login drops the profile.
  expect(await restarted.switchProfile(null)).toEqual({ targetId: 'new-4', paneId: '%4', sessionId: '$4' })
  expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { provider: 'claude-chat', permissionMode: 'default' } }))
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ targetId: 'new-4' })
})

it('leaves Commander and its profile as they were when the old session cannot be closed, and ignores an invalid saved profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'commander-profile-fail-')); dirs.push(home)
  const snapshot = { panes: [{ id: '%1', targetId: 'old', sessionId: '$1' }], sessions: [] } as unknown as CommandoSnapshot
  const statePath = join(home, 'commander.json'); await writeFile(statePath, JSON.stringify({ targetId: 'old', configDir: '/etc' }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const createSession = vi.fn()
  const commander = new Commander({ home, statePath, snapshot: () => snapshot, creator: { createSession }, refreshSnapshot: async () => {}, changed: vi.fn(),
    closeSession: async () => { throw new Error('tmux refused') } })
  await commander.load()
  expect(commander.state()).toEqual({ targetId: 'old', paneId: '%1', sessionId: '$1' })
  await expect(commander.switchProfile(join(home, '.claudew'))).rejects.toThrow('tmux refused')
  expect(createSession).not.toHaveBeenCalled()
  expect(commander.state()).toEqual({ targetId: 'old', paneId: '%1', sessionId: '$1' })
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ targetId: 'old', configDir: '/etc' })
})

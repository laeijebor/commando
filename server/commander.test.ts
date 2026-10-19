import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { CommandoSnapshot, TmuxPane } from '../shared/protocol.js'
import { Commander, commanderInstructions } from './commander.js'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
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
  await expect(commander.load()).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('{broken')
})

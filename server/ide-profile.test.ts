import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { importIdeProfile } from './ide-profile.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ide-profile-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('imports preferences and extension packages without moving workspace state or registry paths', async () => {
  const legacy = join(root, 'old')
  const user = join(legacy, 'user-data', 'User')
  await mkdir(join(user, 'workspaceStorage'), { recursive: true })
  await mkdir(join(user, 'globalStorage'))
  await writeFile(join(user, 'settings.json'), '{ // JSONC remains intact\n "editor.fontSize": 22\n}')
  await writeFile(join(user, 'keybindings.json'), '[{"key":"cmd+k","command":"test"}]')
  await mkdir(join(legacy, 'extensions', 'example.theme-1.0'), { recursive: true })
  await writeFile(join(legacy, 'extensions', 'example.theme-1.0', 'package.json'), '{"name":"theme"}')
  await writeFile(join(legacy, 'extensions', 'extensions.json'), '[{"location":"old absolute path"}]')
  const base = join(root, 'base')
  await importIdeProfile(base, legacy)
  expect(await readFile(join(base, 'user-data', 'User', 'settings.json'), 'utf8')).toContain('// JSONC')
  expect(await readFile(join(base, 'user-data', 'User', 'keybindings.json'), 'utf8')).toContain('cmd+k')
  expect(await readdir(join(base, 'user-data', 'User'))).toEqual(['keybindings.json', 'settings.json'])
  expect(await readdir(join(base, 'extensions'))).toEqual(['example.theme-1.0'])
  expect(await readFile(join(legacy, 'extensions', 'extensions.json'), 'utf8')).toContain('old absolute')
})

it('preserves the existing base and leaves other legacy setups available for manual import', async () => {
  const base = join(root, 'base')
  await mkdir(join(base, 'user-data', 'User'), { recursive: true })
  await writeFile(join(base, 'config.yaml'), 'auth: none')
  await writeFile(join(base, 'user-data', 'User', 'settings.json'), '{"editor.fontSize":18}')
  const legacy = join(root, 'old')
  await mkdir(join(legacy, 'user-data', 'User'), { recursive: true })
  await writeFile(join(legacy, 'user-data', 'User', 'settings.json'), '{"editor.fontSize":22}')
  await importIdeProfile(base, legacy)
  expect(await readFile(join(base, 'user-data', 'User', 'settings.json'), 'utf8')).toContain('18')
  expect(await readFile(join(legacy, 'user-data', 'User', 'settings.json'), 'utf8')).toContain('22')
})

it('handles a missing legacy profile without creating fake extension state', async () => {
  await importIdeProfile(join(root, 'base'), join(root, 'missing'))
  expect(await readdir(join(root, 'base', 'user-data', 'User'))).toEqual([])
})

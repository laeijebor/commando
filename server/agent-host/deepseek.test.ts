import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { deepseekConfigDir, deepseekSessionSpec, DEEPSEEK_MODEL } from './deepseek.js'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'deepseek-profile-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })
const spec = () => ({ paneId: '%3', cwd: '/work', permissionMode: 'default' as const, env: { HOME: home } })

it('uses the dedicated key and profile, removing inherited Anthropic credentials and cloud routes', async () => {
  const configDir = deepseekConfigDir(home)
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({ env: { DEEPSEEK_API_KEY: 'test-deepseek-key' } }))
  const original = { ...spec(), configDir: '/other/.claudew', model: 'sonnet', fast: true, env: {
    HOME: home, ANTHROPIC_API_KEY: 'wrong-key', ANTHROPIC_AUTH_TOKEN: 'wrong-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'wrong-oauth', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
  } }
  const result = await deepseekSessionSpec(original)
  expect(result).toMatchObject({ configDir, claudeProvider: 'deepseek', model: DEEPSEEK_MODEL, fast: false })
  expect(result.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'test-deepseek-key',
    ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined,
    ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_MODEL, CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash' })
  expect(original.env.ANTHROPIC_AUTH_TOKEN).toBe('wrong-token')
})

it('allows an explicit pane key and never falls back to an Anthropic token', async () => {
  const result = await deepseekSessionSpec({ ...spec(), env: { HOME: home, DEEPSEEK_API_KEY: ' explicit-key ', ANTHROPIC_AUTH_TOKEN: 'wrong-token' } })
  expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('explicit-key')
  const missing = await deepseekSessionSpec({ ...spec(), env: { HOME: home, ANTHROPIC_AUTH_TOKEN: 'wrong-token' } })
  expect(missing.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
})

it('reports malformed settings without quoting their potentially secret contents', async () => {
  await mkdir(deepseekConfigDir(home), { recursive: true })
  await writeFile(join(deepseekConfigDir(home), 'settings.json'), 'invalid secret contents')
  await expect(deepseekSessionSpec(spec())).rejects.toThrow(/^Could not read DeepSeek settings at /)
})

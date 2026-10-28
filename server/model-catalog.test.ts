import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { codexCacheModels, ModelCatalog } from './model-catalog.js'

const sonnet = { value: 'sonnet', displayName: 'Sonnet' }
const opus = { value: 'opus', displayName: 'Opus', efforts: ['high' as const] }

async function catalog(now = () => 1_000) {
  const dir = await mkdtemp(join(tmpdir(), 'model-catalog-'))
  const path = join(dir, 'catalog.json')
  const codex = join(dir, 'models_cache.json')
  return { dir, path, codex, catalog: new ModelCatalog(path, codex, now) }
}

describe('ModelCatalog', () => {
  it('remembers each chat provider and Claude profile separately, and survives a restart', async () => {
    const { path, codex, catalog: models } = await catalog()
    await models.record({ provider: 'claude', configDir: '/h/.claudep', models: [sonnet] })
    await models.record({ provider: 'claude', configDir: '/h/.claudew', models: [opus] })
    await models.record({ provider: 'muse', models: [sonnet] })
    await models.record({ provider: 'cursor' })
    expect(await new ModelCatalog(path, codex).list()).toEqual({
      'claude:/h/.claudep': { models: [sonnet], updatedAt: 1_000 },
      'claude:/h/.claudew': { models: [opus], updatedAt: 1_000 },
      muse: { models: [sonnet], updatedAt: 1_000 },
    })
  })

  it('rewrites an unchanged list only once it is an hour old', async () => {
    let now = 1_000
    const { path, catalog: models } = await catalog(() => now)
    await models.record({ provider: 'codex', models: [sonnet] })
    now += 60_000
    await models.record({ provider: 'codex', models: [sonnet] })
    expect(JSON.parse(await readFile(path, 'utf8')).codex.updatedAt).toBe(1_000)
    now += 60 * 60_000
    await models.record({ provider: 'codex', models: [sonnet] })
    expect(JSON.parse(await readFile(path, 'utf8')).codex.updatedAt).toBe(now)
  })

  it("uses Codex's own cache when it is newer than the last Codex chat, showing only listed models", async () => {
    const { codex, catalog: models } = await catalog(() => Date.parse('2026-10-01T00:00:00Z'))
    await writeFile(codex, JSON.stringify({
      fetched_at: '2026-10-20T10:00:00Z',
      models: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Workhorse', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'nonsense' }] },
        { slug: 'codex-auto-review', display_name: 'Hidden', visibility: 'hide' },
      ],
    }))
    await models.record({ provider: 'codex', models: [sonnet] })
    expect((await models.list()).codex).toEqual({
      models: [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Workhorse', efforts: ['low'] }],
      updatedAt: Date.parse('2026-10-20T10:00:00Z'),
    })
  })

  it('leaves an unreadable catalog file alone rather than replacing every list in it', async () => {
    const { path, codex } = await catalog()
    await writeFile(path, '{}')
    const models = new ModelCatalog(join(path, 'not-a-file'), codex)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await models.record({ provider: 'codex', models: [sonnet] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving it untouched'), expect.anything())
    expect(await readFile(path, 'utf8')).toBe('{}')
  })

  it('ignores a malformed catalog file or Codex cache', async () => {
    const { path, codex, catalog: models } = await catalog()
    await writeFile(path, '{"codex": {"models": "nope"}, "muse": [1]}')
    await writeFile(codex, 'not json')
    expect(await models.list()).toEqual({})
    expect(codexCacheModels({ models: [{ slug: '--bad', visibility: 'list' }] })).toBeNull()
  })
})

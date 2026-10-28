import { describe, expect, it } from 'vitest'
import { agentOptions, modelCatalogFor, modelChoices, relativeAge, shortPath } from './newSessionAgents'

describe('New session agents', () => {
  it('lists Claude chat and terminal once per profile, or once when there are none', () => {
    const profiles = [{ name: 'claudep', configDir: '/h/.claudep' }, { name: 'claudew', configDir: '/h/.claudew', label: 'Work' }]
    expect(agentOptions(profiles).map((option) => [option.group, option.label, option.tag ?? ''])).toEqual([
      ['Chat', 'Claude chat', 'claudep'], ['Chat', 'Claude chat', 'Work'], ['Chat', 'Codex chat', ''], ['Chat', 'Muse chat', ''], ['Chat', 'Cursor chat', ''],
      ['Terminal', 'Claude terminal', 'claudep'], ['Terminal', 'Claude terminal', 'Work'], ['Terminal', 'Codex', ''], ['Terminal', 'OpenCode', ''], ['Terminal', 'Cursor', ''],
      ['Other', 'Shell', ''], ['Other', 'Nothing', ''],
    ])
    expect(agentOptions(null).filter((option) => option.provider === 'claude-chat')).toEqual([{ provider: 'claude-chat', label: 'Claude chat', group: 'Chat' }])
  })

  it("uses a profile's own model list, else the newest Claude list", () => {
    const old = { models: [{ value: 'opus', displayName: 'Opus' }], updatedAt: 1 }
    const fresh = { models: [{ value: 'sonnet', displayName: 'Sonnet' }], updatedAt: 9 }
    const catalogs = { 'claude:/h/.claudep': old, 'claude:/h/.claudew': fresh }
    expect(modelCatalogFor(catalogs, 'claude', '/h/.claudep')).toBe(old)
    expect(modelCatalogFor(catalogs, 'claude-chat', '/h/.claude')).toBe(fresh)
    expect(modelCatalogFor(catalogs, 'codex-chat', undefined)).toBeNull()
    expect(modelCatalogFor(catalogs, 'shell', undefined)).toBeNull()
    expect(modelChoices(null)).toEqual([{ value: 'default', displayName: 'Default' }])
    expect(modelChoices({ models: [{ value: 'default', displayName: 'Default (recommended)' }], updatedAt: 1 })).toHaveLength(1)
  })

  it('shortens home paths and ages', () => {
    expect(shortPath('/Users/leo/dev/app')).toBe('~/dev/app')
    expect(shortPath('/home/leo')).toBe('~')
    expect(shortPath('/tmp/x')).toBe('/tmp/x')
    expect(relativeAge(0, 20_000)).toBe('just now')
    expect(relativeAge(0, 2 * 3_600_000)).toBe('2h ago')
    expect(relativeAge(0, 3 * 86_400_000)).toBe('3d ago')
  })
})

import { providerPresentation } from './providerPresentation'
it.each(['claude', 'codex', 'cursor', 'muse', 'opencode'])('presents %s with a name, mark and semantic accent', (provider) => {
  const value = providerPresentation(provider)
  expect(value.name.toLowerCase()).toBe(provider)
  expect(value.mark).toHaveLength(2)
  expect(value.accent).toBeTruthy()
})
it.each(['new-provider', 'constructor', '__proto__', undefined])('safely presents unknown %s', (provider) => {
  expect(providerPresentation(provider)).toEqual({ name: 'Agent', mark: 'AI', accent: 'muted' })
})

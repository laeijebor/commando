import type { ChatSessionInfo } from '@commando/agent-chat'
import { session } from './testing'
import { settingsPresentation } from './settingsPresentation'
it.each([
  ['claude', 'Ask before edits', ['default', 'acceptEdits', 'plan']],
  ['codex', 'Workspace access', ['default', 'plan']],
  ['muse', 'Ask when needed', ['default']],
] as const)('uses %s permission labels and real mode choices', (provider, label, modes) => {
  const options = settingsPresentation(session({ provider }))
  expect(options.label('default')).toBe(label)
  expect(options.modes).toEqual(modes)
})
it('keeps the actual Claude permission mode while waiting for input', () => {
  const options = settingsPresentation(session({ status: 'idle', permissionMode: 'acceptEdits' }))
  expect(options.label('acceptEdits')).toBe('Accept edits')
})
it('only offers efforts reported by the selected model and respects host capabilities', () => {
  expect(settingsPresentation(session({ provider: 'codex', effort: 'high', models: [] })).efforts).toEqual([])
  expect(settingsPresentation(session()).efforts).toEqual(['low', 'medium', 'high'])
  expect(settingsPresentation(session({ hostVersion: 0 })).modes).toEqual([])
  expect(settingsPresentation(session({ provider: 'muse', bypassAllowed: true })).modes).toEqual(['default', 'bypassPermissions'])
})
it.each(['cursor', 'future-provider'])('hides unsupported controls for %s', (provider) => {
  const options = settingsPresentation(session({ provider: provider as ChatSessionInfo['provider'] }))
  expect(options).toMatchObject({ efforts: [], modes: [], showPermission: false })
})

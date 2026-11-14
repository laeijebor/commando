import * as SecureStore from 'expo-secure-store'

import { LAUNCH_KEY, loadLaunchStore, rememberLaunch, resolveLaunch } from './prefs'

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store

beforeEach(() => store.clear())

describe('remembered launch settings', () => {
  it('records a launch for the repository and as the last one anywhere', async () => {
    await rememberLaunch('/code/app', { startWith: 'codex-chat', permissions: { 'codex-chat': 'plan' }, fast: true })
    await rememberLaunch('/code/site', { startWith: 'claude-chat', models: { claude: 'opus' } })
    const saved = await loadLaunchStore()
    expect(resolveLaunch(saved, '/code/app')).toEqual({ startWith: 'codex-chat', permissions: { 'codex-chat': 'plan' }, fast: true, models: { claude: 'opus' } })
    expect(resolveLaunch(saved, '/code/new')).toEqual({ startWith: 'claude-chat', permissions: { 'codex-chat': 'plan' }, fast: true, models: { claude: 'opus' } })
    expect(resolveLaunch(saved, undefined)).toEqual(resolveLaunch(saved, '/code/new'))
  })

  it('keeps earlier choices for other providers and models when a launch adds one', async () => {
    await rememberLaunch('/code/app', { permissions: { 'codex-chat': 'plan' }, models: { codex: 'gpt' } })
    await rememberLaunch('/code/app', { permissions: { 'claude-chat': 'acceptEdits' }, models: { claude: 'opus' } })
    expect(resolveLaunch(await loadLaunchStore(), '/code/app')).toEqual({
      permissions: { 'codex-chat': 'plan', 'claude-chat': 'acceptEdits' },
      models: { codex: 'gpt', claude: 'opus' },
    })
  })

  it('drops stored values this app cannot start with', async () => {
    store.set(LAUNCH_KEY, JSON.stringify({
      '*': { startWith: 'teleport', permissions: { 'muse-chat': 'plan', 'codex-chat': 'bypassPermissions' }, configDir: 'relative', models: { claude: 3, codex: 'gpt' }, fast: 'yes' },
      broken: 'nope',
    }))
    expect(await loadLaunchStore()).toEqual({ '*': { permissions: { 'codex-chat': 'bypassPermissions' }, models: { codex: 'gpt' } } })
    store.set(LAUNCH_KEY, 'not json')
    expect(await loadLaunchStore()).toEqual({})
  })
})

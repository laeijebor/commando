// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { CHAT_LAUNCH_STORAGE_KEY, loadChatLaunch, saveChatLaunch } from './chatLaunchPreferences'

beforeEach(() => window.localStorage.clear())

describe('Muse chat launch preferences', () => {
  it('leaves behind choices saved when bypassPermissions meant sandboxed approve-everything', () => {
    window.localStorage.setItem(CHAT_LAUNCH_STORAGE_KEY, JSON.stringify({ 'muse:/repo': { permissionMode: 'bypassPermissions' }, 'muse:*': { permissionMode: 'bypassPermissions' } }))
    expect(loadChatLaunch('/repo', 'muse-chat')).toEqual({ permissionMode: 'default' })
  })

  it('remembers the current modes, including full access, per repository', () => {
    saveChatLaunch('/repo', { permissionMode: 'bypassPermissions' }, 'muse-chat')
    saveChatLaunch('/other', { permissionMode: 'acceptEdits' }, 'muse-chat')
    expect(loadChatLaunch('/repo', 'muse-chat')).toEqual({ permissionMode: 'bypassPermissions' })
    expect(loadChatLaunch('/new', 'muse-chat')).toEqual({ permissionMode: 'acceptEdits' })
    expect(loadChatLaunch('/repo', 'codex-chat')).toEqual({ permissionMode: 'default' })
  })
})

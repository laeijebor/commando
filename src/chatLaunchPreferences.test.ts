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


it('keeps DeepSeek permissions separate from Claude and Muse preferences', () => {
  saveChatLaunch('/repo', { permissionMode: 'bypassPermissions', configDir: '/home/.claude' })
  saveChatLaunch('/repo', { permissionMode: 'plan' }, 'deepseek-chat')
  expect(loadChatLaunch('/repo', 'deepseek-chat')).toEqual({ permissionMode: 'plan' })
  expect(loadChatLaunch('/repo', 'muse-chat')).toEqual({ permissionMode: 'default' })
  expect(loadChatLaunch('/repo')).toEqual({ permissionMode: 'bypassPermissions', configDir: '/home/.claude' })
})

it('remembers Cursor runtime per repo and host without affecting other providers', () => {
  saveChatLaunch('/repo', { permissionMode: 'plan', cursorRuntime: 'cloud' }, 'cursor-chat')
  saveChatLaunch('/other', { permissionMode: 'bypassPermissions', cursorRuntime: 'local' }, 'cursor-chat')
  expect(loadChatLaunch('/repo', 'cursor-chat')).toEqual({ permissionMode: 'plan', cursorRuntime: 'cloud' })
  expect(loadChatLaunch('/new', 'cursor-chat')).toEqual({ permissionMode: 'bypassPermissions', cursorRuntime: 'local' })
  expect(loadChatLaunch('/repo', 'cursor-chat', 'remote')).toEqual({ permissionMode: 'bypassPermissions' })
  saveChatLaunch('/repo', { permissionMode: 'plan', cursorRuntime: 'cloud' }, 'codex-chat')
  expect(loadChatLaunch('/repo', 'codex-chat')).toEqual({ permissionMode: 'plan' })
})

it('remembers valid Cursor environments per repo and host, and clears the default choice', () => {
  saveChatLaunch('/repo', { permissionMode: 'plan', cursorEnvironment: 'App Dev' }, 'cursor-chat')
  saveChatLaunch('/other', { permissionMode: 'plan', cursorEnvironment: 'Other Dev' }, 'cursor-chat')
  expect(loadChatLaunch('/repo', 'cursor-chat').cursorEnvironment).toBe('App Dev')
  expect(loadChatLaunch('/other', 'cursor-chat').cursorEnvironment).toBe('Other Dev')
  expect(loadChatLaunch('/repo', 'cursor-chat', 'remote').cursorEnvironment).toBeUndefined()
  expect(loadChatLaunch('/repo', 'codex-chat').cursorEnvironment).toBeUndefined()
  saveChatLaunch('/repo', { permissionMode: 'plan' }, 'cursor-chat')
  expect(loadChatLaunch('/repo', 'cursor-chat').cursorEnvironment).toBeUndefined()
  saveChatLaunch('/repo', { permissionMode: 'plan', cursorEnvironment: 'bad\nname' }, 'cursor-chat')
  expect(loadChatLaunch('/repo', 'cursor-chat').cursorEnvironment).toBeUndefined()
})


it('restores Cursor environments only from a per-repo key, while retaining other last-used settings', () => {
  saveChatLaunch('/repo', { permissionMode: 'plan', cursorRuntime: 'cloud', cursorEnvironment: 'Repo Dev' }, 'cursor-chat')
  expect(loadChatLaunch('/repo', 'cursor-chat')).toEqual({ permissionMode: 'plan', cursorRuntime: 'cloud', cursorEnvironment: 'Repo Dev' })
  expect(loadChatLaunch('/new-repo', 'cursor-chat')).toEqual({ permissionMode: 'plan', cursorRuntime: 'cloud' })
  expect(loadChatLaunch(undefined, 'cursor-chat')).toEqual({ permissionMode: 'plan', cursorRuntime: 'cloud' })
  expect(loadChatLaunch('*', 'cursor-chat')).toEqual({ permissionMode: 'plan', cursorRuntime: 'cloud' })
})

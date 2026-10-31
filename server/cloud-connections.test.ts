import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudConnections, resolveCloudExecutable } from './cloud-connections.js'
import type { CloudCliResult, CloudCliRunner } from './cloud-provider.js'

const homes: string[] = []
function home() { const path = mkdtempSync(join(tmpdir(), 'commando-cloud-connections-')); homes.push(path); return path }
function binary(path: string, mode = 0o700) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '#!/bin/sh\nexit 0\n'); chmodSync(path, mode); return path }
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); vi.unstubAllEnvs() })

describe('cloud executable discovery', () => {
  it('finds a native Claude install even when the agent PATH omits it', () => {
    const root = home()
    const path = binary(join(root, '.local/bin/claude'))
    expect(resolveCloudExecutable('claude', { env: { PATH: '' }, home: root })).toBe(path)
  })
  it('prefers explicit overrides and PATH over fallback installations', () => {
    const root = home()
    binary(join(root, '.local/bin/claude'))
    const path = binary(join(root, 'preferred/claude'))
    expect(resolveCloudExecutable('claude', { env: { PATH: dirname(path) }, home: root })).toBe(path)
    expect(resolveCloudExecutable('claude', { env: { COMMANDO_CLAUDE_CLI: '/missing/intentional' }, home: root })).toBe('/missing/intentional')
    expect(resolveCloudExecutable('claude', { env: { COMMANDO_CLAUDE_CLI: '' }, home: root })).toBe('')
  })
  it('discovers Codex from another NVM Node version in semantic order', () => {
    const root = home()
    binary(join(root, '.nvm/versions/node/v9.0.0/bin/codex'))
    const chosen = binary(join(root, '.nvm/versions/node/v24.18.0/bin/codex'))
    mkdirSync(join(root, '.nvm/versions/node/v24.20.0/bin'), { recursive: true })
    binary(join(root, '.nvm/versions/node/not-a-version/bin/codex'))
    expect(resolveCloudExecutable('codex', { env: { PATH: join(root, '.nvm/versions/node/v24.20.0/bin') }, home: root })).toBe(chosen)
  })
  it('honors a custom NVM directory and skips nonexecutable files', () => {
    const root = home()
    const nvm = join(root, 'custom-nvm')
    binary(join(nvm, 'versions/node/v25.0.0/bin/codex'), 0o600)
    const chosen = binary(join(nvm, 'versions/node/v24.0.0/bin/codex'))
    expect(resolveCloudExecutable('codex', { env: { PATH: '', NVM_DIR: nvm }, home: root })).toBe(chosen)
    expect(resolveCloudExecutable('claude', { env: { PATH: '', NVM_DIR: nvm }, home: root })).toBe('claude')
  })
})

describe('configured Claude connections', () => {
  const success = (stdout: string): CloudCliResult => ({ stdout, stderr: '', exitCode: 0, signal: null, spawned: true, timedOut: false, truncated: false })
  it('creates independent Team and Max namespaces and never inherits a global profile/version gate', async () => {
    const root = home()
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/ambient/wrong-account')
    vi.stubEnv('COMMANDO_CLOUD_CLAUDE_VERIFIED_VERSION', '2.1.270')
    const runner = vi.fn<CloudCliRunner>(async (request) => success(request.executable === '/fake/codex' ? 'codex-cli 0.153.4\n' : '2.1.270 (Claude Code)\n'))
    const connections = createCloudConnections({ home: root, env: { COMMANDO_CLAUDE_CLI: '/fake/claude', COMMANDO_CODEX_CLI: '/fake/codex' }, runner })
    const infos = await Promise.all(connections.map((connection) => connection.info()))
    expect(infos.map(({ id, credentialContextId, label }) => ({ id, credentialContextId, label }))).toEqual([
      { id: 'claude', credentialContextId: 'claude:team', label: 'Claude Team' },
      { id: 'claude', credentialContextId: 'claude:max', label: 'Claude Max' },
      { id: 'codex', credentialContextId: 'codex:default', label: 'Codex' },
    ])
    expect(infos.every((info) => info.readiness === 'unverified')).toBe(true)
    expect(runner.mock.calls.map(([request]) => request.claudeConfigDir)).toEqual([null, join(root, '.claudep'), undefined])
    expect(process.env.CLAUDE_CONFIG_DIR).toBe('/ambient/wrong-account')
  })
  it('verifying Team does not enable Max and each connection can have its own namespace', async () => {
    const root = home()
    const runner: CloudCliRunner = async () => success('2.1.270 (Claude Code)\n')
    const connections = createCloudConnections({ home: root, runner, env: {
      PATH: '', COMMANDO_CLOUD_CLAUDE_TEAM_VERIFIED_VERSION: '2.1.270',
      COMMANDO_CLOUD_CLAUDE_TEAM_CONTEXT: 'team:test', COMMANDO_CLOUD_CLAUDE_MAX_CONTEXT: 'max:test',
    } })
    expect(await connections[0].info()).toMatchObject({ credentialContextId: 'team:test', capabilities: { create: false, sendMessage: true } })
    expect(await connections[1].info()).toMatchObject({ credentialContextId: 'max:test', capabilities: { create: false, sendMessage: false } })
  })
  it('passes an explicit Max directory without changing the Team default semantics', async () => {
    const root = home()
    const runner = vi.fn<CloudCliRunner>(async () => success('2.1.270 (Claude Code)\n'))
    const connections = createCloudConnections({ home: root, runner, env: { PATH: '', COMMANDO_CLOUD_CLAUDE_MAX_CONFIG_DIR: '/custom/max' } })
    await Promise.all(connections.slice(0, 2).map((connection) => connection.info()))
    expect(runner.mock.calls.map(([request]) => request.claudeConfigDir)).toEqual([null, '/custom/max'])
  })
  it('passes an explicit Team directory when the Team login lives in its own config dir', async () => {
    const root = home()
    const runner = vi.fn<CloudCliRunner>(async () => success('2.1.270 (Claude Code)\n'))
    const connections = createCloudConnections({ home: root, runner, env: { PATH: '', COMMANDO_CLOUD_CLAUDE_TEAM_CONFIG_DIR: '/custom/team' } })
    await Promise.all(connections.slice(0, 2).map((connection) => connection.info()))
    expect(runner.mock.calls.map(([request]) => request.claudeConfigDir)).toEqual(['/custom/team', join(root, '.claudep')])
  })
})

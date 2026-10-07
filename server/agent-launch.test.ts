import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { sessionAgentArgv } from '../shared/tmux-create.js'
import { AGENT_LAUNCH_ENV_KEYS, agentLaunchPaneCommand, resolveAgentExecutable } from './tmux-create.js'

const exec = promisify(execFile)

it('executes the launch script with literal prompt argv and only launches after successful preparation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commando-launch-'))
  const binary = join(directory, "agent with ' spaces")
  await writeFile(binary, '#!/bin/sh\ntest -f prepared || exit 81\nprintf "%s" "$3" > prompt\n', { mode: 0o755 })
  const prompt = "--force\nLeo's $HOME `touch injected`; $(touch injected)"
  const argv = sessionAgentArgv({ provider: 'cursor', prompt })
  argv[0] = binary
  const options = { cwd: directory, env: { ...process.env, SHELL: '/usr/bin/true' } }
  try {
    const failed = await exec('/bin/sh', ['-c', agentLaunchPaneCommand(argv, 'exit 7')], options)
    expect(failed.stderr).toContain('Worktree preparation failed (exit 7); agent was not started')
    await expect(readFile(join(directory, 'prompt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await exec('/bin/sh', ['-c', agentLaunchPaneCommand(argv, 'touch prepared')], options)
    expect(await readFile(join(directory, 'prompt'), 'utf8')).toBe(prompt)
    argv[3] = ';'
    await exec('/bin/sh', ['-c', agentLaunchPaneCommand(argv)], options)
    expect(await readFile(join(directory, 'prompt'), 'utf8')).toBe(';')
    await expect(readFile(join(directory, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('preflights an executable and rejects non-executable, directory and checkout-relative PATH entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commando-executable-'))
  try {
    await writeFile(join(directory, 'agent'), '#!/bin/sh\n', { mode: 0o644 })
    await expect(resolveAgentExecutable('agent', { PATH: directory })).rejects.toThrow('executable not found')
    await writeFile(join(directory, 'cursor-agent'), '#!/bin/sh\n', { mode: 0o755 })
    await expect(resolveAgentExecutable('cursor-agent', { PATH: directory })).resolves.toBe(join(directory, 'cursor-agent'))
    await expect(resolveAgentExecutable('cursor-agent', { PATH: '.' })).rejects.toThrow('executable not found')
    await expect(resolveAgentExecutable(directory.split('/').at(-1)!, { PATH: tmpdir() })).rejects.toThrow('executable not found')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('replaces the wrapper PID and restores exactly the allowed daemon environment over stale inherited values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commando-exec-env-'))
  const binary = join(directory, 'agent')
  const staleEnv = Object.fromEntries(AGENT_LAUNCH_ENV_KEYS.map((key) => [key, 'stale-value']))
  const daemonEnv = { PATH: '/usr/bin:/bin', HOME: directory, SHELL: '/bin/sh', CLAUDE_CONFIG_DIR: "daemon's profile", COMMANDO_AGENT_HOOK_TOKEN_PATH: 'fixture-hook', UNRELATED_SECRET: 'fixture-do-not-forward' }
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync('report', JSON.stringify({pid: process.pid, env: Object.fromEntries(${JSON.stringify([...AGENT_LAUNCH_ENV_KEYS])}.map(key => [key, process.env[key] ?? null])), unforwarded: process.env.UNRELATED_SECRET ?? null}))
`, { mode: 0o755 })
  try {
    // The same shell PID must survive both exec layers. A waiting wrapper fails this assertion.
    const command = `printf '%s' "$$" > wrapper-pid\n${agentLaunchPaneCommand([binary], undefined, daemonEnv)}`
    await exec('/bin/sh', ['-c', command], { cwd: directory, env: staleEnv })
    const report = JSON.parse(await readFile(join(directory, 'report'), 'utf8'))
    expect(report.pid).toBe(Number(await readFile(join(directory, 'wrapper-pid'), 'utf8')))
    for (const key of AGENT_LAUNCH_ENV_KEYS) expect(report.env[key]).toBe((daemonEnv as Record<string, string>)[key] ?? null)
    expect(report.unforwarded).toBeNull()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

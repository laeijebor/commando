import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn }))

import { runCommand, validateRunCommand } from './run-command.js'

describe('run command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('SHELL', '/bin/test-shell')
  })

  it('launches a detached shell command from the requested working directory', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    spawn.mockReturnValue(child)

    const launched = runCommand('open .', '/tmp/project')
    child.emit('spawn')

    await expect(launched).resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledWith('/bin/test-shell', ['-lc', 'open .'], {
      cwd: '/tmp/project',
      detached: true,
      shell: false,
      stdio: 'ignore',
    })
    expect(child.unref).toHaveBeenCalled()
  })

  it('rejects empty, padded, multiline, and oversized commands', () => {
    expect(() => validateRunCommand('')).toThrow()
    expect(() => validateRunCommand(' open .')).toThrow()
    expect(() => validateRunCommand('open .\nwhoami')).toThrow()
    expect(() => validateRunCommand('x'.repeat(8 * 1024 + 1))).toThrow()
  })
})

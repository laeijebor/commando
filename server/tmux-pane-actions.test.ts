import { describe, expect, it, vi } from 'vitest'
import { type TmuxProcessExecutor } from './tmux-session-actions.js'
import { TmuxPaneActions } from './tmux-pane-actions.js'

describe('tmux pane actions', () => {
  it('uses fixed argv and the configured socket for rename and delete', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const actions = new TmuxPaneActions(execute, { COMMANDO_TMUX_SOCKET_PATH: '/tmp/qa.sock' })

    await actions.rename('%12', 'api server')
    await actions.delete('%12')

    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      ['-S', '/tmp/qa.sock', 'select-pane', '-t', '%12', '-T', 'api server'],
      ['-S', '/tmp/qa.sock', 'kill-pane', '-t', '%12'],
    ])
    expect(execute.mock.calls[0][2]).toMatchObject({ shell: false, timeout: 3_000 })
  })

  it('rejects invalid pane identifiers and titles before executing tmux', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const actions = new TmuxPaneActions(execute, {})

    await expect(actions.rename('12', 'name')).rejects.toThrow('Invalid tmux pane id')
    await expect(actions.rename('%12', ' bad')).rejects.toThrow('without surrounding whitespace')
    await expect(actions.rename('%12', 'bad\nname')).rejects.toThrow('control characters')
    await expect(actions.delete('%12;kill-server')).rejects.toThrow('Invalid tmux pane id')
    expect(execute).not.toHaveBeenCalled()
  })
})

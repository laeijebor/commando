import { describe, expect, it, vi } from 'vitest'
import { type TmuxProcessExecutor } from './tmux-session-actions.js'
import { TmuxPaneActions } from './tmux-pane-actions.js'
import { emptyPaneCommand } from './tmux-create.js'

describe('tmux pane actions', () => {
  it('uses fixed argv and the configured socket for rename and delete', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    execute.mockResolvedValueOnce({ stdout: '', stderr: '' }).mockResolvedValueOnce({ stdout: '1 2\n', stderr: '' })
    const actions = new TmuxPaneActions(execute, { COMMANDO_TMUX_SOCKET_PATH: '/tmp/qa.sock' })

    await actions.rename('%12', 'api server')
    await expect(actions.delete('%12')).resolves.toBe('killed')

    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      ['-S', '/tmp/qa.sock', 'select-pane', '-t', '%12', '-T', 'api server'],
      ['-S', '/tmp/qa.sock', 'display-message', '-p', '-t', '%12', '#{session_windows} #{window_panes}'],
      ['-S', '/tmp/qa.sock', 'kill-pane', '-t', '%12'],
    ])
    expect(execute.mock.calls[0][2]).toMatchObject({ shell: false, timeout: 3_000 })
  })

  it("closes a window's last pane while the session has other windows", async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValueOnce({ stdout: '2 1\n', stderr: '' }).mockResolvedValue({ stdout: '', stderr: '' })
    await expect(new TmuxPaneActions(execute, {}).delete('%12')).resolves.toBe('killed')
    expect(execute.mock.calls.at(-1)?.[1]).toEqual(['kill-pane', '-t', '%12'])
  })

  it("empties a session's only pane instead of ending the session", async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValueOnce({ stdout: '1 1\n', stderr: '' }).mockResolvedValue({ stdout: '', stderr: '' })
    await expect(new TmuxPaneActions(execute, { COMMANDO_TMUX_SOCKET_NAME: 'qa' }).delete('%12', '/work/app')).resolves.toBe('emptied')

    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][1]).toEqual([
      '-L', 'qa',
      'respawn-pane', '-k', '-t', '%12', '-c', '/work/app', emptyPaneCommand(),
      ';', 'set-option', '-p', '-F', '-t', '%12', '@commando_empty', '#{pane_pid}',
      ';', 'set-option', '-p', '-u', '-t', '%12', '@commando_target',
      ';', 'set-option', '-p', '-u', '-t', '%12', '@commando_opened_by',
      ';', 'set-option', '-p', '-u', '-t', '%12', '@commando_chat_title',
      ';', 'select-pane', '-t', '%12', '-T', '',
    ])
    expect(execute.mock.calls.flatMap((call) => call[1])).not.toContain('kill-pane')
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

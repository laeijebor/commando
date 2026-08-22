import { afterEach, describe, expect, it, vi } from 'vitest'
import { TmuxResurrectSaver } from './tmux-resurrect-saver.js'
import type { TmuxProcessExecutor } from './tmux-session-actions.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('TmuxResurrectSaver', () => {
  it('runs the configured Resurrect save script quietly on the configured socket', async () => {
    const execute = vi.fn<TmuxProcessExecutor>()
      .mockResolvedValueOnce({
        stdout: "/Users/leo's plugins/tmux-resurrect/scripts/save.sh\n",
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    const saver = new TmuxResurrectSaver({
      execute,
      environment: { COMMANDO_TMUX_SOCKET_NAME: 'commando.qa' },
    })

    await expect(saver.save()).resolves.toBe('saved')

    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      ['-L', 'commando.qa', 'show-options', '-gqv', '@resurrect-save-script-path'],
      [
        '-L',
        'commando.qa',
        'run-shell',
        "'/Users/leo'\"'\"'s plugins/tmux-resurrect/scripts/save.sh' quiet",
      ],
    ])
    expect(execute.mock.calls[1][2]).toMatchObject({ shell: false, timeout: 30_000 })
  })

  it('does nothing when tmux-resurrect is not configured', async () => {
    const execute = vi.fn<TmuxProcessExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const saver = new TmuxResurrectSaver({ execute, environment: {} })

    await expect(saver.save()).resolves.toBe('unavailable')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent save requests', async () => {
    let resolveLookup!: (value: { stdout: string; stderr: string }) => void
    const lookup = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveLookup = resolve
    })
    const execute = vi.fn<TmuxProcessExecutor>()
      .mockImplementationOnce(() => lookup)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    const saver = new TmuxResurrectSaver({ execute, environment: {} })

    const first = saver.save()
    const second = saver.save()
    expect(second).toBe(first)

    resolveLookup({ stdout: '/tmp/resurrect/save.sh\n', stderr: '' })
    await expect(Promise.all([first, second])).resolves.toEqual(['saved', 'saved'])
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('saves on its interval and stops cleanly', async () => {
    vi.useFakeTimers()
    const execute = vi.fn<TmuxProcessExecutor>()
      .mockResolvedValueOnce({ stdout: '/tmp/resurrect/save.sh\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    const saver = new TmuxResurrectSaver({ execute, environment: {}, intervalMs: 1_000 })

    saver.start()
    saver.start()
    await vi.advanceTimersByTimeAsync(999)
    expect(execute).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(execute).toHaveBeenCalledTimes(2)

    saver.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(execute).toHaveBeenCalledTimes(2)
  })
})

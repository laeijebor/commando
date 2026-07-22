import { describe, expect, it, vi } from 'vitest'

import { captureRenderedCompanionOutput } from './companion-output.js'

describe('captureRenderedCompanionOutput', () => {
  it('reads the rendered tmux grid instead of terminal repaint bytes', async () => {
    const capturePane = vi.fn(async () => Buffer.from('Scanning complete\nFinal answer\n'))
    const paneCurrentCommand = vi.fn(async () => 'opencode')

    const result = await captureRenderedCompanionOutput(
      { capturePane, paneCurrentCommand },
      '$1',
      '%2',
    )

    expect(result).toEqual({
      command: 'opencode',
      output: 'Scanning complete\r\nFinal answer',
    })
    expect(capturePane).toHaveBeenCalledWith('$1', '%2')
    expect(paneCurrentCommand).toHaveBeenCalledWith('%2')
  })
})

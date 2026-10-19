import { expect, it } from 'vitest'
import { modelPrintEnv } from './model-print.js'
it('scrubs pane identity without mutating the daemon environment and preserves the selected profile', () => {
  const original = { TMUX: 'socket', TMUX_PANE: '%1', COMMANDO_CHAT_RESUME: 'yes', PATH: '/bin', CLAUDE_CONFIG_DIR: '/profile' }
  expect(modelPrintEnv(original)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/profile' })
  expect(modelPrintEnv(original, '/other').CLAUDE_CONFIG_DIR).toBe('/other')
  expect(original.TMUX_PANE).toBe('%1')
})

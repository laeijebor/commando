import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import base from '../playwright.config'

// Only Vite is started. The fixture supplies its own transport and SDK assets;
// this suite never contacts a daemon or touches a tmux/session queue.
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'redline-feedback.pw.ts',
  outputDir: '../test-results/redline-feedback',
  workers: 1,
  use: { ...base.use, baseURL: 'http://127.0.0.1:5279' },
  webServer: {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    command: 'npm exec vite -- --host 127.0.0.1 --port 5279 --strictPort',
    url: 'http://127.0.0.1:5279',
    reuseExistingServer: false,
    timeout: 30_000,
    env: { COMMANDO_PORT: '4416', COMMANDO_TMUX_SOCKET_NAME: 'redline-ux-review' },
  },
})

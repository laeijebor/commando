import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  outputDir: './test-results/terminal-fidelity',
  reporter: 'line',
  use: {
    browserName: 'chromium',
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    locale: 'en-US',
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath: process.env.COMMANDO_CHROMIUM ?? '/opt/homebrew/bin/chromium',
    },
  },
})

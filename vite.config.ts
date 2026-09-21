import react from '@vitejs/plugin-react'
// `vitest/config` re-exports Vite's defineConfig with the `test` block typed.
import { configDefaults, defineConfig } from 'vitest/config'

const daemonPort = process.env.COMMANDO_PORT ?? '4310'
const daemonHttpTarget = `http://127.0.0.1:${daemonPort}`
const daemonWebSocketTarget = `ws://127.0.0.1:${daemonPort}`

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ['./server/test-env-sandbox.ts'],
    // apps/mobile is an Expo app with its own jest-expo suite; Vite cannot
    // transform React Native sources, so it is left to `npm run mobile:test`.
    exclude: [...configDefaults.exclude, 'apps/mobile/**'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': daemonHttpTarget,
      '/screenshots': daemonHttpTarget,
      '/ws': {
        target: daemonWebSocketTarget,
        ws: true,
      },
    },
  },
})

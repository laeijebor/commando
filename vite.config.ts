import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const daemonPort = process.env.COMMANDO_PORT ?? '4310'
const daemonHttpTarget = `http://127.0.0.1:${daemonPort}`
const daemonWebSocketTarget = `ws://127.0.0.1:${daemonPort}`

export default defineConfig({
  plugins: [react()],
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

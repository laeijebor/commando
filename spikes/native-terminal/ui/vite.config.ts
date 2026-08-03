import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const daemonPort = Number(process.env.COMMANDO_PORT ?? 4310)
const uiPort = Number(process.env.COMMANDO_NATIVE_UI_PORT ?? 5190)

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: uiPort,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${daemonPort}`,
      '/ws': {
        target: `ws://127.0.0.1:${daemonPort}`,
        ws: true,
      },
    },
  },
})

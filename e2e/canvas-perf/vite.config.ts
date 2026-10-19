import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Connect, type Plugin } from 'vite'

// Serves CANVAS_PERF_DIR as artifact 00000000000000aa, mirroring the daemon's
// redline static routes (canvas-frame.js injection included). /api answers 404
// so nothing is proxied to a real daemon.
const repo = fileURLToPath(new URL('../..', import.meta.url))
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' }
const artifacts: Connect.NextHandleFunction = (request, response, next) => {
  const url = new URL(request.url ?? '/', 'http://harness')
  if (url.pathname.startsWith('/api/')) { response.statusCode = 404; response.end('{}'); return }
  if (url.pathname === '/redline/canvas-frame.js') {
    response.setHeader('Content-Type', types['.js']); response.end(readFileSync(join(repo, 'server/static/canvas-frame.js'))); return
  }
  const match = /^\/redline\/artifacts\/00000000000000aa\/(.*)$/.exec(url.pathname)
  if (!match) return next()
  const root = resolve(process.env.CANVAS_PERF_DIR ?? '')
  const file = normalize(join(root, decodeURIComponent(match[1])))
  if (!process.env.CANVAS_PERF_DIR || !file.startsWith(root) || !statSync(file, { throwIfNoEntry: false })?.isFile()) { response.statusCode = 404; response.end(); return }
  let body: Buffer | string = readFileSync(file)
  const frameId = url.searchParams.get('canvas-frame')
  if (frameId && extname(file) === '.html') {
    const html = body.toString('utf8'), script = `<script src="/redline/canvas-frame.js" data-canvas-frame="${frameId}"></script>`
    const end = [...html.matchAll(/<\/body\s*>/gi)].at(-1)
    body = end ? html.slice(0, end.index) + script + html.slice(end.index) : html + script
  }
  response.setHeader('Content-Type', types[extname(file).toLowerCase()] ?? 'application/octet-stream')
  response.setHeader('Cache-Control', 'no-store')
  response.end(body)
}
const serveArtifacts = (): Plugin => ({
  name: 'canvas-perf-artifacts',
  configureServer: (server) => { server.middlewares.use(artifacts) },
  configurePreviewServer: (server) => { server.middlewares.use(artifacts) },
})

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [serveArtifacts(), react(), tailwindcss()],
  build: { outDir: join(repo, 'test-results/canvas-perf-build'), emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5284, strictPort: true, fs: { allow: [repo] } },
  preview: { host: '127.0.0.1', port: 5284, strictPort: true },
})

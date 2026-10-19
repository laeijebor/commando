// Canvas zoom/pan benchmark. Starts `vite preview` on the harness build and
// drives wheel pan, pinch zoom and drag pan in WebKit and Chromium.
// Build first: CANVAS_PERF_DIR=<dir> npx vite build --config e2e/canvas-perf/vite.config.ts
// Usage: CANVAS_PERF_DIR=<canvas folder> node e2e/canvas-perf/bench.mjs
//   [--browsers webkit,chromium] [--runs 3] [--scenarios a,b] [--variant name=buildDir[::css]]...
// Env: HEADED=1 shows the browser windows; WIDTH sets the canvas pane width.
import { execFileSync, spawn } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const browsers = option('browsers', 'webkit,chromium').split(',')
const runs = Number(option('runs', 3))
const only = option('scenarios')?.split(',')
// --variant name=buildDir[::css] (repeatable); default: the current build.
const variants = args.flatMap((arg, i) => args[i - 1] === '--variant' ? [arg] : []).map((spec, index) => {
  const [name, rest] = spec.split(/=(.*)/s), [dir, css] = rest.split('::')
  return { name, dir, css, port: 5284 + index }
})
if (!variants.length) variants.push({ name: 'current', dir: 'test-results/canvas-perf-build', port: 5284 })
if (!process.env.CANVAS_PERF_DIR) throw new Error('CANVAS_PERF_DIR is required')

const servers = await Promise.all(variants.map((variant) => new Promise((resolve, reject) => {
  const server = spawn('npx', ['vite', 'preview', '--config', 'e2e/canvas-perf/vite.config.ts', '--outDir', resolvePath(repo, variant.dir), '--port', String(variant.port)], { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
  server.stdout.on('data', (chunk) => { if (String(chunk).includes(String(variant.port))) resolve(server) })
  server.on('exit', (code) => reject(new Error(`vite preview exited ${code}`)))
})))
const stop = () => { for (const server of servers) server.kill() }
process.on('exit', stop)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0 }
const round = (value) => Math.round(value * 10) / 10

// Paced like a trackpad: one event per `interval` ms, never faster.
async function paced(count, interval, send) {
  const start = performance.now()
  for (let i = 0; i < count; i++) {
    await send(i)
    const wait = start + (i + 1) * interval - performance.now()
    if (wait > 0) await sleep(wait)
  }
  return performance.now() - start
}

// CPU seconds per browser process role, from ps. Low Power Mode throttles WebKit's
// rendering to 30 Hz, so frame pacing alone can hide main-thread savings.
// Only processes alive at both samples count, so exits never go negative.
function cpu() {
  const processes = new Map()
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=,time=,command='], { encoding: 'utf8' }).split('\n')) {
    if (!line.includes('ms-playwright') && !line.includes('Google Chrome')) continue
    const [pid, time, ...rest] = line.trim().split(/\s+/), command = rest.join(' ')
    if (/Networking|crashpad|--type=utility|--type=zygote/.test(command)) continue
    const seconds = time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
    processes.set(pid, { seconds, role: /WebContent|--type=renderer/.test(command) ? 'web' : /WebKit\.GPU|--type=gpu-process/.test(command) ? 'gpu' : 'ui' })
  }
  return processes
}
function cpuDelta(before, after) {
  const totals = { web: 0, gpu: 0, ui: 0 }
  for (const [pid, { seconds, role }] of after) if (before.has(pid)) totals[role] += seconds - before.get(pid).seconds
  return totals
}

async function measure(page, cdp, name, gesture) {
  await page.evaluate(() => {
    const w = window
    w.__perf = { frames: [], events: [], running: true }
    const tick = (now) => { w.__perf.frames.push(now); if (w.__perf.running) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  const cpuBefore = cpu()
  const before = cdp && Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  const wall = await gesture()
  await sleep(300) // let the last frames land
  const frames = await page.evaluate(() => { window.__perf.running = false; return window.__perf.frames })
  const used = cpuDelta(cpuBefore, cpu())
  const after = cdp && Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  const intervals = frames.slice(1).map((t, i) => t - frames[i])
  const result = {
    scenario: name, wallMs: round(wall), frames: intervals.length,
    p50: round(quantile(intervals, 0.5)), p95: round(quantile(intervals, 0.95)), max: round(Math.max(...intervals)),
    over40: intervals.filter((v) => v > 40).length, over50: intervals.filter((v) => v > 50).length,
    cpuWebMs: Math.round(used.web * 1000), cpuGpuMs: Math.round(used.gpu * 1000), cpuUiMs: Math.round(used.ui * 1000),
  }
  if (cdp) for (const key of ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration']) result[key.replace('Duration', 'Ms')] = round((after[key] - before[key]) * 1000)
  return result
}

async function scenarios(page, cdp) {
  const box = await page.locator('.canvas-viewport').boundingBox()
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  const fit = () => page.getByRole('button', { name: 'Fit', exact: true }).click().then(() => sleep(400))
  const results = []
  await fit()
  results.push(await measure(page, cdp, 'idle@fit', () => sleep(1000).then(() => 1000)))
  results.push(await measure(page, cdp, 'wheel-pan@fit', async () => {
    await page.mouse.move(cx, cy)
    return paced(120, 16, (i) => page.mouse.wheel(i < 60 ? 6 : -6, i % 40 < 20 ? 8 : -8))
  }))
  await fit()
  results.push(await measure(page, cdp, 'pinch-zoom@fit', async () => {
    await page.mouse.move(cx, cy)
    await page.keyboard.down('Control')
    const wall = await paced(120, 16, (i) => page.mouse.wheel(0, i < 60 ? -4 : 4))
    await page.keyboard.up('Control')
    return wall
  }))
  await fit()
  results.push(await measure(page, cdp, 'drag-pan@fit', async () => {
    // Start on the background between the toolbar and the first section.
    await page.mouse.move(box.x + 6, box.y + 6)
    await page.mouse.down()
    const wall = await paced(120, 16, (i) => page.mouse.move(box.x + 6 + (i < 60 ? i : 120 - i) * 4, box.y + 6 + (i < 60 ? i : 120 - i) * 3))
    await page.mouse.up()
    return wall
  }))
  // Zoomed in to 100% on the focus frame: most frames are off screen.
  await fit()
  await page.mouse.move(cx, cy)
  await page.keyboard.down('Control')
  for (let i = 0; i < 40 && !(await page.locator('.canvas-zoom').textContent()).startsWith('100'); i++) await page.mouse.wheel(0, -20)
  await page.keyboard.up('Control')
  await sleep(500)
  results.push(await measure(page, cdp, 'wheel-pan@zoomed', async () => paced(120, 16, (i) => page.mouse.wheel(i < 60 ? 12 : -12, i % 40 < 20 ? 16 : -16))))
  return results
}

const all = []
const launched = Object.fromEntries(await Promise.all(browsers.map(async (name) => [name, await (name === 'webkit' ? webkit : chromium).launch({ headless: !process.env.HEADED, ...(name === 'chrome' ? { channel: 'chrome' } : {}) })])))
// Interleave variants within each run so machine-load drift hits them equally.
for (let run = 0; run < runs; run++) for (const name of browsers) for (const variant of run % 2 ? [...variants].reverse() : variants) {
  const page = await launched[name].newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })
  const cdp = name !== 'webkit' ? await page.context().newCDPSession(page) : null
  if (cdp) await cdp.send('Performance.enable')
  await page.goto(`http://127.0.0.1:${variant.port}/?width=${process.env.WIDTH ?? 960}`)
  console.error('run', run, name, variant.name)
  await page.locator('.canvas-frame iframe').first().waitFor()
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {})
  if (variant.css) await page.addStyleTag({ content: variant.css })
  await sleep(1500)
  const frames = await page.locator('.canvas-frame').count()
  for (const result of (await scenarios(page, cdp)).filter((r) => !only || only.includes(r.scenario))) all.push({ browser: name, variant: variant.name, run, frameCount: frames, ...result })
  await page.close()
}
for (const browser of Object.values(launched)) await browser.close()

// Median per browser × scenario × variant across runs.
const groups = Map.groupBy(all, (r) => `${r.browser} ${r.scenario} ${r.variant}`)
const summary = [...groups.values()].map((rows) => {
  const out = { browser: rows[0].browser, scenario: rows[0].scenario, variant: rows[0].variant, frames: rows[0].frameCount }
  for (const key of Object.keys(rows[0]).filter((k) => typeof rows[0][k] === 'number' && !['run', 'frameCount'].includes(k))) out[key] = quantile(rows.map((r) => r[key]), 0.5)
  return out
}).sort((a, b) => `${a.browser} ${a.scenario}`.localeCompare(`${b.browser} ${b.scenario}`))
console.table(summary)
if (process.env.BENCH_JSON) (await import('node:fs')).writeFileSync(process.env.BENCH_JSON, JSON.stringify({ all, summary }, null, 2))
stop()
process.exit(0)

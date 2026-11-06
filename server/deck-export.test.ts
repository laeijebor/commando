import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedlineApi } from './redline-api.js'
import { RedlineArtifactRegistry } from './redline-artifacts.js'
import { CanvasSnapshotsStore } from './canvas-snapshots.js'
import { deckExportArgs, deckExportFailure } from './deck-export.js'
import { writeCanvas } from './canvas-write.js'

let dir: string, artifacts: RedlineArtifactRegistry, id: string, api: RedlineApi
const token = 'deck-agent-token-at-least-32-characters'
const html = '<title>Deck &amp; Title</title><main class="deck"><section class="slide" id="start"><h1>Hello</h1></section><section class="slide" id="end">End</section></main>'
const screenshot = vi.fn(async () => Buffer.from('PNG'))
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'deck-test-'))
  await writeFile(join(dir, 'deck.html'), html); await mkdir(join(dir, 'themes')); await writeFile(join(dir, 'themes/paper.css'), ':root{}')
  artifacts = new RedlineArtifactRegistry(); id = artifacts.register(dir).id
  api = new RedlineApi({ artifacts, agentToken: token, ownerAuthorized: async (req) => req.headers['x-owner'] === 'yes', baseUrl: 'http://localhost', screenshot })
  screenshot.mockClear()
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) })
async function request(path: string, body?: unknown, auth: 'agent' | 'owner' | 'none' = path === 'deck-export' || path === 'deck-reveal' ? 'owner' : 'agent') {
  const req = Readable.from(body ? [JSON.stringify(body)] : []) as unknown as IncomingMessage
  req.method = body ? 'POST' : 'GET'; req.headers = { 'content-type': 'application/json', ...(auth === 'agent' ? { authorization: `Bearer ${token}` } : auth === 'owner' ? { 'x-owner': 'yes' } : {}) }
  const chunks: Buffer[] = [], writeHead = vi.fn(), setHeader = vi.fn()
  const response = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next() } }) as Writable & { writeHead: typeof writeHead; setHeader: typeof setHeader }
  response.writeHead = writeHead; response.setHeader = setHeader
  await api.handle(req, response as unknown as ServerResponse, new URL(`/api/redline/artifacts/${id}/${path}`, 'http://localhost'))
  return { status: writeHead.mock.calls[0][0], headers: writeHead.mock.calls[0][1], text: Buffer.concat(chunks).toString() }
}
describe('deck-aware canvas API', () => {
  it('returns a deck manifest to agents and confines theme enumeration', async () => {
    const result = await request('canvas?manifest=deck.html')
    expect(result.status).toBe(200); expect(JSON.parse(result.text)).toMatchObject({ deck: { title: 'Deck & Title' }, manifest: { frames: [{ id: 'start', slide: 'start' }, { id: 'end', slide: 'end' }] } })
    expect(JSON.parse((await request('deck-themes?deck=deck.html', undefined, 'owner')).text)).toEqual({ themes: ['paper'], default: 'ink' })
    expect((await request('deck-themes?deck=../deck.html')).status).toBe(400)
    expect((await request('deck-themes?deck=deck.html', undefined, 'none')).status).toBe(401)
  })
  it('rejects all deck writes clearly and captures HTML and assets in history', async () => {
    for (const kind of ['frames', 'annotations', 'sections'] as const) expect(() => writeCanvas(artifacts, id, { manifest: 'deck.html' }, kind)).toThrow('Deck layout and section status are read-only')
    const store = new CanvasSnapshotsStore(artifacts, join(dir, 'saved-snapshots'))
    // Store outside artifact to keep snapshots from including themselves.
    const outside = await mkdtemp(join(tmpdir(), 'deck-history-'))
    try {
      const snapshots = new CanvasSnapshotsStore(artifacts, outside), saved = snapshots.capture(id, 'deck.html')!
      expect(saved.manifestTitle).toBe('Deck & Title')
      expect(await readFile(snapshots.resolve(id, saved.id, 'deck.html')!, 'utf8')).toBe(html)
      expect(await readFile(snapshots.resolve(id, saved.id, 'themes/paper.css')!, 'utf8')).toBe(':root{}')
      expect(store.list(id)).toEqual([])
    } finally { await rm(outside, { recursive: true, force: true }) }
  })
  it('exports a selected slide PNG with theme and hash through the existing route', async () => {
    expect((await request('canvas/frames/end.png?manifest=deck.html&theme=paper', undefined, 'owner')).status).toBe(200)
    expect(screenshot).toHaveBeenCalledWith(`http://localhost/redline/artifacts/${id}/deck.html?theme=paper#end`, 1280, 720)
  })
})
describe('deck export', () => {
  it('requires owner auth for deck exports and deck frame PNGs', async () => {
    for (const auth of ['agent', 'none'] as const) {
      expect((await request('deck-export', { deck: 'deck.html', format: 'pdf' }, auth)).status).toBe(401)
      expect((await request('canvas/frames/end.png?manifest=deck.html', undefined, auth)).status).toBe(401)
    }
    expect(screenshot).not.toHaveBeenCalled()
    expect((await request('deck-themes?deck=deck.html', undefined, 'agent')).status).toBe(200)
  })
  it.each([
    { stdout: 'Preparing...\n{"ok":false,"error":"Font Acme could not be loaded"}\n', stderr: 'Other diagnostic\n', expected: 'Font Acme could not be loaded' },
    { stdout: '{"ok":false,"error":123}\n', stderr: 'First diagnostic\nFinal renderer failure\n\n', expected: 'Final renderer failure' },
    { stdout: 'No JSON here\n', stderr: '', expected: 'Slide export failed. Check the slides CLI installation and deck assets.' },
  ])('surfaces CLI failure details: $expected', async ({ stdout, stderr, expected }) => {
    const cli = join(dir, 'failure.mjs')
    await writeFile(cli, `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode=1;`)
    vi.stubEnv('COMMANDO_SLIDES_CLI', cli); vi.stubEnv('COMMANDO_CHROMIUM_PATH', process.execPath)
    const result = await request('deck-export', { deck: 'deck.html', format: 'pdf' })
    expect(result.status).toBe(503); expect(JSON.parse(result.text).error).toBe(expected)
  })
  it('distinguishes output overflow from a real signal timeout', async () => {
    expect(deckExportFailure({ killed: true, signal: 'SIGTERM', code: null }, '', '')).toContain('timed out')
    expect(deckExportFailure({ killed: true, signal: 'SIGTERM', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, '', '')).toContain('buffer limit')
    expect(deckExportFailure({ killed: true, signal: undefined, code: 1 }, '', 'Failed')).toBe('Failed')
    expect(deckExportFailure({ killed: false, signal: 'SIGTERM', code: 1 }, '', 'Stopped')).toBe('Stopped')
    const cli = join(dir, 'overflow.mjs')
    await writeFile(cli, "process.stdout.write('x'.repeat(1024 * 1024 + 1));")
    vi.stubEnv('COMMANDO_SLIDES_CLI', cli); vi.stubEnv('COMMANDO_CHROMIUM_PATH', process.execPath)
    const result = await request('deck-export', { deck: 'deck.html', format: 'pdf' })
    expect(result.status).toBe(503); expect(result.text).toContain('buffer limit'); expect(result.text).not.toContain('timed out')
  })
  it('saves to the downloads folder without overwriting, and reveals only files it saved', async () => {
    const cli = join(dir, 'fake.mjs'), downloads = join(dir, 'Downloads')
    await mkdir(downloads)
    await writeFile(cli, `import fs from 'node:fs'; const args=process.argv.slice(2); fs.writeFileSync(args[args.indexOf('--out')+1],'exported'); console.log(JSON.stringify({ok:true}));`)
    vi.stubEnv('COMMANDO_SLIDES_CLI', cli); vi.stubEnv('COMMANDO_CHROMIUM_PATH', process.execPath); vi.stubEnv('COMMANDO_DOWNLOADS_DIR', downloads)
    const first = await request('deck-export', { deck: 'deck.html', format: 'pdf', save: 'downloads' })
    expect(first.status).toBe(200); expect(JSON.parse(first.text)).toEqual({ ok: true, path: join(downloads, 'deck-title.pdf'), name: 'deck-title.pdf' })
    expect(await readFile(join(downloads, 'deck-title.pdf'), 'utf8')).toBe('exported')
    const second = JSON.parse((await request('deck-export', { deck: 'deck.html', format: 'pdf', save: 'downloads' })).text)
    expect(second.name).toBe('deck-title (2).pdf')
    expect((await request('deck-export', { deck: 'deck.html', format: 'pdf', save: '/tmp' })).status).toBe(400)
    expect((await request('deck-reveal', { path: join(dir, 'deck.html') }, 'owner')).status).toBe(404)
    expect((await request('deck-reveal', { path: second.path }, 'agent')).status).toBe(401)
  })
  it('creates a missing downloads folder and reports an unwritable one clearly', async () => {
    const cli = join(dir, 'fake.mjs'), missing = join(dir, 'new', 'Downloads')
    await writeFile(cli, `import fs from 'node:fs'; const args=process.argv.slice(2); fs.writeFileSync(args[args.indexOf('--out')+1],'exported'); console.log(JSON.stringify({ok:true}));`)
    vi.stubEnv('COMMANDO_SLIDES_CLI', cli); vi.stubEnv('COMMANDO_CHROMIUM_PATH', process.execPath); vi.stubEnv('COMMANDO_DOWNLOADS_DIR', missing)
    expect(JSON.parse((await request('deck-export', { deck: 'deck.html', format: 'pdf', save: 'downloads' })).text).path).toBe(join(missing, 'deck-title.pdf'))
    vi.stubEnv('COMMANDO_DOWNLOADS_DIR', join(dir, 'deck.html', 'nested'))
    const result = await request('deck-export', { deck: 'deck.html', format: 'pdf', save: 'downloads' })
    expect(result.status).toBe(500); expect(JSON.parse(result.text).error).toMatch(/^Could not save to .*: E/)
  })
  it('builds literal CLI arguments', () => {
    expect(deckExportArgs('pdf', '/a deck/deck.html', '/out/file.pdf', '/Chrome path', 'paper')).toEqual(['pdf', '/a deck/deck.html', '--json', '--out', '/out/file.pdf', '--browser', '/Chrome path', '--theme', 'paper'])
  })
  it.each([{ deck: '../deck.html', format: 'pdf' }, { deck: 'deck.html#end', format: 'pdf' }, { deck: 'deck.html', format: 'exe' }, { deck: 'deck.html', format: 'pdf', theme: '../ink' }])('rejects invalid export input %j', async (body) => {
    expect((await request('deck-export', body)).status).toBe(400)
  })
  it.each(['missing', '../end', 42, null])('rejects unknown PNG slide %j before running the CLI', async (slide) => {
    vi.stubEnv('COMMANDO_SLIDES_CLI', join(dir, 'missing'))
    const result = await request('deck-export', { deck: 'deck.html', format: 'png', slide })
    expect(result.status).toBe(400); expect(result.text).toContain('Unknown slide id')
    expect(screenshot).not.toHaveBeenCalled()
  })
  it.each([undefined, 'end'])('streams the requested PNG slide %s from CLI files and cleans all images', async (slide) => {
    const cli = join(dir, 'png.mjs'), captured = join(dir, 'args.json')
    await writeFile(cli, `import fs from 'node:fs'; import path from 'node:path'; const args=process.argv.slice(2),out=args[args.indexOf('--out')+1]; fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify(args)); const files=['01-start.png','02-end.png'].map(name=>path.join(out,name)); for(const file of files) fs.writeFileSync(file,path.basename(file)); console.log(JSON.stringify({ok:true,files:files.reverse()}));`)
    vi.stubEnv('COMMANDO_SLIDES_CLI', cli); vi.stubEnv('COMMANDO_CHROMIUM_PATH', process.execPath)
    const result = await request('deck-export', { deck: 'deck.html', format: 'png', slide, theme: 'paper' })
    expect(result.status).toBe(200); expect(result.text).toBe(slide === 'end' ? '02-end.png' : '01-start.png')
    expect(result.headers['Content-Type']).toBe('image/png')
    expect(result.headers['Content-Disposition']).toBe(`attachment; filename="deck-title-${slide ?? 'start'}.png"`)
    expect(screenshot).not.toHaveBeenCalled()
    const args: string[] = JSON.parse(await readFile(captured, 'utf8'))
    expect(args).toEqual(deckExportArgs('png', await realpath(join(dir, 'deck.html')), args[4], process.execPath, 'paper'))
    expect(args[4]).not.toMatch(/\.png$/)
    await expect(readFile(join(args[4], '01-start.png'))).rejects.toThrow()
    await expect(readFile(join(args[4], '02-end.png'))).rejects.toThrow()
  })
  it('reports missing CLI and browser as 503', async () => {
    vi.stubEnv('COMMANDO_SLIDES_CLI', join(dir, 'missing'))
    const result = await request('deck-export', { deck: 'deck.html', format: 'pdf' })
    expect(result.status).toBe(503); expect(result.text).toContain('Slides CLI is missing')
    vi.stubEnv('COMMANDO_SLIDES_CLI', join(dir, 'deck.html')); vi.stubEnv('COMMANDO_CHROMIUM_PATH', join(dir, 'missing'))
    expect((await request('deck-export', { deck: 'deck.html', format: 'pdf' })).text).toContain('Chromium is missing')
  })
  it('allows at most two concurrent CLI exports and releases capacity afterward', async () => {
    const cli = join(dir, 'slow.mjs'), ready = join(dir, 'ready'), release = join(dir, 'release')
    await writeFile(cli, `import fs from 'node:fs'; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(ready)},'ready\\n'); while(!fs.existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10)); fs.writeFileSync(args[args.indexOf('--out')+1],'done'); console.log(JSON.stringify({ok:true}));`)
    vi.stubEnv('COMMANDO_SLIDES_CLI', cli); vi.stubEnv('COMMANDO_CHROMIUM_PATH', process.execPath)
    const first = request('deck-export', { deck: 'deck.html', format: 'pdf' }), second = request('deck-export', { deck: 'deck.html', format: 'pdf' })
    try {
      await vi.waitFor(async () => expect((await readFile(ready, 'utf8')).trim().split('\n')).toHaveLength(2))
      const third = await request('deck-export', { deck: 'deck.html', format: 'pdf' })
      expect(third.status).toBe(503); expect(third.text).toContain('already running')
    } finally { await writeFile(release, 'go'); await Promise.all([first, second]) }
    expect((await request('deck-export', { deck: 'deck.html', format: 'pdf' })).status).toBe(200)
  })
  it.each(['pdf', 'pptx', 'html'])('streams %s from a fake CLI and cleans temporary output', async (format) => {
    const cli = join(dir, 'fake.mjs'), captured = join(dir, 'args.json')
    await writeFile(cli, `import fs from 'node:fs'; const args=process.argv.slice(2); fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify(args)); fs.writeFileSync(args[args.indexOf('--out')+1],'exported'); console.log(JSON.stringify({ok:true}));`)
    vi.stubEnv('COMMANDO_SLIDES_CLI', cli); vi.stubEnv('COMMANDO_CHROMIUM_PATH', process.execPath)
    const result = await request('deck-export', { deck: 'deck.html', format, theme: 'paper' })
    expect(result.status).toBe(200); expect(result.text).toBe('exported')
    expect(result.headers['Content-Disposition']).toBe(`attachment; filename="deck-title.${format}"`)
    const args: string[] = JSON.parse(await readFile(captured, 'utf8'))
    expect(args).toEqual(deckExportArgs(format, await realpath(join(dir, 'deck.html')), args[4], process.execPath, 'paper'))
    await expect(readFile(args[4])).rejects.toThrow()
  })
})

import { isDeckPath, parseDeck } from '../shared/deck.js'
import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync, createReadStream, readFileSync, readdirSync } from 'node:fs'
import { copyFile, constants as fsConstants, mkdtemp, rm, stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { canvasRelativePath, encodeCanvasPath } from '../shared/canvas-manifest.js'
import { findChromiumBinary } from './chromium-engine.js'
import { RedlineArtifactError, type RedlineArtifactRegistry } from './redline-artifacts.js'

const fail = (status: number, message: string): never => { throw new RedlineArtifactError(status, message) }
export function resolveDeck(artifacts: RedlineArtifactRegistry, id: string, value: unknown) {
  const path = canvasRelativePath(value)
  if (!path || !isDeckPath(path)) return fail(400, 'deck must be a relative HTML path inside the artifact folder')
  const file = artifacts.resolve(id, encodeCanvasPath(path))
  if (!file) return fail(404, 'Deck not found')
  return { path, file, parsed: parseDeck(readFileSync(file, 'utf8'), path) }
}
export function deckThemes(artifacts: RedlineArtifactRegistry, id: string, deck: unknown) {
  const { path, file, parsed } = resolveDeck(artifacts, id, deck)
  let themes: string[] = []
  try {
    themes = readdirSync(join(dirname(file), 'themes')).flatMap((name) => {
      const match = /^([a-z0-9-]{1,40})\.css$/.exec(name)
      return match && artifacts.resolve(id, encodeCanvasPath(posix.join(posix.dirname(path), 'themes', name))) ? [match[1]] : []
    }).sort()
  } catch { /* A deck can use only its default stylesheet. */ }
  return { themes, default: parsed.deck.theme }
}
export function findSlidesCli(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.COMMANDO_SLIDES_CLI) return existsSync(env.COMMANDO_SLIDES_CLI) ? env.COMMANDO_SLIDES_CLI : null
  return ['.claude', '.claudep', '.claudew', '.codex', '.agents'].map((profile) => join(homedir(), profile, 'skills/slides/bin/slides.mjs')).find(existsSync) ?? null
}
export function deckExportArgs(format: string, deck: string, out: string, browser: string, theme?: string): string[] {
  return [format, deck, '--json', '--out', out, '--browser', browser, ...(theme ? ['--theme', theme] : [])]
}
export function deckExportFailure(error: Pick<ExecFileException, 'code' | 'killed' | 'signal'>, stdout: string, stderr: string): string {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Slide export failed: CLI output exceeded the 1 MiB buffer limit'
  if (error.killed && error.signal) return 'Slide export timed out after 120 seconds'
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const result: unknown = JSON.parse(line)
      if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string') return result.error
      break
    } catch { /* CLI diagnostics can surround its final JSON line. */ }
  }
  return stderr.trim().split(/\r?\n/).at(-1)?.trim() || 'Slide export failed. Check the slides CLI installation and deck assets.'
}
let activeExports = 0
/** Where `save: 'downloads'` exports land; the desktop app can't save browser downloads. */
export const downloadsDir = (env: NodeJS.ProcessEnv = process.env): string => env.COMMANDO_DOWNLOADS_DIR || join(homedir(), 'Downloads')
/** Paths this daemon saved, so reveal can't be pointed at arbitrary files. */
const savedExports = new Set<string>()
/** Copies without overwriting: `name.pdf`, then `name (2).pdf`, like a browser download. */
export async function saveWithoutOverwrite(source: string, dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.'), stem = name.slice(0, dot), ext = name.slice(dot)
  for (let n = 1; n <= 999; n++) {
    const target = join(dir, n === 1 ? name : `${stem} (${n})${ext}`)
    try { await copyFile(source, target, fsConstants.COPYFILE_EXCL); return target } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  return fail(409, `Too many exports named ${name} in ${dir}`)
}
export function revealSavedExport(path: unknown): Promise<void> {
  if (typeof path !== 'string' || !savedExports.has(path)) return Promise.reject(new RedlineArtifactError(404, 'Not a slide export saved by Commando'))
  if (process.platform !== 'darwin') return Promise.reject(new RedlineArtifactError(501, 'Show in Finder is only available on macOS'))
  return new Promise((resolve, reject) => execFile('/usr/bin/open', ['-R', path], (error) => error ? reject(new RedlineArtifactError(500, 'Could not show the file in Finder')) : resolve()))
}
const mime = { pdf: 'application/pdf', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', png: 'image/png', html: 'text/html; charset=utf-8' }
export async function exportDeck(artifacts: RedlineArtifactRegistry, id: string, body: Record<string, unknown>, response: ServerResponse): Promise<void> {
  const { file, parsed } = resolveDeck(artifacts, id, body.deck)
  if (body.theme !== undefined && (typeof body.theme !== 'string' || !/^[a-z0-9-]{1,40}$/.test(body.theme))) return fail(400, 'Invalid theme; expected 1–40 lowercase letters, digits or hyphens')
  if (body.save !== undefined && body.save !== 'downloads') return fail(400, "save must be 'downloads'")
  if (body.format !== 'pdf' && body.format !== 'pptx' && body.format !== 'png' && body.format !== 'html') return fail(400, 'format must be pdf, pptx, png or html')
  const format = body.format
  const slide = body.slide === undefined ? parsed.deck.slides[0]?.id : body.slide
  const slideIndex = parsed.deck.slides.findIndex((entry) => entry.id === slide)
  if ((body.slide !== undefined || format === 'png') && (typeof slide !== 'string' || slideIndex < 0)) return fail(400, 'Unknown slide id')
  const cli = findSlidesCli(), browser = findChromiumBinary()
  if (!cli) return fail(503, 'Slides CLI is missing. Install the portable slides skill and run npm install in its folder, or set COMMANDO_SLIDES_CLI.')
  if (!browser) return fail(503, 'Chromium is missing. Install Chromium or set COMMANDO_CHROMIUM_PATH.')
  if (activeExports >= 2) return fail(503, 'Two slide exports are already running. Try again shortly.')
  ++activeExports
  let temp: string | undefined
  try {
    temp = await mkdtemp(join(tmpdir(), 'commando-deck-export-'))
    const out = format === 'png' ? temp : join(temp, `deck.${format}`)
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [cli, ...deckExportArgs(format, file, out, browser, body.theme as string | undefined)], { timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new RedlineArtifactError(503, deckExportFailure(error, stdout, stderr)))
        else resolve(stdout)
      })
    })
    let result: { ok?: boolean; error?: unknown; files?: unknown }
    try { result = JSON.parse(stdout.trim()) as typeof result; if (!result || typeof result !== 'object') throw new Error() }
    catch { return fail(503, 'Slides CLI returned invalid JSON') }
    if (result.ok === false || result.error) return fail(503, typeof result.error === 'string' ? result.error : 'Slide export failed')
    let output = out
    if (format === 'png') {
      const filename = `${String(slideIndex + 1).padStart(2, '0')}-${slide}.png`
      if (!Array.isArray(result.files) || !result.files.some((file) => typeof file === 'string' && basename(file) === filename)) return fail(503, 'Slides CLI did not return the requested slide PNG')
      // Only read the named slide inside our output directory, never a path outside it from CLI output.
      output = join(out, filename)
    }
    const info = await stat(output).catch(() => null)
    if (!info?.isFile()) return fail(503, 'Slides CLI did not produce the exported file')
    const slug = parsed.deck.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'slides'
    const filename = `${slug}${format === 'png' ? `-${slide}` : ''}.${format}`
    if (body.save === 'downloads') {
      const saved = await saveWithoutOverwrite(output, downloadsDir(), filename)
      savedExports.add(saved)
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ ok: true, path: saved, name: basename(saved) }))
      return
    }
    response.writeHead(200, { 'Content-Type': mime[format], 'Content-Length': info.size, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    await pipeline(createReadStream(output), response)
  } finally { --activeExports; if (temp) await rm(temp, { recursive: true, force: true }) }
}

import { execFile } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { safeAuthUrl } from '../shared/chat-mcp.js'

const OPEN_TIMEOUT_MS = 3_000
const OPEN_BUFFER_BYTES = 64 * 1024
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u

export function validResourcePath(path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) && Buffer.byteLength(path, 'utf8') <= 4096 && !CONTROL_CHARACTER.test(path)
}

export type FolderOpenExecutor = (
  file: string,
  args: readonly string[],
  options: {
    encoding: BufferEncoding
    maxBuffer: number
    shell: false
    timeout: number
    windowsHide: boolean
  },
) => Promise<void>

const defaultExecutor: FolderOpenExecutor = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(error.killed ? 'Opening the folder timed out' : stderr.trim() || 'Unable to open the folder'))
        return
      }
      resolve()
    })
  })

export async function openFolderInFinder(
  path: string,
  execute: FolderOpenExecutor = defaultExecutor,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') throw new Error('Opening folders in Finder is only available on macOS')
  if (!validResourcePath(path)) {
    throw new Error('Pane path must be an absolute folder path without control characters')
  }
  await execute('/usr/bin/open', [path], {
    encoding: 'utf8',
    maxBuffer: OPEN_BUFFER_BYTES,
    shell: false,
    timeout: OPEN_TIMEOUT_MS,
    windowsHide: true,
  })
}

export async function revealInFinder(
  file: string,
  execute: FolderOpenExecutor = defaultExecutor,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') throw new Error('Revealing files in Finder is only available on macOS')
  if (!validResourcePath(file)) {
    throw new Error('File path must be absolute and contain no control characters')
  }
  await execute('/usr/bin/open', ['-R', file], {
    encoding: 'utf8',
    maxBuffer: OPEN_BUFFER_BYTES,
    shell: false,
    timeout: OPEN_TIMEOUT_MS,
    windowsHide: true,
  })
}

/** Opens a web page in the Mac's default browser; only http(s) URLs. */
export async function openUrlInBrowser(
  url: string,
  execute: FolderOpenExecutor = defaultExecutor,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') throw new Error('Opening pages in the browser is only available on macOS')
  const page = safeAuthUrl(url)
  if (!page) throw new Error('Only web pages can be opened in the browser')
  await execute('/usr/bin/open', [page], {
    encoding: 'utf8',
    maxBuffer: OPEN_BUFFER_BYTES,
    shell: false,
    timeout: OPEN_TIMEOUT_MS,
    windowsHide: true,
  })
}

const SAFE_DOCUMENTS = new Set('png jpg jpeg gif webp svg avif bmp tif tiff ico heic pdf txt md json csv log html htm mp4 mov mp3 wav xml yaml yml'.split(' '))
const UNSAFE_PACKAGES = /\.(?:app|command|sh|tool|terminal|workflow|scpt|pkg|dmg)$/i

async function openArguments(args: string[], execute: FolderOpenExecutor, platform: NodeJS.Platform): Promise<void> {
  if (platform !== 'darwin') throw new Error('Resource actions are only available on macOS')
  await execute('/usr/bin/open', args, {
    encoding: 'utf8', maxBuffer: OPEN_BUFFER_BYTES, shell: false, timeout: OPEN_TIMEOUT_MS, windowsHide: true,
  })
}

/** Even a document extension cannot make an executable file safe to open. */
export async function openResource(path: string, execute: FolderOpenExecutor = defaultExecutor, platform: NodeJS.Platform = process.platform): Promise<'open' | 'reveal'> {
  if (!validResourcePath(path)) throw new Error('File path must be absolute and contain no control characters')
  const stats = await stat(path)
  const safe = !UNSAFE_PACKAGES.test(path) && (stats.isDirectory() ||
    (stats.isFile() && !(stats.mode & 0o111) && SAFE_DOCUMENTS.has(extname(path).slice(1).toLowerCase())))
  if (!safe) { await revealInFinder(path, execute, platform); return 'reveal' }
  if (stats.isDirectory()) await openFolderInFinder(path, execute, platform)
  else await openArguments([path], execute, platform)
  return 'open'
}

/** The editor choice is made on this Mac, with no shell or editor CLI involved. */
export async function openResourceInEditor(
  path: string,
  line?: number,
  execute: FolderOpenExecutor = defaultExecutor,
  platform: NodeJS.Platform = process.platform,
  override = process.env.COMMANDO_EDITOR_APP,
  installed: (app: string) => Promise<boolean> = async (app) => { try { await access(app); return true } catch { return false } },
): Promise<void> {
  if (!validResourcePath(path)) throw new Error('File path must be absolute and contain no control characters')
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new Error('line must be a positive integer')
  if (!(await stat(path)).isFile()) throw new Error('Only files can be opened in an editor')
  let app: string | undefined
  if (override) {
    if (!validResourcePath(override) || !override.endsWith('.app')) throw new Error('COMMANDO_EDITOR_APP must be an absolute .app path')
    app = override
  } else {
    for (const candidate of ['/Applications/Cursor.app', '/Applications/Visual Studio Code.app', '/Applications/Zed.app']) {
      if (await installed(candidate)) { app = candidate; break }
    }
  }
  const scheme = app?.endsWith('/Cursor.app') ? 'cursor' : app?.endsWith('/Visual Studio Code.app') ? 'vscode' : undefined
  const args = line && scheme ? [`${scheme}://file${path.split('/').map(encodeURIComponent).join('/')}:${line}`]
    : app ? ['-a', app, path] : ['-t', path]
  await openArguments(args, execute, platform)
}

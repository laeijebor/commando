import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RedlineArtifactError, type RedlineArtifactRegistry } from './redline-artifacts.js'

const require_ = createRequire(import.meta.url)
const staticDir = join(dirname(fileURLToPath(import.meta.url)), 'static')

const MAX_REQUEST_BYTES = 16 * 1024
const ARTIFACT_ID = /^[0-9a-f]{16}$/

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function packageRoot(name: string): string {
  return dirname(require_.resolve(`${name}/package.json`))
}

/** Static design-kit files served from node_modules — resolved lazily and cached. */
const designFiles: Record<string, () => string> = {
  'tailwind.js': () => join(packageRoot('@tailwindcss/browser'), 'dist', 'index.global.js'),
  'daisyui.css': () => join(packageRoot('daisyui'), 'daisyui.css'),
  'daisyui-themes.css': () => join(packageRoot('daisyui'), 'themes.css'),
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization
  if (!authorization) return null
  return /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] ?? null
}

export function isRedlinePath(pathname: string): boolean {
  return pathname === '/redline' || pathname.startsWith('/redline/') ||
    pathname === '/api/redline' || pathname.startsWith('/api/redline/')
}

type RedlineApiDependencies = {
  /** The agent hook token — same secret agents use for the web-panes API. */
  agentToken: string
  ownerAuthorized: (request: IncomingMessage, url: URL) => Promise<boolean>
  artifacts: RedlineArtifactRegistry
  /** Origin artifacts are reachable at, e.g. http://127.0.0.1:4310 */
  baseUrl: string
}

/**
 * Redline routes. `/redline/*` is unauthenticated read-only static serving
 * (the daemon is loopback/tailscale-gated upstream and the content is the
 * user's own artifacts plus public npm assets); `/api/redline/*` mutations
 * require the agent token or owner auth.
 */
export class RedlineApi {
  private readonly agentTokenDigest: Buffer
  private readonly fileCache = new Map<string, Buffer>()

  constructor(private readonly dependencies: RedlineApiDependencies) {
    if (dependencies.agentToken.length < 32) {
      throw new Error('Agent hook token must contain at least 32 characters')
    }
    this.agentTokenDigest = digest(dependencies.agentToken)
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!isRedlinePath(url.pathname)) return false
    try {
      if (url.pathname.startsWith('/api/redline')) {
        await this.handleApi(request, response, url)
        return true
      }
      this.handleStatic(request, response, url.pathname)
      return true
    } catch (error) {
      if (error instanceof HttpError || error instanceof RedlineArtifactError) {
        if (error.status === 401) response.setHeader('WWW-Authenticate', 'Bearer realm="commando"')
        if (error.status === 405) {
          response.setHeader('Allow', url.pathname.startsWith('/api/redline') ? 'POST, DELETE' : 'GET')
        }
        this.writeJson(response, error.status, { error: error.message })
        return true
      }
      this.writeJson(response, 500, { error: 'Redline request failed' })
      return true
    }
  }

  private handleStatic(request: IncomingMessage, response: ServerResponse, pathname: string): void {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
    if (pathname === '/redline/sdk.js') {
      this.serveFile(response, join(staticDir, 'redline-sdk.js'))
      return
    }
    const design = /^\/redline\/design\/([^/]+)$/.exec(pathname)
    if (design && designFiles[design[1]]) {
      this.serveFile(response, designFiles[design[1]]())
      return
    }
    const mermaid = /^\/redline\/design\/mermaid\/(.+)$/.exec(pathname)
    if (mermaid) {
      this.serveTreeFile(response, join(packageRoot('mermaid'), 'dist'), mermaid[1])
      return
    }
    const artifact = /^\/redline\/artifacts\/([0-9a-f]{16})\/(.*)$/.exec(pathname)
    if (artifact) {
      const file = this.dependencies.artifacts.resolve(artifact[1], artifact[2])
      if (!file) throw new HttpError(404, 'Not found')
      // Artifacts change during a review loop — never cache them.
      this.serveFile(response, file, { cache: 'no-store', cached: false })
      return
    }
    throw new HttpError(404, 'Not found')
  }

  /** Serves a file strictly under a root directory (for mermaid's chunk tree). */
  private serveTreeFile(response: ServerResponse, root: string, requestPath: string): void {
    let decoded: string
    try {
      decoded = decodeURIComponent(requestPath)
    } catch {
      throw new HttpError(404, 'Not found')
    }
    const normalized = normalize(decoded)
    if (normalized.includes('\0') || normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith(sep)) {
      throw new HttpError(404, 'Not found')
    }
    this.serveFile(response, join(root, normalized))
  }

  private serveFile(
    response: ServerResponse,
    filePath: string,
    options: { cache?: string; cached?: boolean } = {},
  ): void {
    const cached = options.cached ?? true
    let body = cached ? this.fileCache.get(filePath) : undefined
    if (!body) {
      try {
        body = readFileSync(filePath)
      } catch {
        throw new HttpError(404, 'Not found')
      }
      if (cached) this.fileCache.set(filePath, body)
    }
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': options.cache ?? 'public, max-age=300',
      'Content-Length': body.length,
      'Content-Type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    await this.authenticate(request, url)
    if (url.pathname === '/api/redline/artifacts') {
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      const body = await this.readJson(request)
      if (typeof body.dir !== 'string') throw new HttpError(400, 'dir must be a string')
      const { id } = this.dependencies.artifacts.register(body.dir)
      this.writeJson(response, 201, {
        ok: true,
        id,
        url: `${this.dependencies.baseUrl}/redline/artifacts/${id}/`,
      })
      return
    }
    const single = /^\/api\/redline\/artifacts\/([0-9a-f]{16})$/.exec(url.pathname)
    if (single && ARTIFACT_ID.test(single[1])) {
      if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed')
      if (!this.dependencies.artifacts.unregister(single[1])) throw new HttpError(404, 'Not found')
      this.writeJson(response, 200, { ok: true })
      return
    }
    throw new HttpError(404, 'Not found')
  }

  private async authenticate(request: IncomingMessage, url: URL): Promise<void> {
    if (await this.dependencies.ownerAuthorized(request, url)) return
    const candidate = bearerToken(request)
    if (
      candidate !== null && candidate.length <= 1_024 &&
      timingSafeEqual(digest(candidate), this.agentTokenDigest)
    ) {
      return
    }
    throw new HttpError(401, 'Unauthorized')
  }

  private writeJson(response: ServerResponse, status: number, value: unknown): void {
    const body = `${JSON.stringify(value)}\n`
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json')
    const chunks: Buffer[] = []
    let byteLength = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteLength += buffer.length
      if (byteLength > MAX_REQUEST_BYTES) throw new HttpError(413, 'Request body is too large')
      chunks.push(buffer)
    }
    if (byteLength === 0) throw new HttpError(400, 'Request body is required')
    let value: unknown
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new HttpError(400, 'Request body is not valid JSON')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new HttpError(400, 'Request body must be a JSON object')
    }
    return value as Record<string, unknown>
  }
}

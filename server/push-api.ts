import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ExpoPushOutcome } from './expo-push.js'
import {
  PushDeviceError,
  validatePushDeviceId,
  validatePushDeviceInput,
  type PushDevice,
  type PushDeviceRegistry,
} from './push-devices.js'

const API_ROOT = '/api/push'
const MAX_REQUEST_BYTES = 16 * 1024

export type PushApiDependencies = {
  registry: Pick<PushDeviceRegistry, 'list' | 'get' | 'upsert' | 'remove'>
  sendTest: (device: PushDevice) => Promise<ExpoPushOutcome>
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json')
  }
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

type PushRoute =
  | { kind: 'collection' }
  | { kind: 'device'; deviceId: string }
  | { kind: 'test'; deviceId: string }

function pushRoute(pathname: string): PushRoute | null {
  if (pathname === `${API_ROOT}/devices`) return { kind: 'collection' }
  const match = /^\/api\/push\/devices\/([^/]+)(?:\/(test))?$/.exec(pathname)
  if (!match) return null
  let deviceId: string
  try {
    deviceId = validatePushDeviceId(decodeURIComponent(match[1]))
  } catch {
    throw new HttpError(400, 'Invalid push device id')
  }
  return match[2] === 'test' ? { kind: 'test', deviceId } : { kind: 'device', deviceId }
}

/**
 * Owner-authenticated registration of Expo push devices. The owner-auth gate in
 * `server/index.ts` runs before this handler, so every route here is private.
 */
export class PushApi {
  constructor(private readonly dependencies: PushApiDependencies) {}

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== API_ROOT && !url.pathname.startsWith(`${API_ROOT}/`)) return false

    try {
      const route = pushRoute(url.pathname)
      if (!route) throw new HttpError(404, 'Not found')

      if (route.kind === 'collection') {
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')
        writeJson(response, 200, { devices: this.dependencies.registry.list() })
        return true
      }

      if (route.kind === 'test') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed')
        const device = this.dependencies.registry.get(route.deviceId)
        if (!device) throw new HttpError(404, 'Push device is not registered')
        const outcome = await this.dependencies.sendTest(device)
        writeJson(response, 202, {
          ok: outcome.accepted > 0,
          deviceId: device.id,
          accepted: outcome.accepted,
          rejected: outcome.rejected,
        })
        return true
      }

      if (request.method === 'PUT') {
        const body = await readJson(request)
        const device = await this.dependencies.registry.upsert(
          validatePushDeviceInput(route.deviceId, body),
        )
        writeJson(response, 200, { ok: true, device })
        return true
      }

      if (request.method === 'DELETE') {
        const removed = await this.dependencies.registry.remove(route.deviceId)
        if (!removed) throw new HttpError(404, 'Push device is not registered')
        writeJson(response, 200, { ok: true, deviceId: route.deviceId, removed })
        return true
      }

      throw new HttpError(405, 'Method not allowed')
    } catch (error) {
      if (error instanceof PushDeviceError) {
        writeJson(response, error.status, { error: error.message })
        return true
      }
      if (error instanceof HttpError) {
        if (error.status === 405) {
          response.setHeader(
            'Allow',
            url.pathname === `${API_ROOT}/devices`
              ? 'GET'
              : url.pathname.endsWith('/test') ? 'POST' : 'PUT, DELETE',
          )
        }
        writeJson(response, error.status, { error: error.message })
        return true
      }
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : 'Push device request failed',
      })
      return true
    }
  }
}

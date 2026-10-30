import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RemoteHost } from '../shared/hosts.js'
import { HostError, HostRegistry, publicHost, validateHostBaseUrl, validateHostName, validateHostToken } from './hosts.js'
import { HostsHealthMonitor } from './hosts-health.js'
import { hostFailure, hostJson } from './hosts-transport.js'

/** Owner session/daemon-token check only; excludes paired-device and hook tokens. */
export type HostAuthorization = (request: IncomingMessage, url: URL) => Promise<boolean>

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HostError(415, 'unsupported_media_type', 'Content-Type must be application/json')
  const limit = 16 * 1024
  if (Number(request.headers['content-length'] ?? 0) > limit) { request.resume(); throw new HostError(413, 'body_too_large', 'Request body exceeds 16 KiB') }
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', data); request.off('end', end); request.off('error', fail); request.off('aborted', aborted)
    }
    const fail = (error: Error) => { cleanup(); reject(error) }
    const aborted = () => fail(new HostError(400, 'invalid_json', 'Incomplete request body'))
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) { fail(new HostError(413, 'body_too_large', 'Request body exceeds 16 KiB')); request.resume() }
      else chunks.push(chunk)
    }
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')) }
    const timer = setTimeout(() => { fail(new HostError(400, 'invalid_json', 'Request body timed out')); request.resume() }, 10_000)
    timer.unref()
    request.on('data', data); request.once('end', end); request.once('error', fail); request.once('aborted', aborted)
  })
  let body: unknown
  try { body = JSON.parse(raw) } catch { throw new HostError(400, 'invalid_json', 'Invalid JSON body') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HostError(400, 'invalid_host', 'Expected a JSON object')
  return body as Record<string, unknown>
}

export class HostsApi {
  constructor(private readonly registry: HostRegistry, private readonly monitor: HostsHealthMonitor, private readonly ownerAuthorized: HostAuthorization) {}
  private host(id: string): RemoteHost {
    return { ...publicHost(this.registry.get(id)), health: this.monitor.health(id) }
  }
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/api/hosts' && !url.pathname.startsWith('/api/hosts/')) return false
    try {
      if (!(await this.ownerAuthorized(request, url))) throw new HostError(401, 'unauthorized', 'Owner authorization required')
      if (url.pathname === '/api/hosts') {
        if (request.method === 'GET') {
          hostJson(response, 200, { hosts: this.registry.list().map((host) => ({ ...host, health: this.monitor.health(host.id) })) })
        } else if (request.method === 'POST') {
          this.registry.list() // Fail closed before contacting a host if storage is corrupt.
          const body = await readBody(request)
          if (Object.keys(body).some((key) => !['name', 'baseUrl', 'token'].includes(key))) throw new HostError(400, 'invalid_host', 'Unexpected host field')
          const input = { name: validateHostName(body.name), baseUrl: validateHostBaseUrl(body.baseUrl), token: validateHostToken(body.token) }
          const health = await this.monitor.check({ ...input, id: '', addedAt: 0 })
          if (health.state !== 'online') throw new HostError(502, health.state === 'unauthorized' ? 'host_unauthorized' : 'host_unreachable', 'Remote host probe failed')
          const host = this.registry.add(input)
          this.monitor.record(host, health)
          hostJson(response, 201, { host: this.host(host.id) })
        } else throw new HostError(405, 'method_not_allowed', 'Use GET or POST')
        return true
      }
      const match = /^\/api\/hosts\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(url.pathname)
      if (!match) throw new HostError(404, 'not_found', 'Host route does not exist')
      const host = this.registry.get(match[1])
      if (request.method === 'DELETE') {
        this.registry.delete(host.id); this.monitor.remove(host.id)
        response.writeHead(204); response.end()
      } else if (request.method === 'PATCH') {
        const body = await readBody(request)
        const keys = Object.keys(body)
        if (!keys.length || keys.some((key) => !['name', 'token'].includes(key))) throw new HostError(400, 'invalid_host', 'Expected name and/or token')
        const input = { ...('name' in body ? { name: validateHostName(body.name) } : {}), ...('token' in body ? { token: validateHostToken(body.token) } : {}) }
        const health = input.token === undefined ? undefined : await this.monitor.check({ ...host, ...input })
        if (health && health.state !== 'online') throw new HostError(502, health.state === 'unauthorized' ? 'host_unauthorized' : 'host_unreachable', 'Remote host probe failed')
        const updated = this.registry.update(host.id, input, host)
        if (health) this.monitor.record(updated, health)
        hostJson(response, 200, { host: this.host(host.id) })
      } else throw new HostError(405, 'method_not_allowed', 'Use PATCH or DELETE')
    } catch (error) { hostFailure(response, error) }
    return true
  }
}

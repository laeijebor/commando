import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import {
  isDiscoveredAgentProvider, isSafeExternalUrl, validCloudRemoteId,
  type CloudImportDiscoveredInput, type CloudImportDiscoveredResponse, type CloudLinkInput,
  type CloudProviderId, type CloudSource,
} from '../shared/cloud-tasks.js'
import type { CloudDiscoveryService } from './cloud-discovery.js'
import { CloudTaskError } from './cloud-provider.js'
import type { CloudTaskService } from './cloud-task-service.js'

const MAX_BODY_BYTES = 64 * 1024
const ROOTS = ['/api/cloud-providers', '/api/cloud-tasks', '/api/cloud-operations', '/api/cloud']
const IMPORT_ALLOWED_KEYS = ['provider', 'id', 'title', 'repo', 'branch', 'cwd', 'url', 'credentialContextId', 'accountConfirmed'] as const
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

async function readBody(request: IncomingMessage, optional = false): Promise<unknown> {
  if (optional && !request.headers['transfer-encoding'] && (!request.headers['content-length'] || request.headers['content-length'] === '0')) return {}
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new CloudTaskError(415, 'invalid_request', 'Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY_BYTES) throw new CloudTaskError(413, 'invalid_request', 'Request body is too large')
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new CloudTaskError(400, 'invalid_request', 'Request body is not valid JSON') }
}

function idempotencyKey(request: IncomingMessage): string {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string') throw new CloudTaskError(400, 'invalid_request', 'Idempotency-Key is required')
  return key
}

function optionalField(record: Record<string, unknown>, key: string, maxLength = 256): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxLength || CONTROL_CHARS.test(value)) {
    throw new CloudTaskError(400, 'invalid_request', `Invalid ${key}`)
  }
  return value.trim()
}

function parseImportDiscoveredInput(body: unknown): CloudImportDiscoveredInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CloudTaskError(400, 'invalid_request', 'Expected an object')
  }
  const record = body as Record<string, unknown>
  if (Object.keys(record).some((key) => !(IMPORT_ALLOWED_KEYS as readonly string[]).includes(key))) {
    throw new CloudTaskError(400, 'invalid_request', 'Unexpected request field')
  }
  if (!isDiscoveredAgentProvider(record.provider)) {
    throw new CloudTaskError(400, 'invalid_request', 'Invalid provider')
  }
  const id = optionalField(record, 'id', 160)
  if (!id || /\s/.test(id)) {
    throw new CloudTaskError(400, 'invalid_request', 'A valid agent ID is required')
  }
  const title = optionalField(record, 'title', 256)
  const repo = optionalField(record, 'repo', 256)
  const branch = optionalField(record, 'branch', 256)
  const cwd = optionalField(record, 'cwd', 4096)
  const url = optionalField(record, 'url', 2048)
  if (url !== undefined && !isSafeExternalUrl(url)) {
    throw new CloudTaskError(400, 'invalid_request', 'Invalid agent URL')
  }
  const credentialContextId = optionalField(record, 'credentialContextId', 256)
  if (record.accountConfirmed !== undefined && typeof record.accountConfirmed !== 'boolean') {
    throw new CloudTaskError(400, 'invalid_request', 'accountConfirmed must be a boolean')
  }
  return {
    provider: record.provider,
    id,
    ...(title ? { title } : {}),
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
    ...(cwd ? { cwd } : {}),
    ...(url ? { url } : {}),
    ...(credentialContextId ? { credentialContextId } : {}),
    ...(typeof record.accountConfirmed === 'boolean' ? { accountConfirmed: record.accountConfirmed } : {}),
  }
}

function buildSafeLinkSource(input: CloudImportDiscoveredInput): CloudSource | undefined {
  const source: CloudSource = {}
  if (input.repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) {
    source.repository = input.repo
  }
  if (input.branch && !input.branch.startsWith('-') && !/[\s~^:?*\[\\]/.test(input.branch) && !input.branch.includes('..') && !input.branch.includes('@{')) {
    source.branch = input.branch
  }
  if (input.cwd && isAbsolute(input.cwd)) {
    source.checkoutPath = input.cwd
  }
  return Object.keys(source).length ? source : undefined
}

async function resolveImportContext(service: CloudTaskService, provider: CloudProviderId, requested?: string): Promise<string> {
  if (requested) return requested
  const { providers } = await service.listProviders()
  const matching = providers.filter((entry) => entry.id === provider && entry.capabilities.link)
  const chosen = matching.find((entry) => entry.readiness === 'ready') ?? matching[0]
  if (!chosen) {
    throw new CloudTaskError(409, 'provider_unavailable', `No configured ${provider} connection is available to link this agent.`)
  }
  return chosen.credentialContextId
}

async function handleImportDiscovered(
  request: IncomingMessage,
  response: ServerResponse,
  service: CloudTaskService,
): Promise<void> {
  const input = parseImportDiscoveredInput(await readBody(request))
  if (input.provider === 'cursor') {
    const payload: CloudImportDiscoveredResponse = {
      kind: 'chat',
      launch: {
        provider: 'cursor-chat',
        resume: input.id,
        title: input.title ?? input.id,
        ...(input.cwd && isAbsolute(input.cwd) ? { cwd: input.cwd } : {}),
        ...(input.url ? { url: input.url } : {}),
      },
    }
    json(response, 200, payload)
    return
  }
  if (!validCloudRemoteId(input.provider, input.id)) {
    throw new CloudTaskError(400, 'invalid_request', 'Agent ID is not a recognized cloud task or session ID')
  }
  const credentialContextId = await resolveImportContext(service, input.provider, input.credentialContextId)
  const source = buildSafeLinkSource(input)
  const linkPayload: CloudLinkInput = {
    provider: input.provider,
    credentialContextId,
    providerTaskId: input.id,
    accountConfirmed: input.accountConfirmed ?? true,
    ...(input.title ? { title: input.title } : {}),
    ...(source ? { source } : {}),
  }
  const headerKey = request.headers['idempotency-key']
  const key = typeof headerKey === 'string' ? headerKey : randomUUID()
  const action = await service.linkTask(linkPayload, key)
  const payload: CloudImportDiscoveredResponse = { kind: 'linked', ...action }
  json(response, 202, payload)
}

/** Register only AFTER the daemon's requestIsAuthorized gate. This is routing, not authentication. */
export async function handleCloudTasksApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: CloudTaskService,
  discovery?: CloudDiscoveryService,
): Promise<boolean> {
  const root = ROOTS.find((candidate) => url.pathname === candidate || url.pathname.startsWith(`${candidate}/`))
  if (!root) return false
  try {
    if (url.pathname.length > 1024 || url.search.length > 1024) throw new CloudTaskError(400, 'invalid_request', 'Route is too long')
    let path: string[]
    try { path = url.pathname.slice(root.length).split('/').filter(Boolean).map(decodeURIComponent) }
    catch { throw new CloudTaskError(400, 'invalid_request', 'Invalid route encoding') }
    const method = request.method
    const allow = (...methods: string[]): boolean => {
      if (methods.includes(method ?? '')) return true
      response.setHeader('Allow', methods.join(', '))
      json(response, 405, { error: 'Method not allowed' })
      return false
    }
    const queryKeys = root === '/api/cloud-tasks' && path.length === 0 && method === 'GET' ? ['includeArchived'] : []
    if ([...url.searchParams.keys()].some((key) => !queryKeys.includes(key)) || [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) {
      throw new CloudTaskError(400, 'invalid_request', 'Unexpected query parameter')
    }
    if (root === '/api/cloud') {
      if (path.length === 1 && path[0] === 'discovered') {
        if (allow('GET')) {
          if (!discovery) throw new CloudTaskError(503, 'discovery_unavailable', 'Cloud agent discovery is unavailable.')
          json(response, 200, await discovery.discover())
        }
        return true
      }
      if (path.length === 2 && path[0] === 'discovered' && path[1] === 'import') {
        if (allow('POST')) await handleImportDiscovered(request, response, service)
        return true
      }
    }
    if (root === '/api/cloud-providers' && path.length === 0) {
      if (allow('GET')) json(response, 200, await service.listProviders())
      return true
    }
    if (root === '/api/cloud-operations') {
      if (path.length === 2 && path[0] === 'by-key') {
        if (allow('GET')) json(response, 200, { operation: service.getOperationByKey(path[1]) })
        return true
      }
      if (path.length === 2 && path[1] === 'dispatch') {
        if (allow('POST')) json(response, 202, await service.resumeOperation(path[0], await readBody(request)))
        return true
      }
      if (path.length === 1) {
        if (allow('GET')) json(response, 200, { operation: service.getOperation(path[0]) })
        return true
      }
    }
    if (root === '/api/cloud-tasks') {
      if (path.length === 0) {
        if (!allow('GET', 'POST')) return true
        if (method === 'GET') {
          const archived = url.searchParams.get('includeArchived')
          if (archived !== null && archived !== '1' && archived !== '0') throw new CloudTaskError(400, 'invalid_request', 'includeArchived must be 0 or 1')
          json(response, 200, { tasks: service.listTasks(archived !== '0') })
        } else {
          const key = idempotencyKey(request)
          json(response, 202, await service.createTask(await readBody(request), key))
        }
        return true
      }
      if (path.length === 1 && path[0] === 'link') {
        if (allow('POST')) {
          const key = idempotencyKey(request)
          json(response, 202, await service.linkTask(await readBody(request), key))
        }
        return true
      }
      if (path.length === 1) {
        if (!allow('GET', 'PATCH')) return true
        json(response, 200, method === 'GET' ? service.getTask(path[0]) : service.updateTask(path[0], await readBody(request)))
        return true
      }
      if (path.length === 2) {
        const [id, action] = path
        if (action === 'diff') {
          if (allow('GET')) json(response, 200, await service.getDiff(id))
          return true
        }
        if (action === 'refresh') {
          if (allow('POST')) {
            const body = await readBody(request, true)
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new CloudTaskError(400, 'invalid_request', 'Refresh does not accept fields')
            json(response, 200, await service.refreshTask(id))
          }
          return true
        }
        if (action === 'link' || action === 'messages') {
          if (allow('POST')) {
            const key = idempotencyKey(request)
            const body = await readBody(request)
            json(response, 202, action === 'link' ? await service.linkTask(body, key, id) : await service.sendMessage(id, body, key))
          }
          return true
        }
      }
    }
    json(response, 404, { error: 'Not found' })
  } catch (error) {
    if (error instanceof CloudTaskError) json(response, error.status, { error: error.message, code: error.code })
    else json(response, 500, { error: 'Cloud task request failed', code: 'internal_error' })
  }
  return true
}

import type { AuthBootstrap, Host, HostReachability } from './types'

/**
 * React Native's fetch never sends an `Origin` header, which is exactly what
 * the daemon's origin check wants from a native client — so nothing here adds
 * one. Session cookies are held by the platform cookie jar; token hosts send
 * `Authorization: Bearer` instead.
 */
export function authHeaders(host: Host): Record<string, string> {
  return host.auth.kind === 'token' ? { Authorization: `Bearer ${host.auth.token}` } : {}
}

export type DaemonFetchInit = {
  method?: string
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8_000

export class DaemonHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'DaemonHttpError'
    this.status = status
  }
}

export async function daemonFetch(
  host: Host,
  path: string,
  init: DaemonFetchInit = {},
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (init.signal) {
    init.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders(host) }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    return await fetch(`${host.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'include',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const parsed: unknown = await response.json()
    if (parsed && typeof parsed === 'object') {
      const message = (parsed as { message?: unknown; error?: unknown })
      if (typeof message.message === 'string' && message.message) return message.message
      if (typeof message.error === 'string' && message.error) return message.error
    }
  } catch {
    // Fall through to the generic message.
  }
  return fallback
}

/** `GET /api/auth/bootstrap` — unauthenticated, tells us if email auth is on. */
export async function fetchAuthBootstrap(host: Host): Promise<AuthBootstrap> {
  const response = await daemonFetch(host, '/api/auth/bootstrap')
  if (!response.ok) {
    throw new DaemonHttpError(
      response.status,
      await readError(response, `Bootstrap failed (${response.status})`),
    )
  }
  const parsed: unknown = await response.json()
  const record = (parsed ?? {}) as Partial<AuthBootstrap>
  return {
    enabled: record.enabled === true,
    needsOwner: record.needsOwner === true,
    ownerEmail: typeof record.ownerEmail === 'string' ? record.ownerEmail : null,
  }
}

export type SignInResult = {
  /** Raw `set-cookie` value, kept so the WebSocket can replay it if needed. */
  cookie: string | null
}

/**
 * Better Auth's standard email sign-in. The daemon answers with an HttpOnly
 * session cookie; RN's fetch stores it in the native cookie jar, so later
 * `daemonFetch` calls are authenticated with no extra work. The raw header is
 * still returned because `WebSocket` on iOS does not always share that jar.
 */
export async function signInWithEmail(
  host: Host,
  email: string,
  password: string,
): Promise<SignInResult> {
  const response = await daemonFetch(host, '/api/auth/sign-in/email', {
    method: 'POST',
    body: { email, password, rememberMe: true },
  })
  if (!response.ok) {
    throw new DaemonHttpError(
      response.status,
      await readError(response, response.status === 401 ? 'Wrong email or password' : `Sign in failed (${response.status})`),
    )
  }
  const cookie = typeof response.headers.get === 'function' ? response.headers.get('set-cookie') : null
  return { cookie }
}

/** `GET /api/health` doubles as the reachability and authorisation probe. */
export async function probeHost(host: Host): Promise<HostReachability> {
  try {
    const response = await daemonFetch(host, '/api/health', { timeoutMs: 5_000 })
    if (response.status === 401 || response.status === 403) {
      return { state: 'unauthorized', checkedAt: Date.now(), message: 'Sign in required' }
    }
    if (!response.ok) {
      return {
        state: 'offline',
        checkedAt: Date.now(),
        message: `Daemon answered ${response.status}`,
      }
    }
    const parsed: unknown = await response.json()
    const sessions = (parsed as { sessions?: unknown }).sessions
    return {
      state: 'online',
      checkedAt: Date.now(),
      sessions: typeof sessions === 'number' ? sessions : undefined,
    }
  } catch (error) {
    return {
      state: 'offline',
      checkedAt: Date.now(),
      message: error instanceof Error ? error.message : 'Unreachable',
    }
  }
}

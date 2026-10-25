import type {
  CloudCreateInput, CloudDiff, CloudLinkInput, CloudMessageInput, CloudOperation,
  CloudProvidersResponse, CloudResumeInput, CloudTask, CloudTaskAction, CloudTaskDetail, CloudTaskSummary,
} from '../shared/cloud-tasks'

export type CloudTaskPatch = Partial<Pick<CloudTask, 'title' | 'archivedAt'>>

export interface CloudTasksApi {
  providers(): Promise<CloudProvidersResponse>
  list(): Promise<CloudTaskSummary[]>
  get(id: string): Promise<CloudTaskDetail>
  create(input: CloudCreateInput, key: string): Promise<CloudTaskAction>
  link(input: CloudLinkInput, key: string, taskId?: string): Promise<CloudTaskAction>
  message(id: string, input: CloudMessageInput, key: string): Promise<CloudTaskAction>
  refresh(id: string): Promise<CloudTaskDetail>
  diff(id: string): Promise<CloudDiff>
  patch(id: string, patch: CloudTaskPatch): Promise<CloudTaskDetail>
  operation(id: string): Promise<CloudOperation>
  byKey(key: string): Promise<CloudOperation | null>
  resumeOperation(id: string, input: CloudResumeInput): Promise<CloudTaskAction>
}

export class CloudTasksHttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
    this.name = 'CloudTasksHttpError'
  }

  /** Only for fresh create/link/message requests, never prepared-operation resumes. */
  rejectedBeforeRecord(kind: CloudOperation['kind']): boolean {
    // cloud-tasks-api.ts validates before calling the service; service input
    // validation precedes prepare(). Auth gates in index.ts have no error code.
    return ((this.status === 400 || this.status === 413 || this.status === 415) && this.code === 'invalid_request')
      || ((this.status === 401 || this.status === 403) && this.code === '')
      || (kind === 'message' && this.status === 404 && this.code === 'task_not_found')
  }
}

export function createCloudTasksApi(token: string, fetcher: typeof fetch = fetch): CloudTasksApi {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(`/api/${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null
      const error = new CloudTasksHttpError(response.status, typeof body?.code === 'string' ? body.code : '',
        `Cloud request failed (${response.status}). Check provider readiness and reconnect before retrying.`)
      // These are daemon-owned validation/auth messages. Keep arbitrary provider
      // diagnostics and other failures behind the generic message.
      if (error.rejectedBeforeRecord('message') && typeof body?.error === 'string') error.message = body.error
      throw error
    }
    return await response.json() as T
  }
  const taskPath = (id: string) => `cloud-tasks/${encodeURIComponent(id)}`
  const post = (input: unknown, key: string): RequestInit => ({
    method: 'POST', body: JSON.stringify(input), headers: { 'Idempotency-Key': key },
  })
  return {
    providers: () => request('cloud-providers'),
    list: async () => (await request<{ tasks: CloudTaskSummary[] }>('cloud-tasks')).tasks,
    get: (id) => request(taskPath(id)),
    create: (input, key) => request('cloud-tasks', post(input, key)),
    link: (input, key, id) => request(id ? `${taskPath(id)}/link` : 'cloud-tasks/link', post(input, key)),
    message: (id, input, key) => request(`${taskPath(id)}/messages`, post(input, key)),
    refresh: (id) => request(`${taskPath(id)}/refresh`, { method: 'POST' }),
    diff: (id) => request(`${taskPath(id)}/diff`),
    patch: (id, patch) => request(taskPath(id), { method: 'PATCH', body: JSON.stringify(patch) }),
    operation: async (id) => (await request<{ operation: CloudOperation }>(`cloud-operations/${encodeURIComponent(id)}`)).operation,
    resumeOperation: (id, input) => request(`cloud-operations/${encodeURIComponent(id)}/dispatch`, { method: 'POST', body: JSON.stringify(input) }),
    byKey: async (key) => {
      try {
        return (await request<{ operation: CloudOperation | null }>(`cloud-operations/by-key/${encodeURIComponent(key)}`)).operation
      } catch (error) {
        if (error instanceof CloudTasksHttpError && error.status === 404) return null
        throw error
      }
    },
  }
}

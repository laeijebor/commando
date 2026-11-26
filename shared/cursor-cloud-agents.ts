export const CURSOR_CLOUD_AGENTS_ROUTE = '/api/cursor-cloud-agents'

export type CursorCloudAgent = {
  agentId: string
  name: string
  environment?: string
  summary?: string
  repoUrl?: string
  createdAt?: number
  lastModified: number
  status?: 'running' | 'finished' | 'error' | 'cancelled'
  branch?: string
  prUrl?: string
  webUrl: string
  startedInCommando: boolean
  openPaneId?: string
}

export type CursorCloudAgentsResponse = {
  login: 'ok' | 'required'
  agents: CursorCloudAgent[]
  more: boolean
  error?: string
}

export const CURSOR_CLOUD_ENVIRONMENTS_ROUTE = '/api/cursor-cloud-environments'
export type CursorCloudEnvironment = { id: string; name: string; repoUrls: string[] }
export type CursorCloudEnvironmentsResponse = {
  login: 'ok' | 'required'
  environments: CursorCloudEnvironment[]
  error?: string
}

export function isCursorEnvironmentName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200
    && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

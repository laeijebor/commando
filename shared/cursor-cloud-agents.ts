export const CURSOR_CLOUD_AGENTS_ROUTE = '/api/cursor-cloud-agents'

export type CursorCloudAgent = {
  agentId: string
  name: string
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

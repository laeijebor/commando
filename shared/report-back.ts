export const REPORT_BACK_TASK_STATUSES = [
  'running',
  'waiting',
  'done',
  'failed',
  'blocked',
] as const

export type ReportBackTaskStatus = (typeof REPORT_BACK_TASK_STATUSES)[number]

export type ReportBackEventKind = 'update' | 'question' | 'status' | 'reply'

export type ReportBackEvent = {
  id: string
  taskId: string
  kind: ReportBackEventKind
  message: string
  status?: ReportBackTaskStatus
  questionId?: string
  createdAt: number
}

export type ReportBackTokenInfo = {
  tokenId: string
  taskId: string
  label?: string
  createdAt: number
  expiresAt?: number
  revokedAt?: number
  lastUsedAt?: number
}

export type ReportBackPendingQuestion = {
  id: string
  question: string
  createdAt: number
}

export type ReportBackTaskSnapshot = {
  taskId: string
  label?: string
  status: ReportBackTaskStatus
  summary?: string
  pendingQuestion?: ReportBackPendingQuestion
  events: ReportBackEvent[]
  updatedAt: number
}

export type ReportBackMessage = {
  id: string
  cursor: string
  taskId: string
  message: string
  questionId?: string
  createdAt: number
}

export type ReportBackReadMessagesResult = {
  messages: ReportBackMessage[]
  nextCursor: string
}

export type ReportBackFunnelStatus = {
  enabled: boolean
  url?: string
  error?: string
}

export type ReportBackListenerStatus = {
  enabled: boolean
  host?: string
  port?: number
  url?: string
}

export type ReportBackStatus = {
  listener: ReportBackListenerStatus
  funnel: ReportBackFunnelStatus
}

export type ReportBackMintTokenResponse = {
  token: string
  info: ReportBackTokenInfo
}

export function isReportBackTaskStatus(value: unknown): value is ReportBackTaskStatus {
  return typeof value === 'string' && (REPORT_BACK_TASK_STATUSES as readonly string[]).includes(value)
}
